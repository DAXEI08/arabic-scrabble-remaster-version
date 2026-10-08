// Procedural audio engine for Arabic Scrabble.
// Zero runtime MP3 dependencies: SFX and BGM are synthesized with Web Audio API.
// The music uses a subtle Hijaz-colored palette in equal temperament (D-Hijaz:
// D, Eb, F#, G, A, Bb, C), designed to stay calm and unobtrusive during play.
//
// Public API remains compatible with the existing game integration.
// No gameplay state or non-audio logic is imported here.

const STORAGE_KEY = 'scrabble.audio.v2';

const DEFAULT_PREFS = Object.freeze({
  muted: false,
  music: true,
  sfx: true,
  musicVolume: 0.35,
  sfxVolume: 0.70
});

const MUSIC = Object.freeze({
  bpm: 96,
  stepsPerBeat: 4,
  stepsPerBar: 16,
  lookahead: 0.18,
  schedulerMs: 50,
  fadeIn: 0.65,
  fadeOut: 0.14,
  duckLevel: 0.18
});

// D Hijaz in 12-TET: 1, b2, 3, 4, 5, b6, b7.
const HIJAZ = Object.freeze([
  293.66, 311.13, 369.99, 392.00,
  440.00, 466.16, 523.25, 587.33
]);

const SFX = Object.freeze({
  'button-click': {cooldown:55, priority:15},
  'tile-select':  {cooldown:65, priority:20},
  'tile-place':   {cooldown:45, priority:40},
  'tile-cancel':  {cooldown:75, priority:30},
  'word-submit':  {cooldown:100, priority:50},
  'invalid':      {cooldown:110, priority:25},
  'score':        {cooldown:95, priority:45},
  'tile-swap':    {cooldown:90, priority:35},
  'pass':         {cooldown:110, priority:25},
  'undo':         {cooldown:100, priority:30},
  'game-end':     {cooldown:180, priority:100}
});

const SFX_IDS = Object.freeze(Object.keys(SFX));

let audioContext = null;
let masterGain = null;
let musicGain = null;
let sfxGain = null;
let compressor = null;
let noiseBuffer = null;

let prefs = {...DEFAULT_PREFS};
let initialized = false;
let lifecycleBound = false;
let settingsBound = false;
let active = false;
let musicRunning = false;
let schedulerTimer = 0;
let nextMusicTime = 0;
let musicStep = 0;
let musicSession = 0;

let duckDepth = 0;
let ducked = false;

let schedulerBusy = false;
let playbackGestureBound = false;

const lastPlayed = new Map();
const activeVoices = new Set();

const clamp01 = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};

const bool = (value, fallback) =>
  typeof value === 'boolean' ? value : fallback;

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      muted: bool(raw.muted, DEFAULT_PREFS.muted),
      music: bool(raw.music, DEFAULT_PREFS.music),
      sfx: bool(raw.sfx, DEFAULT_PREFS.sfx),
      musicVolume: clamp01(raw.musicVolume, DEFAULT_PREFS.musicVolume),
      sfxVolume: clamp01(raw.sfxVolume, DEFAULT_PREFS.sfxVolume)
    };
  } catch {
    return {...DEFAULT_PREFS};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage may be unavailable in private/restricted environments.
  }
}

function allowedMusic() {
  return prefs.music && !prefs.muted;
}

function allowedSfx() {
  return prefs.sfx && !prefs.muted;
}

function musicTarget() {
  if (!allowedMusic()) return 0;
  return clamp01(
    prefs.musicVolume * (ducked ? MUSIC.duckLevel : 1),
    0
  );
}

function sfxTarget(name, localGain = 1) {
  return clamp01(
    (prefs.sfx ? prefs.sfxVolume : 0) * localGain,
    0
  );
}

function ensureContext() {
  if (audioContext) return audioContext;
  if (typeof window === 'undefined') return null;

  const Context = window.AudioContext || window.webkitAudioContext;
  if (typeof Context !== 'function') return null;

  try {
    audioContext = new Context({latencyHint:'interactive'});

    masterGain = audioContext.createGain();
    musicGain = audioContext.createGain();
    sfxGain = audioContext.createGain();

    compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -8;
    compressor.knee.value = 10;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.22;

    musicGain.gain.value = musicTarget();
    sfxGain.gain.value = prefs.sfx && !prefs.muted ? 1 : 0;
    masterGain.gain.value = prefs.muted ? 0 : 1;

    musicGain.connect(masterGain);
    sfxGain.connect(masterGain);
    masterGain.connect(compressor);
    compressor.connect(audioContext.destination);

    noiseBuffer = createNoiseBuffer(audioContext);
    return audioContext;
  } catch {
    audioContext = null;
    masterGain = musicGain = sfxGain = compressor = null;
    noiseBuffer = null;
    return null;
  }
}

function createNoiseBuffer(ctx) {
  try {
    const length = Math.max(1, Math.floor(ctx.sampleRate * 0.12));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i++) {
      const fade = 1 - i / length;
      data[i] = (Math.random() * 2 - 1) * fade;
    }

    return buffer;
  } catch {
    return null;
  }
}

async function resumeContext() {
  const ctx = ensureContext();
  if (!ctx) return null;

  try {
    if (ctx.state !== 'running') await ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function setParam(gainParam, value, timeConstant = 0.04) {
  if (!gainParam || !audioContext) return;
  const now = audioContext.currentTime;
  const target = clamp01(value, 0);
  gainParam.cancelScheduledValues(now);
  gainParam.setTargetAtTime(target, now, timeConstant);
}

function setMusicBusTarget(duration = 0.08) {
  if (!musicGain || !audioContext) return;

  const now = audioContext.currentTime;
  const target = musicTarget();

  musicGain.gain.cancelScheduledValues(now);
  musicGain.gain.setValueAtTime(musicGain.gain.value, now);
  musicGain.gain.linearRampToValueAtTime(target, now + Math.max(0.01, duration));
}

function updateSettingsUI() {
  const master = document.getElementById('bAudioMute');
  const musicToggle = document.getElementById('bMusicToggle');
  const sfxToggle = document.getElementById('bSfxToggle');
  const musicRange = document.getElementById('musicVolume');
  const sfxRange = document.getElementById('sfxVolume');
  const musicValue = document.getElementById('musicVolumeValue');
  const sfxValue = document.getElementById('sfxVolumeValue');

  if (master) {
    master.textContent = prefs.muted ? '🔇 الصوت مكتوم' : '🔊 الصوت مفعّل';
    master.classList.toggle('muted', prefs.muted);
    master.setAttribute('aria-pressed', String(prefs.muted));
  }

  if (musicToggle) {
    musicToggle.textContent = prefs.music
      ? '🎵 الموسيقى: تشغيل'
      : '🎵 الموسيقى: إيقاف';
    musicToggle.classList.toggle('isOff', !prefs.music);
    musicToggle.setAttribute('aria-pressed', String(prefs.music));
  }

  if (sfxToggle) {
    sfxToggle.textContent = prefs.sfx
      ? '🔔 المؤثرات: تشغيل'
      : '🔔 المؤثرات: إيقاف';
    sfxToggle.classList.toggle('isOff', !prefs.sfx);
    sfxToggle.setAttribute('aria-pressed', String(prefs.sfx));
  }

  if (musicRange) musicRange.value = Math.round(prefs.musicVolume * 100);
  if (sfxRange) sfxRange.value = Math.round(prefs.sfxVolume * 100);
  if (musicValue) musicValue.textContent = Math.round(prefs.musicVolume * 100) + '%';
  if (sfxValue) sfxValue.textContent = Math.round(prefs.sfxVolume * 100) + '%';
}

function updateSoundButton() {
  const button = document.getElementById('bSound');
  if (!button) return;

  button.textContent = prefs.muted ? '🔇' : '🔊';
  button.setAttribute(
    'aria-label',
    prefs.muted ? 'الصوت مكتوم — تشغيل الصوت' : 'كتم الصوت'
  );
  button.setAttribute('aria-pressed', String(prefs.muted));
  button.title = prefs.muted ? 'تشغيل الصوت' : 'كتم الصوت';
  button.classList.toggle('muted', prefs.muted);
}

function safeStopSource(source) {
  try {
    source.stop();
  } catch {
    // Source may already be stopped.
  }
}

function makeVoice(name, stopFn) {
  const voice = {name, stopped:false, stop:stopFn};
  activeVoices.add(voice);
  return voice;
}

function releaseVoice(voice) {
  if (!voice) return;
  voice.stopped = true;
  activeVoices.delete(voice);
}

function stopVoice(voice) {
  if (!voice || voice.stopped) return;

  try {
    voice.stop();
  } catch {
    // Audio cleanup must never affect gameplay.
  }

  releaseVoice(voice);
}

function stopVoices(filter = null) {
  for (const voice of [...activeVoices]) {
    if (!filter || filter(voice)) stopVoice(voice);
  }
}

function stopSFX(name) {
  if (!name) return;
  stopVoices(voice => voice.name === name);
}

function stopAllSFX() {
  stopVoices();
  lastPlayed.clear();
}

function scheduleToneVoice({
  name,
  frequency,
  start,
  duration = 0.16,
  gain = 0.1,
  type = 'triangle',
  attack = 0.008,
  release = 0.12,
  detune = 0,
  filterFrequency = 2200
}) {
  const ctx = ensureContext();
  if (!ctx || !sfxGain) return null;

  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const envelope = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(20, frequency), start);
  osc.detune.setValueAtTime(detune, start);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(filterFrequency, start);
  filter.Q.setValueAtTime(0.5, start);

  const peak = sfxTarget(name, gain);
  const end = start + Math.max(0.025, duration);

  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), start + attack);
  envelope.gain.setValueAtTime(Math.max(0.0001, peak), Math.max(start + attack, end - release));
  envelope.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(filter);
  filter.connect(envelope);
  envelope.connect(sfxGain);

  const voice = makeVoice(name, () => {
    const now = ctx.currentTime;
    envelope.gain.cancelScheduledValues(now);
    envelope.gain.setTargetAtTime(0.0001, now, 0.012);
    safeStopSource(osc);
  });

  osc.onended = () => releaseVoice(voice);

  try {
    osc.start(start);
    osc.stop(end + 0.03);
  } catch {
    releaseVoice(voice);
    return null;
  }

  return voice;
}

function scheduleNoiseVoice({
  name,
  start,
  duration = 0.06,
  gain = 0.05,
  highpass = 900,
  lowpass = 4500
}) {
  const ctx = ensureContext();
  if (!ctx || !sfxGain || !noiseBuffer) return null;

  const source = ctx.createBufferSource();
  const high = ctx.createBiquadFilter();
  const low = ctx.createBiquadFilter();
  const envelope = ctx.createGain();

  source.buffer = noiseBuffer;

  high.type = 'highpass';
  high.frequency.setValueAtTime(highpass, start);

  low.type = 'lowpass';
  low.frequency.setValueAtTime(lowpass, start);

  const peak = sfxTarget(name, gain);
  const end = start + Math.max(0.02, duration);

  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), start + 0.004);
  envelope.gain.exponentialRampToValueAtTime(0.0001, end);

  source.connect(high);
  high.connect(low);
  low.connect(envelope);
  envelope.connect(sfxGain);

  const voice = makeVoice(name, () => {
    const now = ctx.currentTime;
    envelope.gain.cancelScheduledValues(now);
    envelope.gain.setTargetAtTime(0.0001, now, 0.008);
    safeStopSource(source);
  });

  source.onended = () => releaseVoice(voice);

  try {
    source.start(start);
    source.stop(end + 0.02);
  } catch {
    releaseVoice(voice);
    return null;
  }

  return voice;
}

function playSynthSFX(name, when) {
  const t = Math.max(when, audioContext?.currentTime || 0);

  switch (name) {
    case 'button-click':
      scheduleToneVoice({
        name, frequency: 880, start:t, duration:0.075,
        gain:0.12, type:'sine', attack:0.003, release:0.06,
        filterFrequency:3200
      });
      break;

    case 'tile-select':
      scheduleToneVoice({
        name, frequency:660, start:t, duration:0.10,
        gain:0.15, type:'triangle', attack:0.004, release:0.075,
        filterFrequency:2800
      });
      break;

    case 'tile-place':
      scheduleToneVoice({
        name, frequency:185, start:t, duration:0.13,
        gain:0.22, type:'triangle', attack:0.002, release:0.095,
        filterFrequency:1800
      });
      scheduleNoiseVoice({
        name, start:t, duration:0.045, gain:0.11,
        highpass:950, lowpass:3600
      });
      break;

    case 'tile-cancel':
      scheduleToneVoice({
        name, frequency:280, start:t, duration:0.12,
        gain:0.15, type:'triangle', attack:0.003, release:0.10,
        filterFrequency:2200
      });
      break;

    case 'word-submit':
      scheduleToneVoice({
        name, frequency:523.25, start:t, duration:0.18,
        gain:0.14, type:'triangle', attack:0.006, release:0.12,
        filterFrequency:3000
      });
      scheduleToneVoice({
        name, frequency:659.25, start:t + 0.065, duration:0.22,
        gain:0.12, type:'sine', attack:0.006, release:0.16,
        filterFrequency:3600
      });
      break;

    case 'invalid':
      scheduleToneVoice({
        name, frequency:246.94, start:t, duration:0.14,
        gain:0.14, type:'sine', attack:0.003, release:0.10,
        filterFrequency:1800
      });
      scheduleToneVoice({
        name, frequency:233.08, start:t + 0.045, duration:0.12,
        gain:0.095, type:'triangle', attack:0.003, release:0.09,
        filterFrequency:1600
      });
      break;

    case 'score':
      scheduleToneVoice({
        name, frequency:440, start:t, duration:0.13,
        gain:0.13, type:'triangle', attack:0.005, release:0.09,
        filterFrequency:2800
      });
      scheduleToneVoice({
        name, frequency:554.37, start:t + 0.055, duration:0.16,
        gain:0.12, type:'sine', attack:0.005, release:0.11,
        filterFrequency:3200
      });
      scheduleToneVoice({
        name, frequency:659.25, start:t + 0.115, duration:0.22,
        gain:0.10, type:'sine', attack:0.005, release:0.16,
        filterFrequency:3600
      });
      break;

    case 'tile-swap':
      scheduleNoiseVoice({
        name, start:t, duration:0.055, gain:0.08,
        highpass:1200, lowpass:4200
      });
      scheduleToneVoice({
        name, frequency:330, start:t + 0.025, duration:0.15,
        gain:0.12, type:'triangle', attack:0.004, release:0.11,
        filterFrequency:2300
      });
      break;

    case 'pass':
      scheduleToneVoice({
        name, frequency:220, start:t, duration:0.15,
        gain:0.12, type:'sine', attack:0.004, release:0.11,
        filterFrequency:1500
      });
      break;

    case 'undo':
      scheduleToneVoice({
        name, frequency:392, start:t, duration:0.12,
        gain:0.12, type:'triangle', attack:0.004, release:0.09,
        filterFrequency:2500
      });
      scheduleToneVoice({
        name, frequency:293.66, start:t + 0.065, duration:0.17,
        gain:0.10, type:'sine', attack:0.004, release:0.13,
        filterFrequency:2100
      });
      break;

    case 'game-end':
      // A calm Hijaz-colored resolution rather than separate win/lose cues.
      scheduleToneVoice({
        name, frequency:293.66, start:t, duration:0.24,
        gain:0.12, type:'triangle', attack:0.006, release:0.16,
        filterFrequency:2600
      });
      scheduleToneVoice({
        name, frequency:311.13, start:t + 0.09, duration:0.24,
        gain:0.105, type:'sine', attack:0.006, release:0.17,
        filterFrequency:2800
      });
      scheduleToneVoice({
        name, frequency:369.99, start:t + 0.18, duration:0.30,
        gain:0.095, type:'triangle', attack:0.006, release:0.22,
        filterFrequency:3000
      });
      scheduleToneVoice({
        name, frequency:293.66, start:t + 0.29, duration:0.42,
        gain:0.11, type:'sine', attack:0.008, release:0.30,
        filterFrequency:3000
      });
      break;
  }
}

const MELODY_A = Object.freeze([
  0, 1, 2, 3,
  4, 3, 2, null,
  0, 4, 5, 4,
  2, 1, 0, null
]);

const MELODY_B = Object.freeze([
  0, 1, 2, 4,
  3, 2, 1, null,
  0, 4, 6, 5,
  4, 2, 1, 0
]);

function midiLike(degree, octave = 0) {
  if (degree == null) return null;
  const index = Math.max(0, Math.min(HIJAZ.length - 1, degree));
  return HIJAZ[index] * Math.pow(2, octave);
}

function scheduleMelody(stepTime, degree, accent = 1) {
  const frequency = midiLike(degree, 0);
  if (!frequency) return;

  const osc = audioContext.createOscillator();
  const harmonic = audioContext.createOscillator();
  const filter = audioContext.createBiquadFilter();
  const envelope = audioContext.createGain();

  const duration = 0.19;
  const end = stepTime + duration;
  const peak = 0.075 * accent;

  osc.type = 'triangle';
  osc.frequency.setValueAtTime(frequency, stepTime);

  harmonic.type = 'sine';
  harmonic.frequency.setValueAtTime(frequency * 2, stepTime);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(1850, stepTime);
  filter.Q.setValueAtTime(0.35, stepTime);

  envelope.gain.setValueAtTime(0.0001, stepTime);
  envelope.gain.exponentialRampToValueAtTime(peak, stepTime + 0.012);
  envelope.gain.setValueAtTime(peak * 0.82, Math.max(stepTime + 0.014, end - 0.07));
  envelope.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(filter);
  harmonic.connect(filter);
  filter.connect(envelope);
  envelope.connect(musicGain);

  const voice = makeVoice('bgm-melody', () => {
    const now = audioContext.currentTime;
    envelope.gain.cancelScheduledValues(now);
    envelope.gain.setTargetAtTime(0.0001, now, 0.016);
    safeStopSource(osc);
    safeStopSource(harmonic);
  });

  const cleanup = () => releaseVoice(voice);
  osc.onended = cleanup;
  harmonic.onended = cleanup;

  try {
    osc.start(stepTime);
    harmonic.start(stepTime);
    osc.stop(end + 0.025);
    harmonic.stop(end + 0.025);
  } catch {
    releaseVoice(voice);
  }
}

function scheduleBass(stepTime, rootDegree, duration) {
  const root = midiLike(rootDegree, -1);
  const fifth = midiLike(4, -1);
  if (!root || !fifth) return;

  const end = stepTime + duration;
  const filter = audioContext.createBiquadFilter();
  const envelope = audioContext.createGain();
  const oscA = audioContext.createOscillator();
  const oscB = audioContext.createOscillator();

  oscA.type = 'sine';
  oscB.type = 'triangle';
  oscA.frequency.setValueAtTime(root, stepTime);
  oscB.frequency.setValueAtTime(fifth, stepTime);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(620, stepTime);
  filter.Q.setValueAtTime(0.45, stepTime);

  envelope.gain.setValueAtTime(0.0001, stepTime);
  envelope.gain.exponentialRampToValueAtTime(0.034, stepTime + 0.025);
  envelope.gain.setValueAtTime(0.025, Math.max(stepTime + 0.03, end - 0.12));
  envelope.gain.exponentialRampToValueAtTime(0.0001, end);

  oscA.connect(filter);
  oscB.connect(filter);
  filter.connect(envelope);
  envelope.connect(musicGain);

  const voice = makeVoice('bgm-bass', () => {
    const now = audioContext.currentTime;
    envelope.gain.cancelScheduledValues(now);
    envelope.gain.setTargetAtTime(0.0001, now, 0.02);
    safeStopSource(oscA);
    safeStopSource(oscB);
  });

  const cleanup = () => releaseVoice(voice);
  oscA.onended = cleanup;
  oscB.onended = cleanup;

  try {
    oscA.start(stepTime);
    oscB.start(stepTime);
    oscA.stop(end + 0.025);
    oscB.stop(end + 0.025);
  } catch {
    releaseVoice(voice);
  }
}

function scheduleDrone(stepTime, duration) {
  const root = midiLike(0, -1);
  const fourth = midiLike(3, -1);
  if (!root || !fourth) return;

  const end = stepTime + duration;
  const envelope = audioContext.createGain();
  const filter = audioContext.createBiquadFilter();
  const rootOsc = audioContext.createOscillator();
  const fourthOsc = audioContext.createOscillator();

  rootOsc.type = 'triangle';
  fourthOsc.type = 'sine';
  rootOsc.frequency.setValueAtTime(root, stepTime);
  fourthOsc.frequency.setValueAtTime(fourth, stepTime);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(900, stepTime);
  filter.Q.setValueAtTime(0.3, stepTime);

  envelope.gain.setValueAtTime(0.0001, stepTime);
  envelope.gain.linearRampToValueAtTime(0.018, stepTime + 0.18);
  envelope.gain.setValueAtTime(0.015, Math.max(stepTime + 0.2, end - 0.22));
  envelope.gain.linearRampToValueAtTime(0.0001, end);

  rootOsc.connect(filter);
  fourthOsc.connect(filter);
  filter.connect(envelope);
  envelope.connect(musicGain);

  const voice = makeVoice('bgm-drone', () => {
    const now = audioContext.currentTime;
    envelope.gain.cancelScheduledValues(now);
    envelope.gain.setTargetAtTime(0.0001, now, 0.05);
    safeStopSource(rootOsc);
    safeStopSource(fourthOsc);
  });

  const cleanup = () => releaseVoice(voice);
  rootOsc.onended = cleanup;
  fourthOsc.onended = cleanup;

  try {
    rootOsc.start(stepTime);
    fourthOsc.start(stepTime);
    rootOsc.stop(end + 0.03);
    fourthOsc.stop(end + 0.03);
  } catch {
    releaseVoice(voice);
  }
}

function schedulePercussion(stepTime, step) {
  const isDownbeat = step % MUSIC.stepsPerBeat === 0;
  const isBackbeat = step % MUSIC.stepsPerBeat === 8;

  if (isDownbeat) {
    const osc = audioContext.createOscillator();
    const envelope = audioContext.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(94, stepTime);
    envelope.gain.setValueAtTime(0.0001, stepTime);
    envelope.gain.exponentialRampToValueAtTime(0.022, stepTime + 0.005);
    envelope.gain.exponentialRampToValueAtTime(0.0001, stepTime + 0.10);
    osc.connect(envelope);
    envelope.connect(musicGain);

    const voice = makeVoice('bgm-percussion', () => {
      envelope.gain.setTargetAtTime(0.0001, audioContext.currentTime, 0.01);
      safeStopSource(osc);
    });
    osc.onended = () => releaseVoice(voice);

    try {
      osc.start(stepTime);
      osc.stop(stepTime + 0.13);
    } catch {
      releaseVoice(voice);
    }
  } else if (isBackbeat) {
    scheduleNoiseVoiceBGM(stepTime, 0.022, 0.055);
  }
}

function scheduleNoiseVoiceBGM(start, gain, duration) {
  if (!noiseBuffer) return;

  const source = audioContext.createBufferSource();
  const high = audioContext.createBiquadFilter();
  const envelope = audioContext.createGain();
  const end = start + duration;

  source.buffer = noiseBuffer;
  high.type = 'bandpass';
  high.frequency.setValueAtTime(2400, start);
  high.Q.setValueAtTime(0.6, start);

  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(gain, start + 0.003);
  envelope.gain.exponentialRampToValueAtTime(0.0001, end);

  source.connect(high);
  high.connect(envelope);
  envelope.connect(musicGain);

  const voice = makeVoice('bgm-percussion', () => {
    envelope.gain.setTargetAtTime(0.0001, audioContext.currentTime, 0.008);
    safeStopSource(source);
  });

  source.onended = () => releaseVoice(voice);

  try {
    source.start(start);
    source.stop(end + 0.015);
  } catch {
    releaseVoice(voice);
  }
}

function scheduleMusicStep(stepTime, step) {
  const phase = Math.floor(step / MUSIC.stepsPerBar) % 2;
  const pattern = phase === 0 ? MELODY_A : MELODY_B;
  const degree = pattern[step % MUSIC.stepsPerBar];

  if (degree != null) {
    const accent = step % MUSIC.stepsPerBeat === 0 ? 1.1 : 0.9;
    scheduleMelody(stepTime, degree, accent);
  }

  if (step % MUSIC.stepsPerBeat === 0) {
    const beat = Math.floor(step / MUSIC.stepsPerBeat) % 4;
    scheduleBass(stepTime, beat === 2 ? 4 : 0, 0.48);
  }

  if (step % MUSIC.stepsPerBar === 0) {
    scheduleDrone(stepTime, 2.36);
  }

  schedulePercussion(stepTime, step);
}

function schedulerTick() {
  if (!audioContext || !musicRunning || !active || document.hidden) return;
  if (!allowedMusic() || audioContext.state !== 'running') return;
  if (schedulerBusy) return;

  schedulerBusy = true;
  const session = musicSession;

  try {
    if (nextMusicTime < audioContext.currentTime - 0.05) {
      nextMusicTime = audioContext.currentTime + 0.03;
    }

    while (
      nextMusicTime < audioContext.currentTime + MUSIC.lookahead &&
      session === musicSession
    ) {
      scheduleMusicStep(nextMusicTime, musicStep);
      nextMusicTime += 60 / MUSIC.bpm / MUSIC.stepsPerBeat;
      musicStep = (musicStep + 1) % (MUSIC.stepsPerBar * 2);
    }
  } finally {
    schedulerBusy = false;
  }
}

function startScheduler(reset = false) {
  const ctx = ensureContext();
  if (!ctx || !active || !allowedMusic()) return false;

  if (reset) musicStep = 0;

  musicSession++;
  musicRunning = true;
  nextMusicTime = ctx.currentTime + 0.04;

  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(schedulerTick, MUSIC.schedulerMs);
  schedulerTick();
  return true;
}

function stopMusicVoices() {
  stopVoices(voice => voice.name.startsWith('bgm-'));
}

function stopScheduler() {
  musicSession++;
  musicRunning = false;

  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = 0;
  }

  stopMusicVoices();
}

function fadeMusicOut(immediate = false) {
  if (!musicGain || !audioContext) {
    stopScheduler();
    return;
  }

  const now = audioContext.currentTime;
  musicGain.gain.cancelScheduledValues(now);
  musicGain.gain.setValueAtTime(musicGain.gain.value, now);

  if (immediate) {
    musicGain.gain.setValueAtTime(0, now);
    stopScheduler();
    return;
  }

  musicGain.gain.linearRampToValueAtTime(0, now + MUSIC.fadeOut);
  const token = musicSession;

  setTimeout(() => {
    if (token !== musicSession || active) return;
    stopScheduler();
    if (musicGain && audioContext) {
      musicGain.gain.setValueAtTime(0, audioContext.currentTime);
    }
  }, MUSIC.fadeOut * 1000 + 35);
}

function fadeMusicIn() {
  if (!musicGain || !audioContext || !allowedMusic()) return;

  const now = audioContext.currentTime;
  musicGain.gain.cancelScheduledValues(now);
  musicGain.gain.setValueAtTime(0, now);
  musicGain.gain.linearRampToValueAtTime(musicTarget(), now + MUSIC.fadeIn);
}

function bindPlaybackGesture() {
  if (playbackGestureBound) return;
  playbackGestureBound = true;

  const resume = () => {
    if (!active || !audioContext || document.hidden) return;
    resumeContext().then(ctx => {
      if (ctx && allowedMusic() && !musicRunning) {
        fadeMusicIn();
        startScheduler(false);
      }
    });
  };

  document.addEventListener('pointerdown', resume, {passive:true});
  document.addEventListener('keydown', resume);
  document.addEventListener('touchstart', resume, {passive:true});
}

async function handleVisibilityChange() {
  const ctx = audioContext;
  if (!ctx || !active) return;

  if (document.hidden) {
    stopMusicVoices();
    stopScheduler();

    try {
      await ctx.suspend();
    } catch {
      // Suspension is a best-effort mobile/background optimization.
    }

    return;
  }

  try {
    await resumeContext();
  } catch {
    return;
  }

  if (active && allowedMusic()) {
    nextMusicTime = ctx.currentTime + 0.04;
    fadeMusicIn();
    startScheduler(false);
  }
}

function bindAudioLifecycleAdapters() {
  if (lifecycleBound) return;
  lifecycleBound = true;

  const newGameButton = document.getElementById('bNew');
  if (newGameButton) {
    newGameButton.addEventListener(
      'click',
      () => stopSFX('game-end'),
      {capture:true}
    );
  }

  const confirmDialog = document.getElementById('dlg');
  if (confirmDialog) {
    confirmDialog.addEventListener('close', () => {
      setMusicDucked(false);
    });
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pagehide', () => {
    if (audioContext && active) {
      stopMusicVoices();
      stopScheduler();
      try { audioContext.suspend(); } catch {}
    }
  });
}

function bindSettingsControls() {
  if (settingsBound) return;
  settingsBound = true;

  const open = document.getElementById('bAudioSettings');
  const dialog = document.getElementById('ad');
  const master = document.getElementById('bAudioMute');
  const musicToggle = document.getElementById('bMusicToggle');
  const sfxToggle = document.getElementById('bSfxToggle');
  const musicRange = document.getElementById('musicVolume');
  const sfxRange = document.getElementById('sfxVolume');

  if (open && dialog) {
    open.onclick = async () => {
      await resumeContext();
      playSFX('button-click');
      updateSettingsUI();
      setMusicDucked(true);
      dialog.returnValue = '';
      dialog.showModal();
    };
  }

  if (master) master.onclick = toggleMute;

  if (musicToggle) {
    musicToggle.onclick = () => setMusicEnabled(!prefs.music);
  }

  if (sfxToggle) {
    sfxToggle.onclick = () => setSfxEnabled(!prefs.sfx);
  }

  if (musicRange) {
    musicRange.oninput = event => {
      setVolume('music', Number(event.target.value) / 100);
    };
  }

  if (sfxRange) {
    sfxRange.oninput = event => {
      setVolume('sfx', Number(event.target.value) / 100);
    };
  }

  if (dialog) {
    dialog.addEventListener('close', () => {
      setMusicDucked(false);
      updateSettingsUI();
    });
  }
}

export function prepareForNewGame() {
  musicSession++;
  active = false;
  duckDepth = 0;
  ducked = false;

  stopScheduler();
  stopAllSFX();
  lastPlayed.clear();

  if (musicGain && audioContext) {
    const now = audioContext.currentTime;
    musicGain.gain.cancelScheduledValues(now);
    musicGain.gain.setValueAtTime(0, now);
  }
}

export async function startNewGameAudio() {
  musicSession++;
  active = true;
  duckDepth = 0;
  ducked = false;

  stopScheduler();
  stopAllSFX();
  lastPlayed.clear();

  const ctx = await resumeContext();
  if (!ctx) return;

  nextMusicTime = ctx.currentTime + 0.04;

  if (allowedMusic()) {
    fadeMusicIn();
    startScheduler(true);
  } else if (musicGain) {
    setParam(musicGain.gain, 0);
  }
}

export function initAudio() {
  if (initialized) return;
  initialized = true;

  prefs = loadPrefs();

  bindSettingsControls();
  bindAudioLifecycleAdapters();
  bindPlaybackGesture();

  updateSoundButton();
  updateSettingsUI();

  // Don't construct AudioContext until first real interaction on supported browsers.
  if (prefs.muted) return;
}

export function playBGM(reset = false) {
  active = true;

  const ctx = ensureContext();
  if (!ctx) return;

  if (reset) {
    musicStep = 0;
    stopScheduler();
  }

  resumeContext().then(context => {
    if (!context || !active || document.hidden || !allowedMusic()) return;
    fadeMusicIn();
    startScheduler(reset);
  });
}

export function stopBGM() {
  active = false;
  fadeMusicOut(false);
}

export function toggleMute() {
  prefs.muted = !prefs.muted;
  savePrefs();

  const ctx = ensureContext();

  if (prefs.muted) {
    stopAllSFX();
    if (ctx && masterGain) setParam(masterGain.gain, 0, 0.01);
  } else if (ctx && masterGain) {
    setParam(masterGain.gain, 1, 0.015);
    if (active && allowedMusic()) {
      resumeContext().then(() => {
        if (active && allowedMusic() && !document.hidden) {
          fadeMusicIn();
          startScheduler(false);
        }
      });
    }
  }

  updateSoundButton();
  updateSettingsUI();
}

export function setMusicEnabled(on) {
  prefs.music = Boolean(on);
  savePrefs();

  if (allowedMusic() && active) {
    resumeContext().then(ctx => {
      if (!ctx || !active || document.hidden) return;
      fadeMusicIn();
      startScheduler(false);
    });
  } else {
    fadeMusicOut(true);
  }

  updateSoundButton();
  updateSettingsUI();
}

export function setSfxEnabled(on) {
  prefs.sfx = Boolean(on);
  savePrefs();

  if (prefs.sfx) {
    if (sfxGain && audioContext) setParam(sfxGain.gain, 1, 0.02);
  } else {
    stopAllSFX();
    if (sfxGain && audioContext) setParam(sfxGain.gain, 0, 0.01);
  }

  updateSoundButton();
  updateSettingsUI();
}

export function setVolume(kind, value) {
  if (kind !== 'music' && kind !== 'sfx') {
    throw new RangeError('Unknown volume channel: ' + kind);
  }

  const volume = clamp01(value, NaN);
  if (Number.isNaN(volume)) {
    throw new RangeError('Volume must be a number between 0 and 1');
  }

  if (kind === 'music') {
    prefs.musicVolume = volume;
    setMusicBusTarget(0.08);
  } else {
    prefs.sfxVolume = volume;
  }

  savePrefs();
  updateSettingsUI();
}

export function setMusicDucked(on) {
  if (on) {
    duckDepth++;
  } else {
    duckDepth = Math.max(0, duckDepth - 1);
  }

  const next = duckDepth > 0;
  if (ducked === next) return;

  ducked = next;
  setMusicBusTarget(ducked ? 0.14 : 0.30);
}

export function getAudioSettings() {
  return {...prefs};
}

export function isMuted() {
  return prefs.muted;
}

export function stopAllSFXNow() {
  stopAllSFX();
}

export function playSFX(name) {
  if (!initialized || !allowedSfx()) return;
  if (!SFX_IDS.includes(name)) return;

  const now = performance.now();
  const last = lastPlayed.get(name) ?? -Infinity;
  const cfg = SFX[name];

  if (now - last < cfg.cooldown) return;

  const ctx = ensureContext();
  if (!ctx) return;

  if (ctx.state !== 'running') {
    resumeContext().then(context => {
      if (context) playSFX(name);
    });
    return;
  }

  const start = Math.max(ctx.currentTime + 0.004, now / 1000 + 0.004);
  lastPlayed.set(name, now);

  try {
    playSynthSFX(name, start);
  } catch {
    // Audio must never affect gameplay.
  }
}
