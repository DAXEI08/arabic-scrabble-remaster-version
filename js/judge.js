// Third-party judging: the challenger (player now on turn) calls named judges who vote
// secretly; a majority rules on the last move.
import { PENALTY, JUDGES_KEY, NAMES } from './config.js';
import { $, S, app, esc, cur, restore } from './state.js';
import { toast, render, chips } from './ui.js';
import { tick, nextTurn } from './game.js';
import { setMusicDucked } from './audio.js';

export function openJudge() {
  const e = S.hist[S.hist.length - 1];
  if (S.ended || S.swap || S.move.length || !S.undo || !e || e.type !== 'move' || e.st) return;
  app.judge = {e, stage: 0, names: [], votes: [], i: 0, ok: false, tally: ''};
  S.paused = true; setMusicDucked(true); renderJudge(); $('#jd').showModal();
}
// Dialog closed without applying a verdict (Esc / cancel): drop the session and resume the clock.
export function abortJudge() {
  if (app.judge) { app.judge = null; setMusicDucked(false); S.paused = false; S.last = performance.now(); }
}
function renderJudge() {
  const J = app.judge, e = J.e, B = $('#jB'), T = $('#jT');
  const head = `<p>${NAMES[e.p]} · الحركة ${e.n} · ${e.total} نقطة</p>${chips(e)}`;
  if (J.stage === 0) {
    T.textContent = 'تحكيم الحركة';
    let saved = []; try { saved = JSON.parse(localStorage.getItem(JUDGES_KEY)) || []; } catch { /* storage unavailable (private mode): fall back to defaults */ }
    B.innerHTML = head + '<p>أدخل ١ أو ٣ أو ٥ حكّام من خارج اللاعبين؛ يصوّت كل حكم سرّاً والأغلبية تحسم.</p>'
      + [0, 1, 2, 3, 4].map(i => `<input maxlength="20" placeholder="اسم الحكم ${i + 1}" aria-label="اسم الحكم ${i + 1}" value="${esc(saved[i] || '')}">`).join('')
      + '<p id="jE" role="alert" style="color:#fca5a5"></p><div class="vrow"><button class="btn main" data-a="start">ابدأ التصويت</button><button class="btn" data-a="close">إلغاء</button></div>';
  } else if (J.stage === 1) {
    T.textContent = 'تصويت الحكّام';
    B.innerHTML = `<p>سلّم الجهاز إلى الحكم <b>${esc(J.names[J.i])}</b> (${J.i + 1}/${J.names.length}) — تصويته سرّي.</p>${chips(e)}`
      + '<div class="vrow"><button class="btn yes" data-a="yes">✔ صحيحة</button><button class="btn danger" data-a="no">✖ غير صحيحة</button></div>';
  } else {
    T.textContent = J.ok ? 'الحكم: الحركة صحيحة ✔' : 'الحكم: الحركة مرفوضة ✖';
    B.innerHTML = head + `<p>${J.votes.map((v, i) => `${esc(J.names[i])}: ${v ? '✔ صحيحة' : '✖ غير صحيحة'}`).join('<br>')}</p>`
      + `<p>${J.ok ? `تبقى النقاط، ويخسر المتحدّي (${NAMES[S.cur]}) ${PENALTY} نقاط.` : `تُلغى الحركة وتعود القطع إلى رفّ ${NAMES[e.p]} ويفقد دوره.`}</p>`
      + '<button class="btn main" data-a="apply">تطبيق الحكم</button>';
  }
}
export function onJudgeClick(ev) {
  const J = app.judge;
  const a = ev.target.closest('[data-a]')?.dataset.a;
  if (!a || !J) return;
  if (a === 'close') return $('#jd').close();
  if (a === 'start') {
    const names = [...$('#jB').querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
    const err = !names.length || names.length % 2 === 0 ? 'أدخل ١ أو ٣ أو ٥ أسماء (عدداً فردياً).'
      : new Set(names.map(n => n.toLowerCase())).size < names.length ? 'يجب أن تكون أسماء الحكّام مختلفة.' : '';
    if (err) { $('#jE').textContent = err; return; }
    try { localStorage.setItem(JUDGES_KEY, JSON.stringify(names)); } catch { /* storage unavailable (private mode): fall back to defaults */ }
    J.names = names; J.stage = 1;
  } else if (a === 'yes' || a === 'no') {
    J.votes.push(a === 'yes');
    const y = J.votes.filter(Boolean).length, n = J.votes.length - y, need = (J.names.length >> 1) + 1;
    if (y >= need || n >= need) { J.ok = y >= need; J.tally = y + '–' + n; J.stage = 2; } else J.i++;
  } else if (a === 'apply') return applyVerdict();
  renderJudge();
}
function applyVerdict() {
  const J = app.judge, e = J.e, ok = J.ok, u = S.undo;
  e.vote = J.tally; e.by = J.names.slice(0, J.votes.length).join('، '); e.st = ok ? 'ok' : 'void';
  app.judge = null; setMusicDucked(false); $('#jd').close(); S.paused = false; S.last = performance.now(); S.hv++;
  if (ok) {
    const ch = cur(); e.pen = Math.min(PENALTY, ch.score); ch.score -= e.pen; S.undo = null; S.pop = S.cur;
    toast(`أقرّ الحكّام الحركة — غرامة ${e.pen} على ${NAMES[S.cur]}`, false); return render();
  }
  tick(); if (S.ended) return;
  restore(u, true);
  toast(`رفض الحكّام الحركة — يفقد ${NAMES[e.p]} دوره`, false); nextTurn();
}
