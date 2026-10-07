// Audio engine for Arabic Scrabble.
// Keeps the game's custom MP3 assets and adds persistent, independent music/SFX controls.
//
// Existing assets are optional. Missing files are ignored without breaking gameplay.

const BGM_SRC = 'assets/audio/bgm.mp3';
const STORAGE_KEY = 'scrabble.audio.v2';

const DEFAULT_PREFS = Object.freeze({
  muted: false,
  music: true,
  sfx: true,
  musicVolume: 0.35,
  sfxVolume: 0.70
});

const SFX = {
  'tile-select': {src:'assets/audio/tile-select.mp3', volume:.20, pool:2, cooldown:70},
  'tile-place':  {src:'assets/audio/tile-place.mp3',  volume:.45, pool:3, cooldown:50},
  'tile-cancel': {src:'assets/audio/tile-cancel.mp3', volume:.25, pool:2, cooldown:80},
  'word-submit': {src:'assets/audio/word-submit.mp3', volume:.34, pool:2, cooldown:100},
  // Several optional dedicated clips may be added later. Until then, fall back
  // to the closest existing custom MP3 already bundled with the game.
  'invalid':     {src:'assets/audio/invalid.mp3',     fallback:'assets/audio/tile-cancel.mp3', volume:.30, pool:2, cooldown:120},
  'score':       {src:'assets/audio/score.mp3',       fallback:'assets/audio/word-submit.mp3', volume:.42, pool:2, cooldown:100},
  'tile-swap':   {src:'assets/audio/tile-swap.mp3',   fallback:'assets/audio/tile-place.mp3', volume:.38, pool:2, cooldown:100},
  'pass':        {src:'assets/audio/pass.mp3',        fallback:'assets/audio/tile-cancel.mp3', volume:.27, pool:2, cooldown:120},
  'undo':        {src:'assets/audio/undo.mp3',        fallback:'assets/audio/tile-cancel.mp3', volume:.27, pool:2, cooldown:120},
  'game-end':    {src:'assets/audio/game-end.mp3',    volume:.48, pool:2, cooldown:200},
  'victory':     {src:'assets/audio/victory.mp3',     fallback:'assets/audio/word-submit.mp3', volume:.52, pool:1, cooldown:300},
  'defeat':      {src:'assets/audio/defeat.mp3',      fallback:'assets/audio/game-end.mp3', volume:.44, pool:1, cooldown:300},
  // UI-only feedback uses the existing tile-select MP3, so no new asset is required.
  'button-click': {src:'assets/audio/tile-select.mp3', volume:.14, pool:2, cooldown:75}
};

let bgm = null;
let active = false;
let initialized = false;
let retryBound = false;
let muted = DEFAULT_PREFS.muted;
let prefs = {...DEFAULT_PREFS};
let ducked = false;
let fadeToken = 0;

const clips = new Map();
const lastPlayed = new Map();

const clamp01 = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};

const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;

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
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); }
  catch { /* private mode / quota: preferences simply won't persist */ }
}

function allowedMusic() {
  return prefs.music && !prefs.muted;
}

function allowedSfx() {
  return prefs.sfx && !prefs.muted;
}

function musicTarget() {
  return allowedMusic() ? prefs.musicVolume * (ducked ? 0.18 : 1) : 0;
}

function fadeBGM(target, duration = 420, after = null) {
  if (!bgm) { after?.(); return; }
  const token = ++fadeToken;
  const start = bgm.volume;
  const end = clamp01(target, 0);
  if (duration <= 0 || Math.abs(end - start) < 0.001) {
    bgm.volume = end;
    after?.();
    return;
  }
  const started = performance.now();
  const step = now => {
    if (token !== fadeToken || !bgm) return;
    const progress = Math.min(1, (now - started) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    bgm.volume = start + (end - start) * eased;
    if (progress < 1) requestAnimationFrame(step);
    else after?.();
  };
  requestAnimationFrame(step);
}

function stopAllSFX() {
  for (const pool of clips.values()) {
    for (const clip of pool) {
      try {
        clip.pause();
        clip.currentTime = 0;
      } catch { /* broken media element */ }
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

function tryPlayBGM() {
  if (!bgm || !active || !allowedMusic() || document.hidden) return;

  const promise = bgm.play();
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {
      // Autoplay restrictions are handled by the retry listeners.
    });
  }
}

function bindPlaybackRetry() {
  if (retryBound) return;
  retryBound = true;

  const retry = () => {
    if (bgm && active && allowedMusic() && bgm.paused) tryPlayBGM();
  };

  document.addEventListener('pointerdown', retry, {passive:true});
  document.addEventListener('keydown', retry);
  document.addEventListener('touchstart', retry, {passive:true});
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) retry();
  });
}

function makePool(name, cfg) {
  const pool = [];

  for (let i = 0; i < cfg.pool; i++) {
    const clip = new Audio(cfg.src);
    clip.preload = 'auto';
    clip.volume = cfg.volume * prefs.sfxVolume;
    clip.addEventListener('error', () => {
      if (cfg.fallback && clip.dataset.fallbackTried !== '1') {
        clip.dataset.fallbackTried = '1';
        clip.dataset.broken = '';
        try {
          clip.src = cfg.fallback;
          clip.load();
        } catch {
          clip.dataset.broken = '1';
        }
      } else {
        clip.dataset.broken = '1';
      }
    });
    pool.push(clip);
  }

  return pool;
}

function getPool(name) {
  let pool = clips.get(name);
  if (pool) return pool;

  const cfg = SFX[name];
  if (!cfg) return null;

  pool = makePool(name, cfg);
  clips.set(name, pool);
  return pool;
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
    musicRange.oninput = e => setVolume('music', Number(e.target.value) / 100);
  }

  if (sfxRange) {
    sfxRange.oninput = e => setVolume('sfx', Number(e.target.value) / 100);
  }

  if (dialog) {
    dialog.addEventListener('close', () => {
      setMusicDucked(false);
      updateSettingsUI();
    });
  }
}

export function initAudio() {
  if (initialized) return;
  initialized = true;

  prefs = loadPrefs();
  muted = prefs.muted;

  bgm = document.getElementById('bgm');
  if (bgm) {
    bgm.src = BGM_SRC;
    bgm.loop = true;
    bgm.preload = 'auto';
    bgm.volume = 0;
    bgm.setAttribute('aria-hidden', 'true');
  }

  const soundButton = document.getElementById('bSound');
  if (soundButton) soundButton.onclick = toggleMute;

  bindSettingsControls();
  updateSoundButton();
  updateSettingsUI();
  bindPlaybackRetry();
}

export function playBGM(reset = false) {
  if (!bgm) return;
  active = true;

  if (reset) {
    bgm.pause();
    bgm.currentTime = 0;
  }

  if (reset) bgm.volume = 0;
  tryPlayBGM();
  fadeBGM(musicTarget(), reset ? 900 : 420);
}

export function stopBGM() {
  active = false;
  if (!bgm) return;

  fadeBGM(0, 520, () => {
    if (active || !bgm) return;
    bgm.pause();
    bgm.currentTime = 0;
    bgm.volume = 0;
  });
}

export function toggleMute() {
  prefs.muted = !prefs.muted;
  muted = prefs.muted;
  savePrefs();

  if (prefs.muted) stopAllSFX();

  if (bgm) {
    if (allowedMusic() && active) {
      tryPlayBGM();
      fadeBGM(musicTarget(), 360);
    } else {
      fadeBGM(0, 260, () => {
        if (!allowedMusic() || !active) bgm.pause();
      });
    }
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
        if (!allowedMusic() || !active) bgm.pause();
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
    if (bgm) fadeBGM(musicTarget(), 160);
  } else {
    prefs.sfxVolume = volume;
    for (const [name, pool] of clips) {
      const cfg = SFX[name];
      for (const clip of pool) clip.volume = cfg.volume * volume;
    }
  }

  savePrefs();
  updateSettingsUI();
}

export function setMusicDucked(on) {
  ducked = Boolean(on);
  if (bgm && active && allowedMusic()) fadeBGM(musicTarget(), ducked ? 180 : 360);
}

export function getAudioSettings() {
  return {...prefs};
}

export function isMuted() {
  return prefs.muted;
}

export function playSFX(name) {
  if (!initialized || !allowedSfx()) return;

  const cfg = SFX[name];
  if (!cfg) return;

  const now = performance.now();
  const last = lastPlayed.get(name) ?? -Infinity;
  if (now - last < cfg.cooldown) return;
  lastPlayed.set(name, now);

  const pool = getPool(name);
  if (!pool) return;

  let clip = pool.find(a => a.paused || a.ended || a.dataset.broken === '1');
  if (!clip) clip = pool[0];
  if (clip.dataset.broken === '1') return;

  try {
    clip.currentTime = 0;
    clip.volume = cfg.volume * prefs.sfxVolume;
    const promise = clip.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {});
    }
  } catch {
    // Audio must never affect gameplay.
  }
}
