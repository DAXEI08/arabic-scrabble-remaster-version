// Isolated audio layer for Arabic Scrabble.
// HTMLAudio-based mixer with shared source pools, session-safe lifecycle,
// mobile/autoplay recovery, logical music/SFX buses, ducking, priority,
// and defensive resource/error handling.
//
// Public API is kept compatible with the existing game integration.
// No gameplay state or non-audio logic is imported here.

const AUDIO_ROOT = 'assets/audio/';
const BGM_SRC = AUDIO_ROOT + 'bgm.mp3';
const STORAGE_KEY = 'scrabble.audio.v2';

const DEFAULT_PREFS = Object.freeze({
  muted: false,
  music: true,
  sfx: true,
  musicVolume: 0.35,
  sfxVolume: 0.70
});

// Logical audio events. Events that intentionally reuse an asset share
// the same underlying media pool, reducing duplicated decoders/buffers.
const SFX = Object.freeze({
  'tile-select':  {src:AUDIO_ROOT + 'tile-select.mp3', volume:.20, pool:2, cooldown:70,  priority:20},
  'tile-place':   {src:AUDIO_ROOT + 'tile-place.mp3',  volume:.45, pool:3, cooldown:50,  priority:40},
  'tile-cancel':  {src:AUDIO_ROOT + 'tile-cancel.mp3', volume:.25, pool:2, cooldown:80,  priority:30},
  'word-submit':  {src:AUDIO_ROOT + 'word-submit.mp3', volume:.34, pool:2, cooldown:100, priority:50},
  'invalid':      {src:AUDIO_ROOT + 'tile-cancel.mp3', volume:.30, pool:2, cooldown:120, priority:25},
  'score':        {src:AUDIO_ROOT + 'word-submit.mp3', volume:.42, pool:2, cooldown:100, priority:45},
  'tile-swap':    {src:AUDIO_ROOT + 'tile-place.mp3',  volume:.38, pool:3, cooldown:100, priority:35},
  'pass':         {src:AUDIO_ROOT + 'tile-cancel.mp3', volume:.27, pool:2, cooldown:120, priority:25},
  'undo':         {src:AUDIO_ROOT + 'tile-cancel.mp3', volume:.27, pool:2, cooldown:120, priority:30},
  'game-end':     {src:AUDIO_ROOT + 'game-end.mp3',    volume:.48, pool:2, cooldown:200, priority:100},
  'button-click': {src:AUDIO_ROOT + 'tile-select.mp3', volume:.14, pool:2, cooldown:75,  priority:15}
});

const SOURCE_POOL_SIZES = (() => {
  const sizes = new Map();
  for (const cfg of Object.values(SFX)) {
    sizes.set(cfg.src, Math.max(sizes.get(cfg.src) || 0, cfg.pool));
  }
  return sizes;
})();

let bgm = null;
let active = false;
let initialized = false;
let retryBound = false;
let prefs = {...DEFAULT_PREFS};

let duckDepth = 0;
let ducked = false;
let fadeFrame = 0;
let sessionId = 0;
let pausedByVisibility = false;

const sourcePools = new Map(); // src -> Audio[]; one pool per unique asset
const voiceMeta = new WeakMap(); // Audio -> {eventName, priority, startedAt}
const lastPlayed = new Map();

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
    // Storage can be unavailable in private/restricted environments.
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
  return clamp01(prefs.musicVolume * (ducked ? 0.18 : 1), 0);
}

function sfxTarget(name) {
  const cfg = SFX[name];
  return cfg ? clamp01(cfg.volume * prefs.sfxVolume, 0) : 0;
}

function cancelFade() {
  if (!fadeFrame) return;
  cancelAnimationFrame(fadeFrame);
  fadeFrame = 0;
}

function fadeBGM(target, duration = 420, after = null) {
  if (!bgm) {
    after?.();
    return;
  }

  cancelFade();

  const start = clamp01(bgm.volume, 0);
  const end = clamp01(target, 0);

  if (duration <= 0 || Math.abs(end - start) < 0.001) {
    bgm.volume = end;
    after?.();
    return;
  }

  const started = performance.now();
  const token = sessionId;

  const step = now => {
    fadeFrame = 0;

    if (!bgm || token !== sessionId) return;

    const progress = Math.min(1, Math.max(0, (now - started) / duration));
    const eased = 1 - Math.pow(1 - progress, 3);
    bgm.volume = start + (end - start) * eased;

    if (progress < 1) {
      fadeFrame = requestAnimationFrame(step);
      return;
    }

    after?.();
  };

  fadeFrame = requestAnimationFrame(step);
}

function stopVoice(voice) {
  try {
    voice.pause();
    voice.currentTime = 0;
    voice.volume = 0;
  } catch {
    // A broken media element must never affect gameplay.
  }
  voiceMeta.delete(voice);
}

function stopAllSFX() {
  for (const pool of sourcePools.values()) {
    for (const voice of pool) stopVoice(voice);
  }
}

function stopSFX(name) {
  if (!name) return;
  for (const pool of sourcePools.values()) {
    for (const voice of pool) {
      const meta = voiceMeta.get(voice);
      if (meta?.eventName === name) stopVoice(voice);
    }
  }
}

function makeVoice(src) {
  const voice = new Audio(src);
  voice.preload = 'auto';
  voice.volume = 0;
  voice.addEventListener('error', () => {
    voice.dataset.broken = '1';
    voiceMeta.delete(voice);
  });
  return voice;
}

function getSourcePool(src) {
  let pool = sourcePools.get(src);
  if (pool) return pool;

  const size = SOURCE_POOL_SIZES.get(src) || 1;
  pool = Array.from({length:size}, () => makeVoice(src));
  sourcePools.set(src, pool);
  return pool;
}

function isUsableVoice(voice) {
  return voice.dataset.broken !== '1';
}

function isBusyVoice(voice) {
  return !voice.paused && !voice.ended;
}

function pickVoice(pool, priority) {
  const usable = pool.filter(isUsableVoice);
  if (!usable.length) return null;

  const idle = usable.find(voice => !isBusyVoice(voice));
  if (idle) return idle;

  // Never steal a higher-priority sound for a lower-priority event.
  const stealable = usable.filter(voice => {
    const meta = voiceMeta.get(voice);
    return !meta || meta.priority <= priority;
  });

  if (!stealable.length) return null;

  return stealable.reduce((oldest, voice) => {
    const a = voiceMeta.get(oldest)?.startedAt ?? -Infinity;
    const b = voiceMeta.get(voice)?.startedAt ?? -Infinity;
    return b < a ? voice : oldest;
  });
}

function updateVoiceVolumes() {
  for (const pool of sourcePools.values()) {
    for (const voice of pool) {
      const meta = voiceMeta.get(voice);
      if (meta?.eventName) {
        voice.volume = sfxTarget(meta.eventName);
      }
    }
  }
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
    musicToggle.textContent = prefs.music ? '🎵 الموسيقى: تشغيل' : '🎵 الموسيقى: إيقاف';
    musicToggle.classList.toggle('isOff', !prefs.music);
    musicToggle.setAttribute('aria-pressed', String(prefs.music));
  }

  if (sfxToggle) {
    sfxToggle.textContent = prefs.sfx ? '🔔 المؤثرات: تشغيل' : '🔔 المؤثرات: إيقاف';
    sfxToggle.classList.toggle('isOff', !prefs.sfx);
    sfxToggle.setAttribute('aria-pressed', String(prefs.sfx));
  }

  if (musicRange) musicRange.value = Math.round(prefs.musicVolume * 100);
  if (sfxRange) sfxRange.value = Math.round(prefs.sfxVolume * 100);
  if (musicValue) musicValue.textContent = Math.round(prefs.musicVolume * 100) + '%';
  if (sfxValue) sfxValue.textContent = Math.round(prefs.sfxVolume * 100) + '%';
}

function safePlay(voice) {
  try {
    const promise = voice.play();
    if (promise && typeof promise.catch === 'function') {
      return promise.catch(() => false);
    }
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

function tryPlayBGM() {
  if (!bgm || !active || !allowedMusic() || document.hidden) return;

  const promise = bgm.play();
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {
      // Autoplay restrictions are retried on real user interaction.
    });
  }
}

function retryPlayback() {
  if (bgm && active && allowedMusic() && bgm.paused && !document.hidden) {
    tryPlayBGM();
  }
}

function handleVisibilityChange() {
  if (!bgm || !active) return;

  if (document.hidden) {
    pausedByVisibility = !bgm.paused;
    cancelFade();
    if (pausedByVisibility) bgm.pause();
    return;
  }

  if (pausedByVisibility) {
    pausedByVisibility = false;
    if (allowedMusic()) {
      tryPlayBGM();
      fadeBGM(musicTarget(), 260);
    }
  }
}

function handlePageHide() {
  if (!bgm || !active) return;
  pausedByVisibility = !bgm.paused;
  cancelFade();
  if (pausedByVisibility) bgm.pause();
}

function handlePageShow() {
  if (!bgm || !active) return;
  if (!document.hidden && pausedByVisibility) {
    pausedByVisibility = false;
    if (allowedMusic()) {
      tryPlayBGM();
      fadeBGM(musicTarget(), 260);
    }
  }
}

function bindPlaybackRetry() {
  if (retryBound) return;
  retryBound = true;

  document.addEventListener('pointerdown', retryPlayback, {passive:true});
  document.addEventListener('keydown', retryPlayback);
  document.addEventListener('touchstart', retryPlayback, {passive:true});
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pagehide', handlePageHide);
  window.addEventListener('pageshow', handlePageShow);
}

function bindAudioLifecycleAdapters() {
  // Final-score/new-game button may be used before the next duration is chosen.
  // Stop only the end-game stinger here; the normal BGM session is left untouched.
  const newGameButton = document.getElementById('bNew');
  if (newGameButton) {
    newGameButton.addEventListener('click', () => stopSFX('game-end'), {capture:true});
  }

  // ui.js opens #dlg for confirmation dialogs and ducks music, but its close
  // listener does not release that audio state. Reconcile exactly one duck
  // layer here without touching the UI/game modules.
  const confirmDialog = document.getElementById('dlg');
  if (confirmDialog) {
    confirmDialog.addEventListener('close', () => {
      setMusicDucked(false);
    });
  }
}

function bindSettingsControls() {
  const open = document.getElementById('bAudioSettings');
  const dialog = document.getElementById('ad');
  const master = document.getElementById('bAudioMute');
  const musicToggle = document.getElementById('bMusicToggle');
  const sfxToggle = document.getElementById('bSfxToggle');
  const musicRange = document.getElementById('musicVolume');
  const sfxRange = document.getElementById('sfxVolume');

  if (open && dialog) {
    open.onclick = () => {
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

function resetDuckState() {
  duckDepth = 0;
  ducked = false;
}

export function prepareForNewGame() {
  sessionId++;
  cancelFade();
  resetDuckState();
  stopAllSFX();
  lastPlayed.clear();

  active = false;
  pausedByVisibility = false;

  if (bgm) {
    try {
      bgm.pause();
      bgm.currentTime = 0;
      bgm.volume = 0;
    } catch {
      // Media may not be seekable yet.
    }
  }
}

export function startNewGameAudio() {
  sessionId++;
  cancelFade();
  stopAllSFX();
  lastPlayed.clear();
  resetDuckState();
  active = true;
  pausedByVisibility = false;

  if (!bgm) return;

  try {
    bgm.pause();
    bgm.currentTime = 0;
    bgm.volume = 0;
  } catch {
    // Media may not be seekable yet.
  }

  if (allowedMusic()) {
    tryPlayBGM();
    fadeBGM(musicTarget(), 900);
  }
}

export function initAudio() {
  if (initialized) return;
  initialized = true;

  prefs = loadPrefs();

  bgm = document.getElementById('bgm');
  if (bgm) {
    bgm.src = BGM_SRC;
    bgm.loop = true;
    bgm.preload = 'none';
    bgm.volume = 0;
    bgm.setAttribute('aria-hidden', 'true');
    bgm.addEventListener('error', () => {
      bgm.dataset.broken = '1';
    });
  }

  const soundButton = document.getElementById('bSound');
  if (soundButton) soundButton.onclick = toggleMute;

  bindSettingsControls();
  bindAudioLifecycleAdapters();
  updateSoundButton();
  updateSettingsUI();
  bindPlaybackRetry();
}

export function playBGM(reset = false) {
  if (!bgm) {
    active = true;
    return;
  }

  active = true;

  if (reset) {
    sessionId++;
    cancelFade();
    try {
      bgm.pause();
      bgm.currentTime = 0;
      bgm.volume = 0;
    } catch {
      // Media may not be seekable yet.
    }
  }

  tryPlayBGM();
  fadeBGM(musicTarget(), reset ? 900 : 420);
}

export function stopBGM() {
  sessionId++;
  active = false;
  pausedByVisibility = false;
  cancelFade();

  if (!bgm) return;

  try {
    bgm.pause();
    bgm.currentTime = 0;
    bgm.volume = 0;
  } catch {
    // Media may not be seekable yet.
  }
}

export function toggleMute() {
  prefs.muted = !prefs.muted;
  savePrefs();

  if (prefs.muted) {
    stopAllSFX();
    if (bgm) {
      cancelFade();
      bgm.pause();
      bgm.volume = 0;
    }
  } else if (bgm && active) {
    tryPlayBGM();
    fadeBGM(musicTarget(), 360);
  }

  updateSoundButton();
  updateSettingsUI();
}

export function setMusicEnabled(on) {
  prefs.music = Boolean(on);
  savePrefs();

  if (bgm) {
    if (allowedMusic() && active) {
      tryPlayBGM();
      fadeBGM(musicTarget(), 360);
    } else if (!prefs.music || prefs.muted) {
      fadeBGM(0, 260, () => {
        if (!allowedMusic() || !active) {
          try { bgm.pause(); } catch {}
        }
      });
    }
  }

  updateSoundButton();
  updateSettingsUI();
}

export function setSfxEnabled(on) {
  prefs.sfx = Boolean(on);
  savePrefs();
  if (!prefs.sfx) stopAllSFX();

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
    if (bgm) fadeBGM(musicTarget(), 120);
  } else {
    prefs.sfxVolume = volume;
    updateVoiceVolumes();
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
  if (bgm && active && allowedMusic()) {
    fadeBGM(musicTarget(), ducked ? 180 : 360);
  }
}

export function getAudioSettings() {
  return {...prefs};
}

export function isMuted() {
  return prefs.muted;
}

export function stopAllSFXNow() {
  stopAllSFX();
  lastPlayed.clear();
}

export function playSFX(name) {
  if (!initialized || !allowedSfx()) return;

  const cfg = SFX[name];
  if (!cfg) return;

  const now = performance.now();
  const last = lastPlayed.get(name) ?? -Infinity;
  if (now - last < cfg.cooldown) return;

  const pool = getSourcePool(cfg.src);
  const voice = pickVoice(pool, cfg.priority);
  if (!voice) return;

  const targetVolume = sfxTarget(name);
  if (targetVolume <= 0) return;

  // Stop a lower/equal-priority voice only when all pooled voices are busy.
  stopVoice(voice);

  voice.volume = targetVolume;
  voiceMeta.set(voice, {
    eventName: name,
    priority: cfg.priority,
    startedAt: now
  });

  const stamp = now;
  lastPlayed.set(name, stamp);

  const promise = safePlay(voice);
  promise.then(ok => {
    if (ok) return;
    const current = voiceMeta.get(voice);
    if (current?.eventName === name) voiceMeta.delete(voice);
    if (lastPlayed.get(name) === stamp) lastPlayed.delete(name);
    stopVoice(voice);
  });
}
