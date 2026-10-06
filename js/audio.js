// Background music controller.
// Put the game music at: assets/audio/bgm.mp3
//
// The module is intentionally independent from the game rules so it can
// safely be used by main.js, input.js and game.js without circular imports.

let bgm = null;
let active = false;
let retryBound = false;

function tryPlay() {
  if (!bgm || !active || document.hidden) return;

  const p = bgm.play();
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      // Browser autoplay restrictions are handled by the next user interaction.
    });
  }
}

function bindPlaybackRetry() {
  if (retryBound) return;
  retryBound = true;

  const retry = () => {
    if (bgm && active && bgm.paused) tryPlay();
  };

  // If the first play() is blocked, resume after a real user interaction.
  document.addEventListener('pointerdown', retry, { passive: true });
  document.addEventListener('keydown', retry);
  document.addEventListener('touchstart', retry, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && active && bgm && bgm.paused) tryPlay();
  });
}

export function initAudio() {
  if (bgm) return;

  bgm = document.getElementById('bgm');
  if (!bgm) return;

  bgm.loop = true;
  bgm.preload = 'auto';
  bgm.volume = 0.35;
  bgm.setAttribute('aria-hidden', 'true');

  bindPlaybackRetry();
}

export function playBGM(reset = false) {
  if (!bgm) return;

  active = true;

  if (reset) {
    // Reset before every new game so the music always starts from 00:00.
    bgm.pause();
    bgm.currentTime = 0;
  }

  tryPlay();
}

export function stopBGM() {
  active = false;

  if (!bgm) return;

  bgm.pause();
  bgm.currentTime = 0;
}
