// Application entry point.
import { TICK_MS } from './config.js';
import { S } from './state.js';
import { buildDom, chooseDuration } from './ui.js';
import { tick, newGame } from './game.js';
import { initInput } from './input.js';

function start() {
  buildDom();
  initInput();
  setInterval(tick, TICK_MS);
  newGame();
  S.paused = true;       // clock stays frozen until a duration is chosen
  chooseDuration();
}

start();
