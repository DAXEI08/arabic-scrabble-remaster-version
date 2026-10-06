// Move validation (geometry/connectivity), word detection and score calculation. Pure: no DOM.
import { SIZE, RACK, BINGO, CENTER, LAYOUT } from './config.js';
import { S } from './state.js';

export const wordStr = w => w.map(x => x.t.blank ? x.t.as || '' : x.t.l).join('');

// Validates the pending move. Returns {err} or {words, isNew}.
export function analyze() {
  const m = S.move, B = S.board;
  if (!m.length) return {err: 'ضع قطعة واحدة على الأقل.'};
  const rows = new Set(m.map(e => e.r)), cols = new Set(m.map(e => e.c));
  if (rows.size > 1 && cols.size > 1) return {err: 'يجب أن تكون القطع في صف واحد أو عمود واحد.'};
  const horiz = rows.size === 1, line = horiz ? m.map(e => e.c) : m.map(e => e.r);
  for (let k = Math.min(...line); k <= Math.max(...line); k++)
    if (!(horiz ? B[m[0].r][k] : B[k][m[0].c])) return {err: 'لا يجوز ترك فجوات بين القطع الجديدة.'};
  const isNew = (r, c) => m.some(e => e.r === r && e.c === c);
  const first = B.flat().filter(Boolean).length === m.length;
  if (first && !isNew(CENTER, CENTER)) return {err: 'الحركة الأولى يجب أن تغطي مربع «نجمة».'};
  const words = [], seen = new Set();
  const run = (r, c, dr, dc) => {
    while (r - dr >= 0 && c - dc >= 0 && B[r - dr][c - dc]) { r -= dr; c -= dc; }
    const w = [];
    while (r < SIZE && c < SIZE && B[r][c]) { w.push({r, c, t: B[r][c]}); r += dr; c += dc; }
    return w;
  };
  for (const e of m) for (const [dr, dc] of [[0, 1], [1, 0]]) {
    const w = run(e.r, e.c, dr, dc);
    if (w.length < 2) continue;
    const key = w[0].r + ',' + w[0].c + ',' + dr;
    if (!seen.has(key)) { seen.add(key); words.push(w); }
  }
  if (!words.length) return {err: 'يجب تكوين كلمة من حرفين أو أكثر.'};
  if (!first && !words.some(w => w.some(x => !isNew(x.r, x.c)))) return {err: 'يجب أن تتصل الحركة بقطع موجودة على اللوح.'};
  return {words, isNew};
}

// Returns {list: [{w, pts}], bingo, total}
export function scoreWords(words, isNew, tilesPlaced) {
  const list = [];
  for (const w of words) {
    let sum = 0, mul = 1;
    for (const x of w) {
      let v = x.t.blank ? 0 : x.t.v;
      if (isNew(x.r, x.c)) {
        const k = LAYOUT[x.r][x.c];
        if (k === 1) v *= 2; else if (k === 2) v *= 3;
        if (k === 3 || k === 5) mul *= 2; else if (k === 4) mul *= 3;
      }
      sum += v;
    }
    list.push({w: wordStr(w), pts: sum * mul});
  }
  const bingo = tilesPlaced === RACK;
  return {list, bingo, total: list.reduce((s, x) => s + x.pts, 0) + (bingo ? BINGO : 0)};
}
