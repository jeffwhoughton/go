/* app.js — screens, game flow, AI turns, persistence */
'use strict';

const $ = id => document.getElementById(id);
const KOMI = 7.5;
/* Even when the engine answers instantly, let White's move land at a human
   pace rather than appearing the moment the stone is released. */
const MIN_AI_THINK_MS = 500;

const S = {
  size: 19, levelIdx: 16, net: null, game: null, view: null, revView: null,
  search: null, thinking: false, thinkText: '', over: false,
  est: null, overlay: null, ready: false, recorded: false, endedAt: null,
  gen: 0,                    // bumped per game; stale async results are dropped
};

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fmt = v => (Math.round(v * 10) / 10).toFixed(1);
const levelLabel = i => `${LEVELS[i].rank} — ${LEVELS[i].name}`;

function show(screen) {
  for (const id of ['menu', 'game', 'history', 'review']) $(id).classList.toggle('hidden', id !== screen);
}

/* ================================ MENU ================================ */
function buildMenu() {
  const saved = Store.settings();
  S.size = saved.size;
  S.levelIdx = levelIndexById(saved.levelId, levelIndexById('1d', 0));

  const sel = $('level-select');
  sel.innerHTML = LEVELS.map((lv, i) =>
    `<option value="${i}">${lv.rank} — ${lv.name}</option>`).join('');
  sel.value = String(S.levelIdx);
  sel.onchange = () => { S.levelIdx = +sel.value; saveSettings(); };

  [...$('size-seg').children].forEach(c => c.classList.toggle('on', +c.dataset.size === S.size));
  $('size-seg').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    S.size = +b.dataset.size;
    saveSettings();
    [...$('size-seg').children].forEach(c => c.classList.toggle('on', c === b));
  };

  refreshResumeButton();
}

function saveSettings() { Store.saveSettings(S.size, LEVELS[S.levelIdx].id); }

function refreshResumeButton() {
  const c = Store.loadCurrent();
  const btn = $('resume-btn');
  if (c) {
    btn.textContent = `Resume ${c.size}×${c.size} game (${c.moves.length} moves)`;
    btn.disabled = !S.ready;
    btn.classList.remove('hidden');
    $('start-btn').classList.remove('primary');
  } else {
    btn.classList.add('hidden');
    $('start-btn').classList.add('primary');
  }
}

/* ============================ ENGINE BOOT ============================ */
async function boot() {
  const st = $('engine-status');
  S.net = new KataNet('model/model.json');
  try {
    await S.net.init(m => st.textContent = m);
    st.textContent = `Ready — ${S.net.backend.toUpperCase()} · works offline`;
    st.classList.add('ready');
    $('start-btn').disabled = false;
    $('resume-btn').disabled = false;
    S.ready = true;
  } catch (e) {
    console.error(e);
    st.textContent = 'Engine failed to start: ' + e.message;
  }
}

/* ================================ GAME ================================ */
function ensureView() {
  if (!S.view) S.view = new BoardView($('board'), onHumanPlay);
}

function newGame(saved) {
  ensureView();
  S.game = new Game(saved ? saved.size : S.size, KOMI);
  if (saved) {
    S.levelIdx = levelIndexById(Store.readLevelId(saved, LEVELS[S.levelIdx].id), S.levelIdx);
    for (const loc of saved.moves) if (!S.game.play(loc)) break;
  }
  S.over = false; S.overlay = null; S.est = null; S.recorded = false; S.endedAt = null;
  S.thinking = false; S.search = null;
  S.gen++;

  show('game');
  $('banner').classList.add('hidden');
  $('actions-play').classList.remove('hidden');
  $('actions-over').classList.add('hidden');
  $('tag-white').textContent = LEVELS[S.levelIdx].rank;

  S.view.size = S.game.size;
  S.view.overlay = null;
  S.view.px = 0;
  requestAnimationFrame(() => S.view.layout());
  refresh();
  persist();
  if (S.game.over) { endByPasses(); return; }
  updateEstimate().then(() => { if (!S.over && S.game.toMove === WHITE) aiTurn(); });
}

function persist() {
  if (S.over || S.game.over) Store.clearCurrent();
  else Store.saveCurrent(S.game, LEVELS[S.levelIdx].id);
}

/* last move played by `color`, or null */
function lastMoveOf(color) {
  const mv = S.game.moves;
  for (let i = mv.length - 1; i >= 0; i--) if (mv[i].color === color) return mv[i];
  return null;
}

function refresh() {
  const g = S.game;
  S.view.size = g.size;
  S.view.board = g.board;
  S.view.ghostColor = g.toMove;
  const lm = g.lastMove();
  S.view.lastMove = lm && lm.loc >= 0 ? lm.loc : null;
  S.view.interactive = !S.over && !S.thinking && g.toMove === BLACK;
  S.view.overlay = S.overlay;
  S.view.render();

  $('card-black').classList.toggle('active', !S.over && g.toMove === BLACK);
  $('card-white').classList.toggle('active', !S.over && g.toMove === WHITE);
  $('sub-black').textContent = plural(g.prisoners[BLACK], 'prisoner');
  const wsub = $('sub-white');
  if (S.thinking) { wsub.textContent = S.thinkText || 'thinking…'; wsub.classList.add('thinking'); }
  else { wsub.textContent = plural(g.prisoners[WHITE], 'prisoner'); wsub.classList.remove('thinking'); }

  const wLast = lastMoveOf(WHITE), bLast = lastMoveOf(BLACK);
  togglePill($('pass-white'), !!wLast && wLast.loc === PASS);
  togglePill($('pass-black'), !!bLast && bLast.loc === PASS);

  if (S.est) {
    $('score-black').textContent = fmt(S.est.black);
    $('score-white').textContent = fmt(S.est.white);
  } else { $('score-black').textContent = '—'; $('score-white').textContent = '—'; }

  $('btn-undo').disabled = S.over || g.moves.length === 0;
}

function togglePill(el, on) {
  if (on && el.classList.contains('hidden')) {
    el.classList.remove('hidden');
    el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
  } else if (!on) el.classList.add('hidden');
}

/* Ownership -> estimated territory + prisoners, the same quantity the game is
   scored with at the end.  Each point contributes only as far as the network is
   confident about it, so an unsettled board sits near zero for both players and
   the estimate converges on the exact count as territory closes.
     empty point   -> |ownership| to whoever it favours
     enemy stone   -> 2 points if it looks dead (its point, plus the prisoner)
     own stone     -> nothing
   Below OWN_DEADBAND the point counts for nobody: the network holds faint
   opinions about every intersection, and on a 19x19 those add up to a dozen
   phantom points on an empty board. */
const OWN_DEADBAND = 0.15;
const confidence = o => {
  const a = Math.abs(o);
  return a <= OWN_DEADBAND ? 0 : (a - OWN_DEADBAND) / (1 - OWN_DEADBAND);
};

async function updateEstimate() {
  const g = S.game, gen = S.gen, atMove = g.moves.length;
  if (S.over) return;
  try {
    const ev = await S.net.evaluate(g);
    // a new game, an undo or a further move may have landed while we waited
    if (gen !== S.gen || g !== S.game || atMove !== g.moves.length || S.over) return;
    const sign = (g.toMove === BLACK) ? 1 : -1;
    let b = 0, w = 0;
    for (let i = 0; i < ev.own.length; i++) {
      const o = sign * ev.own[i];              // +1 = Black owns, -1 = White owns
      const v = confidence(o);                 // 0 until the point is really settled
      if (v === 0) continue;
      const c = g.board[i];
      if (c === EMPTY) { if (o > 0) b += v; else w += v; }
      else if (c === WHITE) { if (o > 0) b += 2 * v; }   // white stone looking dead
      else if (o < 0) w += 2 * v;                        // black stone looking dead
    }
    S.est = { black: b + g.prisoners[BLACK], white: w + g.prisoners[WHITE] + g.komi };
    refresh();
  } catch (e) { console.warn(e); }
}

/* ================================ MOVES ================================ */
async function onHumanPlay(loc) {
  const g = S.game;
  if (S.over || S.thinking || g.toMove !== BLACK) return;
  if (!g.play(loc)) { flash(); return; }
  refresh(); persist();
  if (g.over) return endByPasses();
  await updateEstimate();
  aiTurn();
}

function flash() {
  $('board').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' },
                      { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 160 });
}

async function aiTurn() {
  const g = S.game;
  if (S.over || g.toMove !== WHITE) return;
  S.thinking = true; S.thinkText = 'thinking…';
  refresh();
  const level = LEVELS[S.levelIdx];
  const search = new Search(S.net, g);
  S.search = search;
  const startedAt = performance.now();
  let out;
  try {
    out = await search.run(level, (done, total) => {
      S.thinkText = `thinking… ${done}/${total}`;
      const el = $('sub-white'); if (el) el.textContent = S.thinkText;
    });
  } catch (e) { console.error(e); S.thinking = false; refresh(); return; }
  const spent = performance.now() - startedAt;
  if (spent < MIN_AI_THINK_MS) await new Promise(r => setTimeout(r, MIN_AI_THINK_MS - spent));
  if (search.cancelled || S.search !== search) return;   // undo may have landed during the pause
  S.thinking = false; S.search = null;

  if (!g.play(out.move)) {                 // superko or other rejection
    const root = out.root;
    const order = [...root.moves.keys()].sort((a, b) => (root.N[b] - root.N[a]) || (root.P[b] - root.P[a]));
    let done = false;
    for (const k of order) if (g.play(root.moves[k])) { done = true; break; }
    if (!done) g.play(PASS);
  }
  refresh(); persist();
  if (g.over) return endByPasses();
  await updateEstimate();
}

/* =============================== ENDINGS =============================== */
async function endByPasses() {
  S.thinking = true; S.thinkText = 'counting…'; refresh();
  const g = S.game;
  const ev = await S.net.evaluate(g);
  const sign = (g.toMove === BLACK) ? 1 : -1;
  const dead = new Uint8Array(g.pos.n);
  for (let i = 0; i < g.pos.n; i++) {
    const c = g.board[i];
    if (!c) continue;
    const ownBlack = sign * ev.own[i];
    if (c === BLACK && ownBlack < -0.3) dead[i] = 1;
    if (c === WHITE && ownBlack > 0.3) dead[i] = 1;
  }
  const sc = scoreTerritory(g.pos, dead, g.komi, g.prisoners);
  S.thinking = false;
  S.overlay = { area: sc.area, dead };
  S.est = { black: sc.black, white: sc.white };
  const winner = sc.diff > 0 ? 'B' : 'W';
  finish({ winner, reason: 'score', by: Math.abs(sc.diff), black: sc.black, white: sc.white },
         Array.from(dead).join(''));
}

function resultText(r) {
  const who = r.winner === 'B' ? 'Black' : 'White';
  if (r.reason === 'resign') return `<b>${who} wins</b> — ${r.winner === 'B' ? 'White' : 'Black'} resigned`;
  return `<b>${who} wins</b> by ${fmt(r.by)} — ${fmt(r.black)} vs ${fmt(r.white)}`;
}

function finish(result, deadStr) {
  S.over = true;
  S.endedAt = Date.now();
  $('banner').innerHTML = resultText(result);
  $('banner').classList.remove('hidden');
  $('actions-play').classList.add('hidden');
  $('actions-over').classList.remove('hidden');
  refresh();
  if (!S.recorded) {
    S.recorded = true;
    Store.addMatch({
      id: 'm' + S.endedAt,
      ts: S.endedAt,
      size: S.game.size,
      komi: S.game.komi,
      levelId: LEVELS[S.levelIdx].id,
      levelLabel: levelLabel(S.levelIdx),
      moves: S.game.moves.map(m => m.loc),
      prisoners: [S.game.prisoners[BLACK], S.game.prisoners[WHITE]],
      result,
      dead: deadStr || null,
    });
  }
  Store.clearCurrent();
  refreshResumeButton();
}

/* =============================== HISTORY =============================== */
function renderHistory() {
  const list = $('hist-list');
  const h = Store.history();
  if (!h.length) {
    list.innerHTML = `<p class="empty">No finished matches yet.<br>
      <span class="dimmer">Games shorter than ${Store.MIN_MOVES_TO_KEEP} moves are not kept.</span></p>`;
    return;
  }
  list.innerHTML = h.map((m, i) => {
    const won = m.result.winner === 'B';
    const detail = m.result.reason === 'resign'
      ? `${won ? 'Black' : 'White'} by resignation`
      : `${won ? 'Black' : 'White'} +${fmt(m.result.by)}`;
    return `<button class="hist-row" data-i="${i}">
      <span class="hist-stone ${won ? 'black' : 'white'}"></span>
      <span class="hist-main">
        <span class="hist-top">${detail}</span>
        <span class="hist-bot">${m.size}×${m.size} · ${m.levelLabel} · ${m.moves.length} moves</span>
      </span>
      <span class="hist-when">${when(m.ts)}</span>
    </button>`;
  }).join('');
  list.onclick = e => {
    const row = e.target.closest('.hist-row');
    if (row) openReview(Store.history()[+row.dataset.i]);
  };
}

function when(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${date}<br><span class="dimmer">${time}</span>`;
}

/* =============================== REVIEW =============================== */
const REV = { match: null, at: 0, positions: null };

function openReview(m) {
  if (!m) return;
  REV.match = m;
  // replay once, keeping a snapshot of every position
  const g = new Game(m.size, m.komi ?? KOMI);
  const snaps = [g.pos.clone()];
  for (const loc of m.moves) { if (!g.play(loc)) break; snaps.push(g.pos.clone()); }
  REV.positions = snaps;
  REV.at = snaps.length - 1;

  $('rev-title').textContent = `${m.size}×${m.size} · ${new Date(m.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  const r = m.result;
  const who = r.winner === 'B' ? 'Black' : 'White';
  const line = r.reason === 'resign'
    ? `${who} wins — ${r.winner === 'B' ? 'White' : 'Black'} resigned`
    : `${who} wins by ${fmt(r.by)} · ${fmt(r.black)} vs ${fmt(r.white)}`;
  $('rev-meta').innerHTML =
    `<div class="rev-result">${line}</div>
     <div class="rev-sub">${m.levelLabel} · komi ${m.komi ?? KOMI} ·
       prisoners ${m.prisoners ? m.prisoners[0] : 0}–${m.prisoners ? m.prisoners[1] : 0} ·
       ${new Date(m.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>`;

  const range = $('rev-range');
  range.min = 0; range.max = String(snaps.length - 1); range.value = String(REV.at);

  show('review');
  if (!S.revView) S.revView = new BoardView($('rev-board'), () => {});
  S.revView.interactive = false;
  S.revView.size = m.size;
  S.revView.px = 0;
  requestAnimationFrame(() => { S.revView.layout(); drawReview(); });
  drawReview();
}

function drawReview() {
  const m = REV.match, v = S.revView;
  if (!m || !v) return;
  const pos = REV.positions[REV.at];
  v.size = m.size;
  v.board = pos.board;
  v.lastMove = REV.at > 0 && m.moves[REV.at - 1] >= 0 ? m.moves[REV.at - 1] : null;
  const atEnd = REV.at === REV.positions.length - 1;
  if (atEnd && m.dead && m.dead.length === m.size * m.size) {
    const dead = Uint8Array.from(m.dead, ch => ch === '1' ? 1 : 0);
    v.overlay = { area: scoreTerritory(pos, dead, m.komi ?? KOMI, pos.prisoners).area, dead };
  } else v.overlay = null;
  v.render();
  $('rev-range').value = String(REV.at);
  const mv = REV.at > 0 ? m.moves[REV.at - 1] : null;
  const label = REV.at === 0 ? 'start'
    : (mv === -1 ? 'pass' : coord(mv, m.size));
  $('rev-counter').textContent = `${REV.at} / ${REV.positions.length - 1} · ${label}`;
}

const GTP_LETTERS = 'ABCDEFGHJKLMNOPQRST';
function coord(loc, size) {
  if (loc < 0) return 'pass';
  return GTP_LETTERS[loc % size] + (size - ((loc / size) | 0));
}

function revGo(to) {
  REV.at = Math.max(0, Math.min(REV.positions.length - 1, to));
  drawReview();
}

/* =============================== CONTROLS =============================== */
function wireControls() {
  $('start-btn').onclick = () => { if (S.ready) { Store.clearCurrent(); newGame(null); } };
  $('resume-btn').onclick = () => { if (S.ready) { const c = Store.loadCurrent(); if (c) newGame(c); } };
  $('history-btn').onclick = () => { renderHistory(); show('history'); };
  $('hist-back').onclick = () => { refreshResumeButton(); show('menu'); };
  $('hist-clear').onclick = () => openModal('Clear match history?',
    'All saved matches will be deleted. This cannot be undone.', 'Clear',
    () => { Store.clearHistory(); renderHistory(); });
  $('rev-back').onclick = () => { renderHistory(); show('history'); };
  $('rev-range').oninput = e => revGo(+e.target.value);
  $('rev-first').onclick = () => revGo(0);
  $('rev-prev').onclick = () => revGo(REV.at - 1);
  $('rev-next').onclick = () => revGo(REV.at + 1);
  $('rev-last').onclick = () => revGo(REV.positions.length - 1);

  $('btn-menu').onclick = () => { refreshResumeButton(); show('menu'); };
  $('btn-rematch').onclick = () => newGame(null);

  $('btn-pass').onclick = async () => {
    if (S.over || S.thinking || S.game.toMove !== BLACK) return;
    S.game.play(PASS);
    refresh(); persist();
    if (S.game.over) return endByPasses();
    await updateEstimate();
    aiTurn();
  };

  $('btn-undo').onclick = async () => {
    const g = S.game;
    if (S.over) return;
    if (S.thinking && S.search) { S.search.cancelled = true; S.search = null; S.thinking = false; }
    let undone = 0;
    while (g.moves.length > 0) {
      g.undo(); undone++;
      if (g.toMove === BLACK) break;
    }
    if (!undone) return;
    S.overlay = null;
    refresh(); persist();
    await updateEstimate();
  };

  $('btn-resign').onclick = () => {
    if (S.over || S.game.toMove !== BLACK) return;
    openModal('Are you sure?', 'Resigning ends the game immediately.', 'Resign', () => {
      if (S.search) S.search.cancelled = true;
      S.thinking = false;
      finish({ winner: 'W', reason: 'resign', by: null,
               black: S.est ? S.est.black : 0, white: S.est ? S.est.white : 0 }, null);
    });
  };

  $('modal-cancel').onclick = closeModal;
}

let modalCb = null;
function openModal(title, body, okLabel, cb) {
  $('modal-title').textContent = title;
  $('modal-body').textContent = body;
  $('modal-ok').textContent = okLabel;
  modalCb = cb;
  $('modal').classList.remove('hidden');
  $('modal-ok').onclick = () => { const f = modalCb; closeModal(); if (f) f(); };
}
function closeModal() { $('modal').classList.add('hidden'); modalCb = null; }

/* ================================ START ================================ */
window.addEventListener('load', () => {
  buildMenu();
  wireControls();
  window.addEventListener('resize', () => {
    if (S.view && !$('game').classList.contains('hidden')) S.view.layout();
    if (S.revView && !$('review').classList.contains('hidden')) S.revView.layout();
  });
  boot();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});

/* keep the in-progress game safe if the app is backgrounded or killed */
document.addEventListener('visibilitychange', () => { if (document.hidden && S.game && !S.over) persist(); });
window.addEventListener('pagehide', () => { if (S.game && !S.over) persist(); });
