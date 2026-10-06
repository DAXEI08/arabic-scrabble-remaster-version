// Background music controller.
// Put the game music at: assets/audio/bgm.mp3
//
// The module is intentionally independent from the game rules so it can
// safely be used by main.js, input.js and game.js without circular imports.

let bgm = null;
let retryBound = false;

function bindPlaybackRetry() {
  if (retryBound) return;
  retryBound = true;

  const retry = () => {
    if (!bgm) return;
    if (document.hidden) return;
    // Only retry when playback has not started.
    if (bgm.paused) {
      const p = bgm.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  };

  // Covers browsers that block the first play() call.
  document.addEventListener('pointerdown', retry, { passive: true });
  document.addEventListener('keydown', retry);
  document.addEventListener('touchstart', retry, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !bgm.ended) retry();
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

  if (reset) {
    // Pause first so a restart can never overlap the previous playback.
    bgm.pause();
    bgm.currentTime = 0;
  }

  const p = bgm.play();
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      // Autoplay restrictions are handled by the interaction listeners above.
    });
  }
}

export function stopBGM() {
  if (!bgm) return;

  bgm.pause();
  bgm.currentTime = 0;
}

export function pauseBGM() {
  if (!bgm) return;
  bgm.pause();
}
