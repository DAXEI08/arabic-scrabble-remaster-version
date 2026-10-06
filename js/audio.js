// Audio engine for Arabic Scrabble.
// All audio files are optional. Missing SFX never break the game.
//
// Files expected under: assets/audio/
//   bgm.mp3
//   tile-select.mp3
//   tile-place.mp3
//   tile-cancel.mp3
//   word-submit.mp3
//   invalid.mp3
//   score.mp3
//   tile-swap.mp3
//   pass.mp3
//   undo.mp3
//   game-end.mp3
//   victory.mp3
//   defeat.mp3

const BGM_SRC = 'assets/audio/bgm.mp3';
const MUTE_KEY = 'scrabble.audio.muted';

const SFX = {
  'tile-select': {src:'assets/audio/tile-select.mp3', volume:.20, pool:2, cooldown:70},
  'tile-place':  {src:'assets/audio/tile-place.mp3',  volume:.45, pool:3, cooldown:50},
  'tile-cancel': {src:'assets/audio/tile-cancel.mp3', volume:.25, pool:2, cooldown:80},
  'word-submit': {src:'assets/audio/word-submit.mp3', volume:.34, pool:2, cooldown:100},
  'invalid':     {src:'assets/audio/invalid.mp3',     volume:.30, pool:2, cooldown:120},
  'score':       {src:'assets/audio/score.mp3',       volume:.42, pool:2, cooldown:100},
  'tile-swap':   {src:'assets/audio/tile-swap.mp3',   volume:.38, pool:2, cooldown:100},
  'pass':        {src:'assets/audio/pass.mp3',        volume:.27, pool:2, cooldown:120},
  'undo':        {src:'assets/audio/undo.mp3',        volume:.27, pool:2, cooldown:120},
  'game-end':    {src:'assets/audio/game-end.mp3',    volume:.48, pool:2, cooldown:200},
  'victory':     {src:'assets/audio/victory.mp3',     volume:.52, pool:1, cooldown:300},
  'defeat':      {src:'assets/audio/defeat.mp3',      volume:.44, pool:1, cooldown:300}
};

let bgm = null;
let active = false;
let muted = false;
let initialized = false;
let retryBound = false;
const clips = new Map();
const lastPlayed = new Map();

function readMute() {
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; }
  catch { muted = false; }
}

function saveMute() {
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); }
  catch { /* storage unavailable */ }
}

function updateSoundButton() {
  const b = document.getElementById('bSound');
  if (!b) return;
  b.textContent = muted ? '🔇' : '🔊';
  b.setAttribute('aria-label', muted ? 'الصوت مكتوم — تشغيل الصوت' : 'كتم الصوت');
  b.title = muted ? 'تشغيل الصوت' : 'كتم الصوت';
  b.classList.toggle('muted', muted);
}

function tryPlayBGM() {
  if (!bgm || !active || muted || document.hidden) return;
  const p = bgm.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

function bindPlaybackRetry() {
  if (retryBound) return;
  retryBound = true;

  const retry = () => {
    if (bgm && active && !muted && bgm.paused) tryPlayBGM();
  };

  document.addEventListener('pointerdown', retry, {passive:true});
  document.addEventListener('keydown', retry);
  document.addEventListener('touchstart', retry, {passive:true});
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) retry();
  });
}

function makePool(name, cfg) {
  const arr = [];
  for (let i = 0; i < cfg.pool; i++) {
    const a = new Audio(cfg.src);
    a.preload = 'auto';
    a.volume = cfg.volume;
    a.addEventListener('error', () => { a.dataset.broken = '1'; }, {once:true});
    arr.push(a);
  }
  return arr;
}

function getPool(name) {
  let pool = clips.get(name);
  if (!pool) {
    const cfg = SFX[name];
    if (!cfg) return null;
    pool = makePool(name, cfg);
    clips.set(name, pool);
  }
  return pool;
}

export function initAudio() {
  if (initialized) return;
  initialized = true;
  readMute();

  bgm = document.getElementById('bgm');
  if (bgm) {
    bgm.src = BGM_SRC;
    bgm.loop = true;
    bgm.preload = 'auto';
    bgm.volume = .35;
    bgm.setAttribute('aria-hidden', 'true');
  }

  const b = document.getElementById('bSound');
  if (b) b.onclick = toggleMute;

  updateSoundButton();
  bindPlaybackRetry();
}

export function playBGM(reset=false) {
  if (!bgm) return;
  active = true;

  if (reset) {
    bgm.pause();
    bgm.currentTime = 0;
  }

  tryPlayBGM();
}

export function stopBGM() {
  active = false;
  if (!bgm) return;
  bgm.pause();
  bgm.currentTime = 0;
}

export function toggleMute() {
  muted = !muted;
  saveMute();
  updateSoundButton();

  if (bgm) {
    if (muted) bgm.pause();
    else if (active) tryPlayBGM();
  }
}

export function isMuted() {
  return muted;
}

export function playSFX(name) {
  if (muted || !initialized) return;

  const cfg = SFX[name];
  if (!cfg) return;

  const now = performance.now();
  const last = lastPlayed.get(name) || -Infinity;
  if (now - last < cfg.cooldown) return;
  lastPlayed.set(name, now);

  const pool = getPool(name);
  if (!pool) return;

  // Reuse a finished clip first; otherwise rotate through the small pool.
  let clip = pool.find(a => a.paused || a.ended || a.dataset.broken === '1');
  if (!clip) clip = pool[0];
  if (clip.dataset.broken === '1') return;

  try {
    clip.currentTime = 0;
    const p = clip.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // Audio must never affect gameplay.
  }
}
