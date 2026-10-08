// Procedural acoustic-style audio engine for Arabic Scrabble.
// Zero runtime MP3 dependencies: SFX and BGM are synthesized with Web Audio API.
// The musical layer is deliberately restrained and oud-inspired: plucked-string
// harmonics, warm transients, sparse Hijaz-colored phrases, and a small room tail.
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
  bpm: 72,
  stepsPerBeat: 4,
  stepsPerBar: 16,
  lookahead: 0.24,
  schedulerMs: 70,
  fadeIn: 1.1,
  fadeOut: 0.24,
  duckLevel: 0.15
});

// D Hijaz in 12-TET: 1, b2, 3, 4, 5, b6, b7.
const HIJAZ = Object.freeze([
  293.66, 311.13, 369.99, 392.00,
  440.00, 466.16, 523.25, 587.33
]);

const OUD = Object.freeze({
  // Relative partial levels for a compact oud-like pluck model.
  harmonics: Object.freeze([1, 0.38, 0.19, 0.095, 0.04]),
  attack: 0.006,
  body: 0.105,
  release: 0.26,
  pitchBloom: 0.008,
  pitchSettle: 0.045,
  noiseLevel: 0.18,
  filterBase: 3100,
  filterMin: 1200,
  roomSend: 0.055,
  roomReturn: 0.16
});

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
let roomConvolver = null;
let roomSendGain = null;
let roomReturnGain = null;

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
let audioOperationId = 0;

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
    try {
      audioContext = new Context({latencyHint:'interactive'});
    } catch {
      audioContext = new Context();
    }

    masterGain = audioContext.createGain();
    musicGain = audioContext.createGain();
    sfxGain = audioContext.createGain();

    compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -11;
    compressor.knee.value = 18;
    compressor.ratio.value = 2.0;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.32;

    musicGain.gain.value = musicTarget();
    sfxGain.gain.value = prefs.sfx && !prefs.muted ? 1 : 0;
    masterGain.gain.value = prefs.muted ? 0 : 1;

    musicGain.connect(masterGain);
    sfxGain.connect(masterGain);

    try {
      roomConvolver = audioContext.createConvolver();
      roomSendGain = audioContext.createGain();
      roomReturnGain = audioContext.createGain();
      roomSendGain.gain.value = OUD.roomSend;
      roomReturnGain.gain.value = OUD.roomReturn;
      roomConvolver.buffer = createRoomImpulse(audioContext);
      musicGain.connect(roomSendGain);
      roomSendGain.connect(roomConvolver);
      roomConvolver.connect(roomReturnGain);
      roomReturnGain.connect(masterGain);
    } catch {
      roomConvolver = null;
      roomSendGain = null;
      roomReturnGain = null;
    }

    masterGain.connect(compressor);
    compressor.connect(audioContext.destination);

    noiseBuffer = createNoiseBuffer(audioContext);
    return audioContext;
  } catch {
    audioContext = null;
    masterGain = musicGain = sfxGain = compressor = null;
    noiseBuffer = null;
    roomConvolver = roomSendGain = roomReturnGain = null;
    return null;
  }
}

function createRoomImpulse(ctx) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * 0.52));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  for (let i = 0; i < length; i++) {
    const x = i / length;
    const decay = Math.pow(1 - x, 2.8);
    const early = i < Math.floor(ctx.sampleRate * 0.012) ? 0.5 : 0.15;
    left[i] = (Math.random() * 2 - 1) * decay * early;
    right[i] = (Math.random() * 2 - 1) * decay * early;
  }

  left[0] = 0.8;
  right[0] = 0.78;
  return buffer;
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

function scheduleOudVoice({
  name,
  frequency,
  start,
  duration = 0.28,
  gain = 0.08,
  bus = 'sfx',
  brightness = 0.72,
  attack = OUD.attack,
  release = OUD.release,
  filterFrequency = OUD.filterBase,
  noiseLevel = OUD.noiseLevel,
  pitchBloom = OUD.pitchBloom,
  pitchSettle = OUD.pitchSettle
}) {
  const ctx = ensureContext();
  const output = bus === 'music' ? musicGain : sfxGain;
  if (!ctx || !output) return null;

  const end = start + Math.max(0.06, duration);
  const peak = bus === 'music' ? Math.max(0.0001, gain) : sfxTarget(name, gain);
  const harmonics = OUD.harmonics;
  const harmonicBus = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const envelope = ctx.createGain();
  const oscillators = [];

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(
    Math.max(OUD.filterMin, filterFrequency * (0.74 + brightness * 0.34)),
    start
  );
  filter.Q.setValueAtTime(0.35, start);

  harmonics.forEach((level, index) => {
    const partial = ctx.createOscillator();
    const partialGain = ctx.createGain();
    const multiplier = index + 1;
    const initial = Math.max(20, frequency * multiplier * (1 + pitchBloom));
    const settled = Math.max(20, frequency * multiplier);

    partial.type = 'sine';
    partial.frequency.setValueAtTime(initial, start);
    partial.frequency.exponentialRampToValueAtTime(
      settled,
      start + Math.max(0.012, pitchSettle)
    );
    partial.detune.setValueAtTime((index - 2) * 0.45, start);
    partialGain.gain.setValueAtTime(
      Math.max(0.001, level * (index === 0 ? 1 : brightness)),
      start
    );

    partial.connect(partialGain);
    partialGain.connect(harmonicBus);
    oscillators.push(partial);
  });

  harmonicBus.connect(filter);
  filter.connect(envelope);
  envelope.connect(output);

  const attackEnd = start + Math.min(attack, Math.max(0.003, duration * 0.10));
  const bodyEnd = Math.min(
    end - 0.025,
    start + Math.max(0.065, Math.min(OUD.body + duration * 0.22, duration * 0.48))
  );
  const releaseStart = Math.max(attackEnd + 0.03, end - release);

  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(peak, attackEnd);
  envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.46), bodyEnd);
  envelope.gain.exponentialRampToValueAtTime(0.0001, Math.max(bodyEnd + 0.025, releaseStart));

  let noiseSource = null;
  if (noiseBuffer && noiseLevel > 0) {
    const noiseGain = ctx.createGain();
    const noiseFilter = ctx.createBiquadFilter();
    noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(
      Math.min(4200, Math.max(900, filterFrequency * 0.92)),
      start
    );
    noiseFilter.Q.setValueAtTime(0.65, start);
    noiseGain.gain.setValueAtTime(0.0001, start);
    noiseGain.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, peak * noiseLevel),
      start + 0.003
    );
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, start + Math.min(0.052, duration * 0.18));
    noiseSource.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(output);
  }

  const voice = makeVoice(name, () => {
    const now = ctx.currentTime;
    envelope.gain.cancelScheduledValues(now);
    envelope.gain.setTargetAtTime(0.0001, now, 0.018);
    oscillators.forEach(safeStopSource);
    if (noiseSource) safeStopSource(noiseSource);
  });

  oscillators.forEach(osc => {
    osc.onended = () => releaseVoice(voice);
  });

  try {
    oscillators.forEach(osc => {
      osc.start(start);
      osc.stop(end + 0.04);
    });
    if (noiseSource) {
      noiseSource.start(start);
      noiseSource.stop(Math.min(end, start + Math.max(0.06, duration * 0.22)) + 0.015);
    }
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
      scheduleOudVoice({
        name, frequency:587.33, start:t, duration:0.13,
        gain:0.075, brightness:0.60, release:0.11,
        filterFrequency:2500, noiseLevel:0.08
      });
      break;

    case 'tile-select':
      scheduleOudVoice({
        name, frequency:440, start:t, duration:0.18,
        gain:0.080, brightness:0.66, release:0.15,
        filterFrequency:2400, noiseLevel:0.10
      });
      break;

    case 'tile-place':
      scheduleNoiseVoice({
        name, start:t, duration:0.040, gain:0.075,
        highpass:650, lowpass:2600
      });
      scheduleOudVoice({
        name, frequency:220, start:t + 0.012, duration:0.20,
        gain:0.095, brightness:0.48, release:0.17,
        filterFrequency:1900, noiseLevel:0.05
      });
      break;

    case 'tile-cancel':
      scheduleOudVoice({
        name, frequency:311.13, start:t, duration:0.18,
        gain:0.070, brightness:0.55, release:0.15,
        filterFrequency:2100, noiseLevel:0.07,
        pitchBloom:0.006, pitchSettle:0.050
      });
      scheduleOudVoice({
        name, frequency:246.94, start:t + 0.055, duration:0.16,
        gain:0.048, brightness:0.50, release:0.13,
        filterFrequency:1800, noiseLevel:0.04
      });
      break;

    case 'word-submit':
      scheduleOudVoice({
        name, frequency:440, start:t, duration:0.26,
        gain:0.065, brightness:0.62, release:0.22,
        filterFrequency:2500, noiseLevel:0.07
      });
      scheduleOudVoice({
        name, frequency:554.37, start:t + 0.105, duration:0.34,
        gain:0.060, brightness:0.68, release:0.28,
        filterFrequency:2700, noiseLevel:0.05
      });
      break;

    case 'invalid':
      scheduleOudVoice({
        name, frequency:246.94, start:t, duration:0.24,
        gain:0.062, brightness:0.42, release:0.20,
        filterFrequency:1500, noiseLevel:0.03,
        pitchBloom:0.004, pitchSettle:0.060
      });
      break;

    case 'score':
      scheduleOudVoice({
        name, frequency:293.66, start:t, duration:0.23,
        gain:0.055, brightness:0.55, release:0.19,
        filterFrequency:2200, noiseLevel:0.05
      });
      scheduleOudVoice({
        name, frequency:369.99, start:t + 0.085, duration:0.25,
        gain:0.052, brightness:0.58, release:0.20,
        filterFrequency:2300, noiseLevel:0.04
      });
      scheduleOudVoice({
        name, frequency:392, start:t + 0.17, duration:0.34,
        gain:0.050, brightness:0.60, release:0.27,
        filterFrequency:2400, noiseLevel:0.035
      });
      break;

    case 'tile-swap':
      scheduleNoiseVoice({
        name, start:t, duration:0.048, gain:0.050,
        highpass:500, lowpass:2200
      });
      scheduleOudVoice({
        name, frequency:392, start:t + 0.028, duration:0.18,
        gain:0.052, brightness:0.50, release:0.15,
        filterFrequency:2100, noiseLevel:0.03
      });
      scheduleOudVoice({
        name, frequency:330, start:t + 0.09, duration:0.17,
        gain:0.042, brightness:0.46, release:0.14,
        filterFrequency:1900, noiseLevel:0.02
      });
      break;

    case 'pass':
      scheduleOudVoice({
        name, frequency:220, start:t, duration:0.28,
        gain:0.050, brightness:0.38, release:0.23,
        filterFrequency:1400, noiseLevel:0.02
      });
      break;

    case 'undo':
      scheduleOudVoice({
        name, frequency:392, start:t, duration:0.18,
        gain:0.050, brightness:0.50, release:0.14,
        filterFrequency:2100, noiseLevel:0.04
      });
      scheduleOudVoice({
        name, frequency:293.66, start:t + 0.085, duration:0.28,
        gain:0.048, brightness:0.48, release:0.22,
        filterFrequency:1900, noiseLevel:0.025
      });
      break;

    case 'game-end':
      // Quiet Hijaz cadence: A -> G -> F# -> Eb -> D.
      [
        [440, 0.00, 0.050, 0.24],
        [392, 0.15, 0.048, 0.25],
        [369.99, 0.29, 0.046, 0.27],
        [311.13, 0.43, 0.044, 0.29],
        [293.66, 0.59, 0.060, 0.64]
      ].forEach(([frequency, offset, gain, duration]) => {
        scheduleOudVoice({
          name, frequency, start:t + offset, duration,
          gain, brightness:0.48, release:Math.min(0.52, duration * 0.82),
          filterFrequency:2200, noiseLevel:0.03
        });
      });
      break;
  }
}

const MELODY_A = Object.freeze([
  0, null, 2, 1,
  null, 3, 2, null,
  0, null, 4, 3,
  2, 1, null, 0
]);

const MELODY_B = Object.freeze([
  0, 1, null, 3,
  4, 3, 2, null,
  0, null, 5, 4,
  2, null, 1, 0
]);

const MELODY_C = Object.freeze([
  0, null, 1, 2,
  3, null, 4, 3,
  0, 2, null, 5,
  4, null, 2, 0
]);

const MELODY_D = Object.freeze([
  0, 1, 2, null,
  4, 3, null, 2,
  0, null, 4, 5,
  4, 3, 1, null
]);

function midiLike(degree, octave = 0) {
  if (degree == null) return null;
  const index = Math.max(0, Math.min(HIJAZ.length - 1, degree));
  return HIJAZ[index] * Math.pow(2, octave);
}

function scheduleMelody(stepTime, degree, accent = 1, ornament = false) {
  const frequency = midiLike(degree, 0);
  if (!frequency) return;

  if (ornament && degree === 2) {
    scheduleOudVoice({
      name:'bgm-ornament', frequency:HIJAZ[1], start:stepTime,
      duration:0.12, gain:0.023, bus:'music', brightness:0.58,
      release:0.09, filterFrequency:2400, noiseLevel:0.012
    });
    scheduleOudVoice({
      name:'bgm-melody', frequency, start:stepTime + 0.045,
      duration:0.34, gain:0.082 * accent, bus:'music', brightness:0.74,
      release:0.27, filterFrequency:2900, noiseLevel:0.012
    });
    return;
  }

  scheduleOudVoice({
    name:'bgm-melody', frequency, start:stepTime,
    duration:0.34, gain:0.082 * accent, bus:'music', brightness:0.74,
    release:0.27, filterFrequency:2900, noiseLevel:0.012
  });
}

function scheduleBass(stepTime, degree, duration) {
  const frequency = midiLike(degree, -1);
  if (!frequency) return;

  scheduleOudVoice({
    name:'bgm-bass', frequency, start:stepTime, duration,
    gain:0.028, bus:'music', brightness:0.28, release:Math.min(0.48, duration * 0.72),
    filterFrequency:1250, noiseLevel:0.003, pitchBloom:0.004, pitchSettle:0.06
  });
}

function scheduleDrone(stepTime, duration) {
  scheduleOudVoice({
    name:'bgm-drone', frequency:midiLike(0,-1), start:stepTime, duration,
    gain:0.013, bus:'music', brightness:0.20, attack:0.08,
    release:Math.min(0.55, duration * 0.24), filterFrequency:850,
    noiseLevel:0, pitchBloom:0.001, pitchSettle:0.12
  });
  scheduleOudVoice({
    name:'bgm-drone', frequency:midiLike(4,-1), start:stepTime + 0.02, duration:duration - 0.02,
    gain:0.010, bus:'music', brightness:0.18, attack:0.10,
    release:Math.min(0.55, duration * 0.24), filterFrequency:780,
    noiseLevel:0, pitchBloom:0.001, pitchSettle:0.12
  });
}

function scheduleMusicStep(stepTime, step) {
  const phase = Math.floor(step / MUSIC.stepsPerBar) % 4;
  const pattern =
    phase === 0 ? MELODY_A :
    phase === 1 ? MELODY_B :
    phase === 2 ? MELODY_C :
    MELODY_D;
  const degree = pattern[step % MUSIC.stepsPerBar];

  if (degree != null) {
    const accent = step % MUSIC.stepsPerBeat === 0 ? 1.04 : 0.82;
    const ornament = accent > 1 && (degree === 2 || degree === 4);
    scheduleMelody(stepTime, degree, accent, ornament);
  }

  if (step % MUSIC.stepsPerBeat === 0) {
    const beat = Math.floor(step / MUSIC.stepsPerBeat) % 4;
    if (beat === 0 || beat === 2) {
      scheduleBass(stepTime, beat === 2 ? 4 : 0, 0.62);
    }
  }

  if (step % MUSIC.stepsPerBar === 0) {
    scheduleDrone(stepTime, 3.15);
  }
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
      musicStep = (musicStep + 1) % (MUSIC.stepsPerBar * 4);
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
    const requestId = audioOperationId;
    resumeContext().then(ctx => {
      if (
        ctx &&
        requestId === audioOperationId &&
        active &&
        allowedMusic() &&
        !musicRunning
      ) {
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

  const requestId = audioOperationId;

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

  if (
    requestId !== audioOperationId ||
    !active ||
    document.hidden ||
    !allowedMusic()
  ) return;

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

  window.addEventListener('pageshow', () => {
    if (!audioContext || !active || document.hidden) return;
    handleVisibilityChange();
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
  audioOperationId++;
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
  const requestId = ++audioOperationId;
  musicSession++;
  active = true;
  duckDepth = 0;
  ducked = false;

  stopScheduler();
  stopAllSFX();
  lastPlayed.clear();
  const ctx = await resumeContext();
  if (!ctx || requestId !== audioOperationId || !active) return;

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

  const requestId = ++audioOperationId;

  resumeContext().then(context => {
    if (
      !context ||
      requestId !== audioOperationId ||
      !active ||
      document.hidden ||
      !allowedMusic()
    ) return;

    fadeMusicIn();
    startScheduler(reset);
  });
}

export function stopBGM() {
  audioOperationId++;
  active = false;
  fadeMusicOut(false);
}

export function toggleMute() {
  const requestId = ++audioOperationId;
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
        if (
          requestId === audioOperationId &&
          active &&
          allowedMusic() &&
          !document.hidden
        ) {
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
  const requestId = ++audioOperationId;
  prefs.music = Boolean(on);
  savePrefs();

  if (allowedMusic() && active) {
    resumeContext().then(ctx => {
      if (
        !ctx ||
        requestId !== audioOperationId ||
        !active ||
        document.hidden ||
        !allowedMusic()
      ) return;
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

  const start = ctx.currentTime + 0.004;
  lastPlayed.set(name, now);

  try {
    playSynthSFX(name, start);
  } catch {
    // Audio must never affect gameplay.
  }
}
