// All user input: click/tap selection, keyboard, native drag & drop, buttons and dialog listeners.
// (Touch devices use the tap-to-select flow through the delegated click handler.)
import { $, S, app, BY, inMove, cur } from './state.js';
import { toast, fail, ask, render, chooseDuration, takeDialogCallbacks } from './ui.js';
import { place, unplace, submit, doSwap, pass, undo, startSwap, cancelSwapOrMove, newGame } from './game.js';
import { openJudge, onJudgeClick, abortJudge } from './judge.js';
import { startNewGameAudio, playSFX, setMusicDucked } from './audio.js';

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

function clearDropTargets() {
  document.querySelectorAll('.sq.drop,.slot.drop').forEach(el => el.classList.remove('drop'));
}

function markDropTarget(el, valid) {
  if (!el) return;
  el.classList.toggle('drop', Boolean(valid));
}

function canDropOnSquare(sq, t) {
  if (!sq || !t || S.ended || S.swap || !inMove(t) && !cur().rack.includes(t)) return false;
  const r = Number(sq.dataset.r), c = Number(sq.dataset.c);
  return !S.board[r][c];
}

function canDropOnSlot(slot, t) {
  if (!slot || !t || S.ended || S.swap || !inMove(t)) return false;
  return Number(slot.dataset.p) === S.cur;
}

function bindBoardInput() {
  document.addEventListener('click', e => {
    const sq = e.target.closest('.sq'), sl = e.target.closest('.slot');
    if (sq) onSquare(+sq.dataset.r, +sq.dataset.c); else if (sl) onSlot(+sl.dataset.p, +sl.dataset.i);
  });

  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.sq,.tile')) {
      e.preventDefault();
      (e.target.closest('.slot') || e.target.closest('.sq') || e.target).click();
    }
    if (e.key === 'Escape' && S.pick) {
      S.pick = null;
      playSFX('tile-cancel');
      render();
    }
  });

  // Native HTML5 drag-and-drop for desktop/fine-pointer devices.
  // Tap/click selection remains the fallback for touch devices.
  document.addEventListener('dragstart', e => {
    const el = e.target.closest?.('.tile');
    const t = el && BY[el.dataset.id];

    if (!t || el.classList.contains('dim') || S.ended || S.swap || !e.dataTransfer) {
      e.preventDefault();
      return;
    }

    S.drag = t;
    S.pick = null;
    clearDropTargets();

    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(t.id));
    } catch {
      // Some embedded browsers expose a restricted DataTransfer implementation.
      // The in-memory S.drag reference is still sufficient for the drop handler.
    }
  });

  document.addEventListener('dragover', e => {
    if (!S.drag) return;

    const sq = e.target.closest?.('.sq');
    const sl = e.target.closest?.('.slot');
    const validSq = canDropOnSquare(sq, S.drag);
    const validSlot = canDropOnSlot(sl, S.drag);
    const valid = validSq || validSlot;

    clearDropTargets();
    if (valid) {
      e.preventDefault();
      markDropTarget(validSq ? sq : sl, true);
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    }
  });

  document.addEventListener('drop', e => {
    if (!S.drag) return;

    const t = S.drag;
    S.drag = null;
    clearDropTargets();

    const sq = e.target.closest?.('.sq');
    const sl = e.target.closest?.('.slot');

    if (canDropOnSquare(sq, t)) {
      e.preventDefault();
      place(t, Number(sq.dataset.r), Number(sq.dataset.c));
      return;
    }

    if (canDropOnSlot(sl, t)) {
      e.preventDefault();
      unplace(inMove(t));
      render();
      return;
    }

    e.preventDefault();
    render();
  });

  document.addEventListener('dragend', () => {
    S.drag = null;
    clearDropTargets();
    render();
  });
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
    setMusicDucked(false);
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
    else { setMusicDucked(false); S.paused = false; S.last = performance.now(); }
  });
}

let initialized = false;

export function initInput() {
  if (initialized) return;
  initialized = true;
  bindBoardInput();
  bindControls();
  bindDialogs();
}
