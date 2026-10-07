// All user input: click/tap selection, keyboard, native drag & drop, buttons and dialog listeners.
// (Touch devices use the tap-to-select flow through the delegated click handler.)
import { $, S, app, BY, inMove, cur } from './state.js';
import { toast, fail, ask, render, chooseDuration, takeDialogCallbacks } from './ui.js';
import { place, unplace, submit, doSwap, pass, undo, startSwap, cancelSwapOrMove, newGame } from './game.js';
import { openJudge, onJudgeClick, abortJudge } from './judge.js';
import { startNewGameAudio, playSFX } from './audio.js';

function onSquare(r, c) {
  if (S.ended || S.swap) return;
  const t = S.board[r][c];
  if (t) {
    const e = inMove(t);
    if (!e) return fail('هذه القطعة مثبتة ولا يمكن تحريكها.');
    if (S.pick === t) { unplace(e); S.pick = null; } else { S.pick = t; playSFX('tile-select'); }
    return render();
  }
  if (S.pick) place(S.pick, r, c); else toast('اختر قطعة من رفّك.', true);
}
function onSlot(p, i) {
  if (S.ended) return;
  if (p !== S.cur) return fail('هذا رفّ الخصم — ليس دورك الآن.');
  const t = cur().rack[i];
  if (S.swap) {
    if (!t) return;
    if (S.sel.has(t)) { S.sel.delete(t); playSFX('tile-cancel'); }
    else { S.sel.add(t); playSFX('tile-select'); }
    return render();
  }
  if (t) {
    if (S.pick === t) S.pick = null;
    else { S.pick = t; playSFX('tile-select'); }
  }
  else if (S.pick && inMove(S.pick)) { unplace(inMove(S.pick)); S.pick = null; }
  render();
}

function bindBoardInput() {
  document.addEventListener('click', e => {
    const sq = e.target.closest('.sq'), sl = e.target.closest('.slot');
    if (sq) onSquare(+sq.dataset.r, +sq.dataset.c); else if (sl) onSlot(+sl.dataset.p, +sl.dataset.i);
  });
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.sq,.tile')) { e.preventDefault(); (e.target.closest('.slot') || e.target.closest('.sq') || e.target).click(); }
    if (e.key === 'Escape' && S.pick) { S.pick = null; playSFX('tile-cancel'); render(); }
  });
  document.addEventListener('dragstart', e => {
    // Native HTML drag is unreliable on touchscreens and can swallow the tap/long-press gesture.
    if (window.matchMedia('(pointer: coarse)').matches) return e.preventDefault();
    const el = e.target.closest && e.target.closest('.tile'), t = el && BY[el.dataset.id];
    if (!t || el.classList.contains('dim') || S.ended || S.swap) return e.preventDefault();
    S.drag = t; S.pick = null; e.dataTransfer.setData('text/plain', el.dataset.id); e.dataTransfer.effectAllowed = 'move';
  });
  document.addEventListener('dragover', e => {
    if (!S.drag) return;
    const sq = e.target.closest('.sq'), sl = e.target.closest('.slot');
    if ((sq && !S.board[sq.dataset.r][sq.dataset.c]) || (sl && inMove(S.drag))) e.preventDefault();
  });
  document.addEventListener('drop', e => {
    const t = S.drag; S.drag = null; if (!t) return;
    const sq = e.target.closest('.sq'), sl = e.target.closest('.slot');
    if (sq) { e.preventDefault(); if (!place(t, +sq.dataset.r, +sq.dataset.c)) render(); }
    else if (sl && +sl.dataset.p === S.cur && inMove(t)) { e.preventDefault(); unplace(inMove(t)); render(); }
    else render();
  });
  document.addEventListener('dragend', () => { if (S.drag) { S.drag = null; render(); } });
}

function bindControls() {
  $('#bSubmit').onclick = () => S.swap ? doSwap() : submit();
  $('#bCancel').onclick = cancelSwapOrMove;
  $('#bSwap').onclick = () => { playSFX('button-click'); startSwap(); };
  $('#bPass').onclick = pass;
  $('#bJudge').onclick = () => { playSFX('button-click'); openJudge(); };
  $('#bUndo').onclick = () => { if (S.undo && !S.ended && !S.move.length && !S.swap) ask('تراجع', 'سيُستعاد اللوح والنقاط إلى ما قبل آخر حركة.', 'تراجع', undo); };
  $('#bNew').onclick = () => {
    playSFX('button-click');
    S.ended ? chooseDuration() : ask('لعبة جديدة', 'سيُفقد التقدّم الحالي.', 'ابدأ', chooseDuration);
  };
}

function bindDialogs() {
  $('#jB').addEventListener('click', onJudgeClick);
  $('#jd').addEventListener('close', abortJudge);
  $('#dlg').addEventListener('close', () => {
    S.paused = false; S.last = performance.now();
    const {ok, cancel} = takeDialogCallbacks();
    if ($('#dlg').returnValue === 'ok') { if (ok) ok(); } else if (cancel) cancel();
  });
  $('#bd').addEventListener('close', () => {
    if (!$('#dlg').open && !$('#sd').open) { S.paused = false; S.last = performance.now(); }
    const e = S.pending; if (!e) return;
    S.pending = null;
    if (!S.move.includes(e)) return;
    const L = $('#bd').returnValue;
    if (L) e.t.as = L; else unplace(e);
    render();
  });
  // The very first duration prompt cannot be dismissed with Esc.
  $('#sd').addEventListener('cancel', e => { if (app.firstRun) e.preventDefault(); });
  $('#sd').addEventListener('close', () => {
    const m = +$('#sd').returnValue;
    if (m) ask(
      'بدء اللعبة',
      `${m} دقيقة لكل لاعب`,
      'ابدأ',
      () => {
        app.firstRun = false;
        newGame(m);
        // Cleanly terminate the previous audio session and start the new game's BGM.
        startNewGameAudio();
      },
      chooseDuration,
      'btn'
    );
    else { S.paused = false; S.last = performance.now(); }
  });
}

export function initInput() { bindBoardInput(); bindControls(); bindDialogs(); }
