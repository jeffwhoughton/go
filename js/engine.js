/* engine.js — KataGo network wrapper + Monte-Carlo tree search */
'use strict';

const softplus = x => x > 20 ? x : Math.log1p(Math.exp(x));

/* Thrown when the network returns something unusable — NaN/Inf, or a policy
   with no spread at all.  A GPU whose context was lost while the app sat in the
   background, or a mobile WebGL backend that quietly drops to half precision,
   can both do this; playing the result anyway produces moves marching along the
   top of the board, because a policy with no information leaves the candidate
   list in raw index order. */
class EngineFault extends Error {
  constructor(msg) { super(msg); this.name = 'EngineFault'; }
}

/* ===================== neural net ====================== */
class KataNet {
  constructor(modelUrl) { this.modelUrl = modelUrl; this.model = null; this.backend = null; this.cache = new Map(); }

  async init(onStatus) {
    const say = onStatus || (() => {});
    say('Starting engine…');
    let ok = false;
    try {
      await tf.setBackend('webgl');
      await tf.ready();
      ok = tf.getBackend() === 'webgl';
    } catch (e) { ok = false; }
    if (!ok) {
      say('No GPU — using WASM…');
      try {
        if (window.tf && tf.wasm && tf.wasm.setWasmPaths) tf.wasm.setWasmPaths('js/vendor/');
        await tf.setBackend('wasm'); await tf.ready();
        ok = tf.getBackend() === 'wasm';
      } catch (e) { ok = false; }
    }
    if (!ok) { await tf.setBackend('cpu'); await tf.ready(); }
    this.backend = tf.getBackend();
    say('Loading network…');
    this.model = await tf.loadGraphModel(this.modelUrl);
    say('Warming up…');
    await this.raw(new Float32Array(NN_AREA * NUM_BIN), new Float32Array(NUM_GLOBAL));
    return this.backend;
  }

  async raw(bin, glob) {
    const a = tf.tensor(bin, [1, NN_AREA, NUM_BIN], 'float32');
    const b = tf.tensor(glob, [1, NUM_GLOBAL], 'float32');
    let out;
    try {
      out = await this.model.executeAsync({ 'swa_model/bin_inputs': a, 'swa_model/global_inputs': b },
        ['swa_model/policy_output', 'swa_model/value_output', 'swa_model/miscvalues_output', 'swa_model/ownership_output']);
      const policy = await out[0].data();     // [1,2,362] -> take first head
      const value = await out[1].data();      // [1,3]
      const misc = await out[2].data();       // [1,10]
      const own = await out[3].data();        // [1,19,19]
      return { policy, value, misc, own };
    } finally {
      a.dispose(); b.dispose();
      if (out) out.forEach(t => t.dispose());
    }
  }

  /* Evaluate a game position.  Returns values from the perspective of the
     player to move: winrate, scoreMean (points), ownership (+1 = mover owns) */
  async evaluate(game, pos) {
    const mv = game.moves, L = mv.length;
    const key = game.pos.hash() + '|' + L + '|' +
      (L ? mv[L - 1].loc : 'x') + ',' + (L > 1 ? mv[L - 2].loc : 'x');
    const hit = this.cache.get(key);
    if (hit) return hit;
    const { bin, glob, pla } = encode(game);
    const r = await this.raw(bin, glob);
    const size = game.size, n = size * size;

    // policy: logits for the mover, index y*19+x, 361 = pass
    const logits = new Float32Array(n + 1);
    for (let i = 0; i < n; i++) {
      const x = i % size, y = (i / size) | 0;
      logits[i] = r.policy[y * NN_LEN + x];
    }
    logits[n] = r.policy[NN_AREA];

    // Refuse to act on a policy that says nothing.  A healthy net spreads its
    // on-board logits over several units; anything flat or non-finite is a
    // backend failure, not a position.
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= n; i++) {
      const p = logits[i];
      if (!Number.isFinite(p)) throw new EngineFault('non-finite policy');
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    if (hi - lo < 1e-4) throw new EngineFault('degenerate policy');

    const v = r.value;
    const mx = Math.max(v[0], v[1], v[2]);
    const e0 = Math.exp(v[0] - mx), e1 = Math.exp(v[1] - mx), e2 = Math.exp(v[2] - mx);
    const s = e0 + e1 + e2;
    const win = e0 / s, loss = e1 / s, noResult = e2 / s;

    const scoreMean = r.misc[0] * 20.0 * (1 - noResult);
    const scoreStdev = softplus(r.misc[1]) * 20.0;
    const lead = r.misc[2] * 20.0 * (1 - noResult);

    // The ownership head emits a raw logit — KataGo's backends return logits and
    // leave the final activations to the client — so squash it into [-1,1] here.
    const own = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i % size, y = (i / size) | 0;
      own[i] = Math.tanh(r.own[y * NN_LEN + x]);
    }
    if (!Number.isFinite(win) || !Number.isFinite(scoreMean)) throw new EngineFault('non-finite value head');
    const res = { logits, win, loss, noResult, scoreMean, scoreStdev, lead, own, pla };
    if (this.cache.size > 1200) this.cache.clear();
    this.cache.set(key, res);
    return res;
  }

  /* One throwaway evaluation on an empty 19x19; true if the net still works. */
  async probe() {
    try {
      const bin = new Float32Array(NN_AREA * NUM_BIN);
      for (let i = 0; i < NN_AREA; i++) bin[i * NUM_BIN] = 1.0;      // whole board on
      const r = await this.raw(bin, new Float32Array(NUM_GLOBAL));
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < NN_AREA; i++) {
        const p = r.policy[i];
        if (!Number.isFinite(p)) return false;
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
      return hi - lo > 1e-3;
    } catch (e) { return false; }
  }

  /* Rebuild after a fault: first a fresh model on the same backend (enough for
     a lost GPU context), then progressively safer backends.  Returns the
     backend now in use, or null if nothing worked. */
  async recover(onStatus) {
    const say = onStatus || (() => {});
    this.cache.clear();
    this.faults = (this.faults || 0) + 1;
    const tryBackend = async (bk) => {
      try {
        if (bk === 'wasm' && window.tf && tf.wasm && tf.wasm.setWasmPaths) tf.wasm.setWasmPaths('js/vendor/');
        await tf.setBackend(bk);
        await tf.ready();
        if (tf.getBackend() !== bk) return false;
        this.model = await tf.loadGraphModel(this.modelUrl);
        if (!(await this.probe())) return false;
        this.backend = bk;
        return true;
      } catch (e) { return false; }
    };
    say('Restarting engine…');
    if (this.faults < 3 && await tryBackend(this.backend)) return this.backend;
    for (const bk of ['wasm', 'cpu']) {
      if (bk === this.backend && this.faults < 3) continue;
      say(`Switching to ${bk.toUpperCase()}…`);
      if (await tryBackend(bk)) return bk;
    }
    return null;
  }
}

/* ===================== search ====================== */
const LEVELS = [
  { id: '30k', rank: '30 kyu', name: 'Acorn',       visits: 1,   temp: 5.0,  rand: 0.60 },
  { id: '27k', rank: '27 kyu', name: 'Sapling',     visits: 1,   temp: 4.2,  rand: 0.50 },
  { id: '25k', rank: '25 kyu', name: 'Fledgling',   visits: 1,   temp: 3.6,  rand: 0.40 },
  { id: '22k', rank: '22 kyu', name: 'Novice',      visits: 1,   temp: 3.0,  rand: 0.32 },
  { id: '20k', rank: '20 kyu', name: 'Apprentice',  visits: 1,   temp: 2.6,  rand: 0.25 },
  { id: '18k', rank: '18 kyu', name: 'Student',     visits: 1,   temp: 2.3,  rand: 0.19 },
  { id: '15k', rank: '15 kyu', name: 'Scout',       visits: 1,   temp: 2.0,  rand: 0.14 },
  { id: '13k', rank: '13 kyu', name: 'Journeyman',  visits: 1,   temp: 1.8,  rand: 0.10 },
  { id: '11k', rank: '11 kyu', name: 'Artisan',     visits: 1,   temp: 1.6,  rand: 0.07 },
  { id: '9k',  rank: '9 kyu',  name: 'Skirmisher',  visits: 1,   temp: 1.4,  rand: 0.05 },
  { id: '8k',  rank: '8 kyu',  name: 'Duelist',     visits: 1,   temp: 1.3,  rand: 0.04 },
  { id: '7k',  rank: '7 kyu',  name: 'Tactician',   visits: 1,   temp: 1.2,  rand: 0.03 },
  { id: '6k',  rank: '6 kyu',  name: 'Strategist',  visits: 1,   temp: 1.1,  rand: 0.022 },
  { id: '5k',  rank: '5 kyu',  name: 'Veteran',     visits: 1,   temp: 1.0,  rand: 0.015 },
  { id: '4k',  rank: '4 kyu',  name: 'Clubmaster',  visits: 2,   temp: 0.95, rand: 0 },
  { id: '3k',  rank: '3 kyu',  name: 'Adept',       visits: 4,   temp: 0.85, rand: 0 },
  { id: '2k',  rank: '2 kyu',  name: 'Contender',   visits: 6,   temp: 0.70, rand: 0 },
  { id: '1k',  rank: '1 kyu',  name: 'Challenger',  visits: 10,  temp: 0.60, rand: 0 },
  { id: '1d',  rank: '1 dan',  name: 'Shodan',      visits: 20,  temp: 0.40, rand: 0 },
  { id: '2d',  rank: '2 dan',  name: 'Nidan',       visits: 40,  temp: 0.28, rand: 0 },
  { id: '3d',  rank: '3 dan',  name: 'Sandan',      visits: 80,  temp: 0.18, rand: 0 },
  { id: '4d',  rank: '4 dan',  name: 'Yondan',      visits: 160, temp: 0.10, rand: 0 },
  { id: '5d',  rank: '5 dan',  name: 'Godan',       visits: 300, temp: 0.05, rand: 0 },
  { id: 'max', rank: 'max strength', name: 'Sensei', visits: 800, temp: 0,   rand: 0 },
];

/* Levels are addressed by their stable id so that inserting a rung never
   silently changes a remembered or in-progress setting. */
function levelIndexById(id, fallback) {
  const i = LEVELS.findIndex(l => l.id === id);
  return i >= 0 ? i : (fallback === undefined ? -1 : fallback);
}

const CPUCT = 1.1, FPU = 0.25, SCORE_UTILITY = 0.30;

class Node {
  constructor(pos, ev, scoreScale, cand) {
    this.pos = pos;
    this.moves = cand;                       // Int32Array of candidate moves (-1 = pass)
    this.P = new Float32Array(cand.length);
    this.N = new Int32Array(cand.length);
    this.W = new Float64Array(cand.length);
    this.child = new Array(cand.length).fill(null);
    this.totalN = 0;
    this.ev = ev;
    this.value = (ev.win - ev.loss) + SCORE_UTILITY * Math.tanh(ev.scoreMean / scoreScale);
  }
}

class Search {
  constructor(net, game) { this.net = net; this.game = game; this.cancelled = false; }

  _candidates(game, pos, ev, allowPass, maxCand) {
    const size = game.size, n = size * size;
    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    // Never let a bad comparator leave the list in index order — that is what
    // turns a broken evaluation into stones marching along the top edge.
    const key = i => (Number.isFinite(ev.logits[i]) ? ev.logits[i] : -1e30);
    order.sort((a, b) => (key(b) - key(a)) || (a - b));
    const cand = [];
    const c = pos.toMove;
    for (const i of order) {
      if (cand.length >= maxCand) break;
      if (!pos.isLegal(i, c)) continue;
      if (pos.isSimpleEye(i, c)) {            // never fill our own eye
        continue;
      }
      cand.push(i);
    }
    if (allowPass || cand.length === 0) cand.push(-1);
    return cand;
  }

  _makeNode(game, pos, ev, opts, isRoot) {
    const cand = this._candidates(game, pos, ev, isRoot ? opts.allowPass : false, opts.maxCand);
    const node = new Node(pos, ev, opts.scoreScale, cand);
    // softmax the priors over the candidate set
    let mx = -1e30;
    for (const m of cand) { const l = ev.logits[m === -1 ? game.size * game.size : m]; if (l > mx) mx = l; }
    let sum = 0;
    for (let k = 0; k < cand.length; k++) {
      const m = cand[k];
      const l = ev.logits[m === -1 ? game.size * game.size : m];
      const e = Math.exp((l - mx));
      node.P[k] = e; sum += e;
    }
    for (let k = 0; k < cand.length; k++) node.P[k] /= sum;
    return node;
  }

  async run(level, onProgress) {
    const game = this.game, size = game.size, area = size * size;
    const scoreScale = Math.sqrt(area);
    const rootEv = await this.net.evaluate(game);
    const opts = {
      scoreScale,
      maxCand: size >= 19 ? 36 : size >= 13 ? 28 : 24,
      allowPass: this._passAllowed(game, rootEv),
    };
    const root = this._makeNode(game, game.pos.clone(), rootEv, opts, true);

    const visits = level.visits;
    const budgetMs = level.visits <= 1 ? 0 : (size >= 19 ? 20000 : 14000);
    const t0 = performance.now();

    if (visits > 1) {
      for (let v = 0; v < visits; v++) {
        if (this.cancelled) break;
        if (budgetMs && performance.now() - t0 > budgetMs) break;
        await this._playout(root, game, opts);
        if (onProgress && (v % 4 === 0)) onProgress(root.totalN, visits);
        if (v % 8 === 7) await new Promise(r => setTimeout(r, 0));   // keep the UI alive
      }
    }

    const move = this._pick(root, level, game);
    return { move, root, ev: rootEv, visits: root.totalN };
  }

  _passAllowed(game, ev) {
    const last = game.lastMove();
    const oppPassed = last && last.loc === -1;
    const area = game.size * game.size;
    const late = game.moves.length > area * 1.2;
    // Accept the end of the game when the opponent passes and we are ahead,
    // or when the board is played out and there is nothing left to gain.
    if (oppPassed) return ev.scoreMean >= 0.5 || late;
    return late && ev.scoreMean >= 0.5;
  }

  async _playout(root, game, opts) {
    const path = [];
    let node = root;
    for (;;) {
      const k = this._select(node);
      path.push([node, k]);
      const nextNode = node.child[k];
      if (nextNode === null) {
        const pos = node.pos.clone();
        const mv = node.moves[k];
        pos.play(mv, pos.toMove);
        // build a shallow Game view for feature encoding
        const sub = this._subGame(game, node, path);
        sub.pos = pos;
        const ev = await this.net.evaluate(sub, pos);
        const child = this._makeNode(sub, pos, ev, opts, false);
        node.child[k] = child;
        this._backup(path, -child.value);
        return;
      }
      node = nextNode;
      if (node.moves.length === 0) { this._backup(path, -node.value); return; }
    }
  }

  /* Build a light-weight Game-like object carrying the move history that the
     feature encoder needs (last 5 moves + previous boards). */
  _subGame(game, node, path) {
    const moves = game.moves.slice();
    const states = game.states.slice();
    for (const [nd, k] of path) {
      states.push(nd.pos);
      moves.push({ color: nd.pos.toMove, loc: nd.moves[k] });
    }
    return {
      size: game.size, komi: game.komi, moves, states, pos: game.pos,
      boardAgo(k) { const idx = states.length - k; return k === 0 ? this.pos : (states[idx] || states[0]); }
    };
  }

  _select(node) {
    const sq = Math.sqrt(Math.max(1, node.totalN));
    let visitedP = 0;
    for (let k = 0; k < node.moves.length; k++) if (node.N[k] > 0) visitedP += node.P[k];
    const fpu = node.value - FPU * Math.sqrt(visitedP);
    let best = 0, bestV = -1e30;
    for (let k = 0; k < node.moves.length; k++) {
      const n = node.N[k];
      const q = n > 0 ? node.W[k] / n : fpu;
      const u = CPUCT * node.P[k] * sq / (1 + n);
      const v = q + u;
      if (v > bestV) { bestV = v; best = k; }
    }
    return best;
  }

  _backup(path, value) {
    for (let i = path.length - 1; i >= 0; i--) {
      const [node, k] = path[i];
      node.N[k] += 1; node.totalN += 1; node.W[k] += value;
      value = -value;
    }
  }

  _pick(root, level, game) {
    const n = root.moves.length;
    if (n === 0) return -1;
    if (root.totalN > 0 && level.temp < 0.05) {
      let best = 0;
      for (let k = 1; k < n; k++) if (root.N[k] > root.N[best]) best = k;
      return root.moves[best];
    }
    // weight = search visits when we searched, otherwise the raw policy
    const w = new Float64Array(n);
    let sum = 0;
    const t = Math.max(0.05, level.temp);
    for (let k = 0; k < n; k++) {
      const base = root.totalN > 0 ? (root.N[k] + (root.P[k] * 0.5)) : root.P[k];
      const x = Math.pow(base, 1 / t);
      w[k] = x; sum += x;
    }
    if (level.rand > 0 && Math.random() < level.rand) {
      const nonPass = [];
      for (let k = 0; k < n; k++) if (root.moves[k] !== -1) nonPass.push(k);
      if (nonPass.length) return root.moves[nonPass[(Math.random() * nonPass.length) | 0]];
    }
    let r = Math.random() * sum;
    for (let k = 0; k < n; k++) { r -= w[k]; if (r <= 0) return root.moves[k]; }
    return root.moves[n - 1];
  }
}
