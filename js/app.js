/* app.js — screens, game flow, AI turns */
'use strict';

const $ = id => document.getElementById(id);
const KOMI = 7.5;

const S = {
  size: 19, levelIdx: 7, net: null, game: null, view: null,
  search: null, thinking: false, over: false, result: null,
  est: null, overlay: null, ready: false,
};

/* ---------------- menu ---------------- */
function buildMenu() {
  const list = $('level-list');
  list.innerHTML = '';
  LEVELS.forEach((lv, i) => {
    const b = document.createElement('button');
    b.className = 'lvl' + (i === S.levelIdx ? ' on' : '');
    const filled = Math.max(1, Math.round((i + 1) / LEVELS.length * 5));
    b.innerHTML = `<span class="dots">${[0,1,2,3,4].map(d =>
        `<span class="dot${d < filled ? ' f' : ''}"></span>`).join('')}</span>
      <span class="nm">${lv.name}</span><span class="rk">${lv.rank}</span>`;
    b.onclick = () => {
      S.levelIdx = i;
      localStorage.setItem('go.level', i);
      [...list.children].forEach(c => c.classList.remove('on'));
      b.classList.add('on');
    };
    list.appendChild(b);
    if (i === S.levelIdx) setTimeout(() => b.scrollIntoView({ block: 'nearest' }), 0);
  });
  $('size-seg').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    S.size = +b.dataset.size;
    localStorage.setItem('go.size', S.size);
    [...$('size-seg').children].forEach(c => c.classList.toggle('on', c === b));
  };
  const savedSize = +localStorage.getItem('go.size');
  if (savedSize) {
    S.size = savedSize;
    [...$('size-seg').children].forEach(c => c.classList.toggle('on', +c.dataset.size === savedSize));
  }
}

/* ---------------- engine boot ---------------- */
async function boot() {
  const st = $('engine-status');
  S.net = new KataNet('model/model.json');
  try {
    await S.net.init(m => st.textContent = m);
    st.textContent = `Ready — ${S.net.backend.toUpperCase()} · works offline`;
    st.classList.add('ready');
    $('start-btn').disabled = false;
    S.ready = true;
  } catch (e) {
    console.error(e);
    st.textContent = 'Engine failed to start: ' + e.message;
  }
}

/* ---------------- game ---------------- */
function newGame() {
  S.game = new Game(S.size, KOMI);
  S.over = false; S.result = null; S.overlay = null; S.est = null;
  $('menu').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('banner').classList.add('hidden');
  $('actions-play').classList.remove('hidden');
  $('actions-over').classList.add('hidden');
  $('tag-white').textContent = LEVELS[S.levelIdx].name;
  if (!S.view) {
    S.view = new BoardView($('board'), onHumanPlay);
    window.addEventListener('resize', () => S.view.layout());
  }
  S.view.size = S.size;
  S.view.overlay = null;
  S.view._wood = null;
  S.view.px = 0;
  requestAnimationFrame(() => S.view.layout());
  refresh();
  updateEstimate();
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

  if (S.est) {
    $('score-black').textContent = fmt(S.est.black);
    $('score-white').textContent = fmt(S.est.white);
  } else { $('score-black').textContent = '—'; $('score-white').textContent = '—'; }

  $('btn-undo').disabled = S.over || g.moves.length === 0;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fmt = v => (Math.round(v * 10) / 10).toFixed(1);

/* ownership -> per-player estimated area (black perspective) */
async function updateEstimate() {
  const g = S.game;
  if (S.over) return;
  try {
    const ev = await S.net.evaluate(g);
    const sign = (g.toMove === BLACK) ? 1 : -1;
    let b = 0;
    for (let i = 0; i < ev.own.length; i++) b += (1 + sign * ev.own[i]) / 2;
    const total = g.size * g.size;
    S.est = { black: b, white: total - b + g.komi };
    refresh();
  } catch (e) { console.warn(e); }
}

/* ---------------- moves ---------------- */
async function onHumanPlay(loc) {
  const g = S.game;
  if (S.over || S.thinking || g.toMove !== BLACK) return;
  if (!g.play(loc)) { flash(); return; }
  refresh();
  if (g.over) return endByPasses();
  await updateEstimate();
  aiTurn();
}

function flash() {
  const c = $('board');
  c.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' },
             { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 160 });
}

async function aiTurn() {
  const g = S.game;
  if (S.over || g.toMove !== WHITE) return;
  S.thinking = true;
  S.thinkText = 'thinking…';
  refresh();
  const level = LEVELS[S.levelIdx];
  const search = new Search(S.net, g);
  S.search = search;
  let out;
  try {
    out = await search.run(level, (done, total) => {
      S.thinkText = `thinking… ${done}/${total}`;
      const el = $('sub-white');
      if (el) el.textContent = S.thinkText;
    });
  } catch (e) { console.error(e); S.thinking = false; refresh(); return; }
  if (search.cancelled || S.search !== search) { return; }
  S.thinking = false; S.search = null;

  let mv = out.move;
  if (!g.play(mv)) {                       // superko or other rejection: try alternatives
    const root = out.root, order = [];
    for (let k = 0; k < root.moves.length; k++) order.push(k);
    order.sort((a, b) => (root.N[b] - root.N[a]) || (root.P[b] - root.P[a]));
    let done = false;
    for (const k of order) { if (g.play(root.moves[k])) { done = true; break; } }
    if (!done) g.play(PASS);
  }
  refresh();
  if (g.over) return endByPasses();
  await updateEstimate();
}

/* ---------------- endings ---------------- */
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
  const sc = scoreArea(g.pos, dead, g.komi);
  S.thinking = false;
  S.overlay = { area: sc.area, dead };
  S.est = { black: sc.black, white: sc.white };
  const win = sc.diff > 0 ? 'Black' : 'White';
  const by = Math.abs(sc.diff);
  finish(`<b>${win} wins</b> by ${fmt(by)} — ${fmt(sc.black)} vs ${fmt(sc.white)}`);
}

function finish(html) {
  S.over = true;
  $('banner').innerHTML = html;
  $('banner').classList.remove('hidden');
  $('actions-play').classList.add('hidden');
  $('actions-over').classList.remove('hidden');
  refresh();
}

/* ---------------- controls ---------------- */
function wireControls() {
  $('start-btn').onclick = () => { if (S.ready) newGame(); };
  $('btn-menu').onclick = () => {
    $('game').classList.add('hidden');
    $('menu').classList.remove('hidden');
  };
  $('btn-rematch').onclick = () => newGame();

  $('btn-pass').onclick = async () => {
    if (S.over || S.thinking || S.game.toMove !== BLACK) return;
    S.game.play(PASS);
    refresh();
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
      if (g.toMove === BLACK) break;            // back to the human's turn
    }
    if (!undone) return;
    S.overlay = null;
    refresh();
    await updateEstimate();
  };

  $('btn-resign').onclick = () => {
    if (S.over || S.game.toMove !== BLACK) return;
    openModal('Are you sure?', 'Resigning ends the game immediately.', 'Resign', () => {
      if (S.search) S.search.cancelled = true;
      S.thinking = false;
      finish('<b>White wins</b> — Black resigned');
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

/* ---------------- start ---------------- */
window.addEventListener('load', () => {
  const lv = localStorage.getItem('go.level');
  if (lv !== null && LEVELS[+lv]) S.levelIdx = +lv;
  buildMenu();
  wireControls();
  boot();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});
