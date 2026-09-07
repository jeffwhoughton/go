/* goban.js — Go rules engine (Chinese / area scoring, positional superko)
 * Colors: 0 empty, 1 black, 2 white.  Points are indices 0..size*size-1, row-major.
 * Pass is represented by the constant PASS (-1).
 */
'use strict';

const EMPTY = 0, BLACK = 1, WHITE = 2, PASS = -1;
const opp = c => (c === BLACK ? WHITE : BLACK);

/* ---- per-size cached neighbour tables ---------------------------------- */
const _nbCache = new Map();
function neighborTable(size) {
  if (_nbCache.has(size)) return _nbCache.get(size);
  const n = size * size;
  const off = new Int32Array(n + 1);
  const list = [];
  for (let i = 0; i < n; i++) {
    off[i] = list.length;
    const x = i % size, y = (i / size) | 0;
    if (y > 0) list.push(i - size);
    if (y < size - 1) list.push(i + size);
    if (x > 0) list.push(i - 1);
    if (x < size - 1) list.push(i + 1);
  }
  off[n] = list.length;
  const t = { off, list: Int32Array.from(list), n, size };
  _nbCache.set(size, t);
  return t;
}

/* ---- Zobrist ----------------------------------------------------------- */
const _zobCache = new Map();
function zobrist(size) {
  if (_zobCache.has(size)) return _zobCache.get(size);
  // deterministic xorshift so hashes are stable across reloads
  let s = 0x9e3779b9 ^ (size * 2654435761);
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  const n = size * size;
  const t = [new Uint32Array(n * 2), new Uint32Array(n * 2)]; // two 32-bit halves
  for (let i = 0; i < n * 2; i++) { t[0][i] = rnd(); t[1][i] = rnd(); }
  const tm = [new Uint32Array(2), new Uint32Array(2)];
  tm[0][0] = rnd(); tm[0][1] = rnd(); tm[1][0] = rnd(); tm[1][1] = rnd();
  const z = { t, tm };
  _zobCache.set(size, z);
  return z;
}

/* ======================================================================== */
class Position {
  constructor(size) {
    this.size = size;
    this.n = size * size;
    this.board = new Uint8Array(this.n);
    this.toMove = BLACK;
    this.ko = -1;                 // simple-ko forbidden point, or -1
    this.prisoners = [0, 0, 0];   // prisoners[c] = stones captured BY colour c
    this.h0 = 0; this.h1 = 0;     // zobrist of stones only
    this.nb = neighborTable(size);
    this.zob = zobrist(size);
    this._applyTurnHash();
  }

  _applyTurnHash() { /* turn is folded in only for situational hashes */ }

  clone() {
    const p = Object.create(Position.prototype);
    p.size = this.size; p.n = this.n;
    p.board = this.board.slice();
    p.toMove = this.toMove; p.ko = this.ko;
    p.prisoners = this.prisoners.slice();
    p.h0 = this.h0; p.h1 = this.h1;
    p.nb = this.nb; p.zob = this.zob;
    return p;
  }

  /* situational hash including side to move */
  hash() {
    const tm = this.zob.tm[this.toMove - 1];
    return ((this.h0 ^ tm[0]) >>> 0) + ':' + ((this.h1 ^ tm[1]) >>> 0);
  }
  /* positional hash (stones only) — used for positional superko */
  posHash() { return (this.h0 >>> 0) + ':' + (this.h1 >>> 0); }

  _xor(i, c) {
    const k = i * 2 + (c - 1);
    this.h0 ^= this.zob.t[0][k]; this.h0 >>>= 0;
    this.h1 ^= this.zob.t[1][k]; this.h1 >>>= 0;
  }

  _set(i, c) {
    const old = this.board[i];
    if (old !== EMPTY) this._xor(i, old);
    this.board[i] = c;
    if (c !== EMPTY) this._xor(i, c);
  }

  /* Flood the chain at i. Returns {stones:Int32Array, libs:number, libList:Int32Array} */
  chainAt(i, out) {
    const c = this.board[i];
    const { off, list } = this.nb;
    const stones = out && out.stones ? out.stones : [];
    stones.length = 0;
    const seen = _scratchSeen(this.n);
    const libSeen = _scratchLib(this.n);
    const libs = [];
    stones.push(i); seen[i] = _mark;
    for (let s = 0; s < stones.length; s++) {
      const p = stones[s];
      for (let k = off[p]; k < off[p + 1]; k++) {
        const q = list[k];
        const qc = this.board[q];
        if (qc === EMPTY) { if (libSeen[q] !== _mark) { libSeen[q] = _mark; libs.push(q); } }
        else if (qc === c && seen[q] !== _mark) { seen[q] = _mark; stones.push(q); }
      }
    }
    _bumpMark();
    return { stones, libs };
  }

  numLiberties(i) { return this.chainAt(i).libs.length; }

  /* Would playing (i,c) be legal ignoring superko?  Returns
     -1 illegal, otherwise the number of stones that would be captured. */
  _tryPlay(i, c) {
    if (i === PASS) return 0;
    if (i < 0 || i >= this.n || this.board[i] !== EMPTY) return -1;
    if (i === this.ko) return -1;
    const o = opp(c);
    const { off, list } = this.nb;
    let captures = 0, hasLib = false;
    for (let k = off[i]; k < off[i + 1]; k++) {
      const q = list[k];
      if (this.board[q] === EMPTY) { hasLib = true; break; }
    }
    if (!hasLib) {
      // does it capture?
      for (let k = off[i]; k < off[i + 1]; k++) {
        const q = list[k];
        if (this.board[q] === o) {
          const ch = this.chainAt(q);
          if (ch.libs.length === 1 && ch.libs[0] === i) captures += ch.stones.length;
        }
      }
      if (captures === 0) {
        // suicide? place tentatively and count liberties of own new chain
        this.board[i] = c;
        const ch = this.chainAt(i);
        const libs = ch.libs.length;
        this.board[i] = EMPTY;
        if (libs === 0) return -1;  // suicide — illegal under Chinese (no multi-stone suicide)
      }
    }
    return captures;
  }

  isLegal(i, c) { return this._tryPlay(i, c === undefined ? this.toMove : c) >= 0; }

  /* Play a move in place. Returns true on success. */
  play(i, c) {
    c = (c === undefined) ? this.toMove : c;
    if (i === PASS) { this.ko = -1; this.toMove = opp(c); return true; }
    if (this._tryPlay(i, c) < 0) return false;
    const o = opp(c);
    const { off, list } = this.nb;
    this._set(i, c);
    let captured = 0, lastCapturedAt = -1;
    for (let k = off[i]; k < off[i + 1]; k++) {
      const q = list[k];
      if (this.board[q] === o) {
        const ch = this.chainAt(q);
        if (ch.libs.length === 0) {
          for (const s of ch.stones) { this._set(s, EMPTY); lastCapturedAt = s; }
          captured += ch.stones.length;
        }
      }
    }
    this.prisoners[c] += captured;
    // simple ko: exactly one stone captured, and the played stone is a lone stone in atari
    this.ko = -1;
    if (captured === 1) {
      const ch = this.chainAt(i);
      if (ch.stones.length === 1 && ch.libs.length === 1) this.ko = lastCapturedAt;
    }
    this.toMove = o;
    return true;
  }

  /* single-point eye of colour c (safe-ish: all orthogonals c, and at most one
     diagonal not c on interior / none on edge) */
  isSimpleEye(i, c) {
    if (this.board[i] !== EMPTY) return false;
    const { off, list } = this.nb, size = this.size;
    for (let k = off[i]; k < off[i + 1]; k++) if (this.board[list[k]] !== c) return false;
    const x = i % size, y = (i / size) | 0;
    let badDiag = 0, edge = 0;
    for (const [dx, dy] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) { edge++; continue; }
      if (this.board[ny * size + nx] !== c) badDiag++;
    }
    return edge > 0 ? badDiag === 0 : badDiag <= 1;
  }
}

/* shared scratch buffers for chain flooding (single-threaded) */
let _mark = 1, _seenBuf = null, _libBuf = null, _bufN = 0;
function _scratchSeen(n) { if (_bufN !== n) { _seenBuf = new Int32Array(n); _libBuf = new Int32Array(n); _bufN = n; _mark = 1; } return _seenBuf; }
function _scratchLib(n) { return _libBuf; }
function _bumpMark() { _mark++; if (_mark > 2e9) { _seenBuf.fill(0); _libBuf.fill(0); _mark = 1; } }

/* ======================================================================== *
 *  Game — position + history + rules bookkeeping
 * ======================================================================== */
class Game {
  constructor(size, komi) {
    this.size = size;
    this.komi = komi;
    this.pos = new Position(size);
    this.moves = [];                     // {color, loc}
    this.states = [];                    // states[i] = position BEFORE moves[i]
    this.seen = new Set([this.pos.posHash()]);
    this.seenStack = [this.pos.posHash()];
    this.over = false;
    this.result = null;
  }
  get toMove() { return this.pos.toMove; }
  get board() { return this.pos.board; }
  get prisoners() { return this.pos.prisoners; }

  isLegal(loc, c) {
    c = c === undefined ? this.pos.toMove : c;
    if (loc === PASS) return true;
    if (!this.pos.isLegal(loc, c)) return false;
    const t = this.pos.clone();
    t.play(loc, c);
    return !this.seen.has(t.posHash());   // positional superko
  }

  legalMoves(c) {
    c = c === undefined ? this.pos.toMove : c;
    const out = [];
    for (let i = 0; i < this.pos.n; i++) if (this.isLegal(i, c)) out.push(i);
    return out;
  }

  play(loc) {
    const c = this.pos.toMove;
    if (!this.isLegal(loc, c)) return false;
    this.states.push(this.pos.clone());
    this.pos.play(loc, c);
    this.moves.push({ color: c, loc });
    const h = this.pos.posHash();
    this.seen.add(h); this.seenStack.push(h);
    if (this.moves.length >= 2) {
      const a = this.moves[this.moves.length - 1], b = this.moves[this.moves.length - 2];
      if (a.loc === PASS && b.loc === PASS) this.over = true;
    }
    return true;
  }

  undo() {
    if (!this.moves.length) return false;
    this.moves.pop();
    this.pos = this.states.pop();
    const h = this.seenStack.pop();
    // rebuild the seen set only if that hash no longer occurs
    if (!this.seenStack.includes(h)) this.seen.delete(h);
    this.over = false; this.result = null;
    return true;
  }

  lastMove() { return this.moves.length ? this.moves[this.moves.length - 1] : null; }
  /* board state n moves ago (0 = current) */
  boardAgo(k) {
    if (k === 0) return this.pos;
    const idx = this.states.length - k;
    if (idx >= 0 && idx < this.states.length) return this.states[idx];
    return this.states.length ? this.states[0] : this.pos;
  }
}

/* ======================================================================== *
 *  Benson's algorithm — pass-alive chains and territory
 *  Returns Uint8Array area[] with BLACK/WHITE/EMPTY per point.
 * ======================================================================== */
function passAliveArea(pos, pla, area) {
  const { size, n, board } = pos;
  const { off, list } = pos.nb;
  const o = opp(pla);

  // chains of pla
  const chainId = new Int32Array(n).fill(-1);
  const chains = [];
  for (let i = 0; i < n; i++) {
    if (board[i] !== pla || chainId[i] >= 0) continue;
    const id = chains.length, stones = [i];
    chainId[i] = id;
    for (let s = 0; s < stones.length; s++) {
      const p = stones[s];
      for (let k = off[p]; k < off[p + 1]; k++) {
        const q = list[k];
        if (board[q] === pla && chainId[q] < 0) { chainId[q] = id; stones.push(q); }
      }
    }
    chains.push({ stones, alive: true, vital: 0 });
  }
  if (!chains.length) return;

  // maximal regions of empty-or-opp
  const regionId = new Int32Array(n).fill(-1);
  const regions = [];
  for (let i = 0; i < n; i++) {
    if (board[i] === pla || regionId[i] >= 0) continue;
    const id = regions.length, pts = [i];
    regionId[i] = id;
    for (let s = 0; s < pts.length; s++) {
      const p = pts[s];
      for (let k = off[p]; k < off[p + 1]; k++) {
        const q = list[k];
        if (board[q] !== pla && regionId[q] < 0) { regionId[q] = id; pts.push(q); }
      }
    }
    // bordering chains, and which chains this region is vital to
    const border = new Set();
    const emptyPts = [];
    for (const p of pts) {
      if (board[p] === EMPTY) emptyPts.push(p);
      for (let k = off[p]; k < off[p + 1]; k++) {
        const q = list[k];
        if (board[q] === pla) border.add(chainId[q]);
      }
    }
    const vitalTo = [];
    for (const cid of border) {
      let all = true;
      for (const e of emptyPts) {
        let adj = false;
        for (let k = off[e]; k < off[e + 1]; k++) if (chainId[list[k]] === cid) { adj = true; break; }
        if (!adj) { all = false; break; }
      }
      if (all) vitalTo.push(cid);
    }
    regions.push({ pts, border, vitalTo, alive: true });
  }

  // Benson fixpoint
  for (;;) {
    let changed = false;
    for (const ch of chains) ch.vital = 0;
    for (const r of regions) if (r.alive) for (const cid of r.vitalTo) if (chains[cid].alive) chains[cid].vital++;
    for (const ch of chains) if (ch.alive && ch.vital < 2) { ch.alive = false; changed = true; }
    for (const r of regions) {
      if (!r.alive) continue;
      for (const cid of r.border) if (!chains[cid].alive) { r.alive = false; changed = true; break; }
    }
    if (!changed) break;
  }

  for (const ch of chains) if (ch.alive) for (const p of ch.stones) area[p] = pla;
  for (const r of regions) if (r.alive) for (const p of r.pts) area[p] = pla;
}

/* Big territories: empty regions bordered by exactly one colour. onlyEmptySlots
   keeps pass-alive results from being overwritten. */
function bigTerritories(pos, area) {
  const { n, board } = pos;
  const { off, list } = pos.nb;
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (board[i] !== EMPTY || seen[i]) continue;
    const pts = [i]; seen[i] = 1;
    let sawB = false, sawW = false;
    for (let s = 0; s < pts.length; s++) {
      const p = pts[s];
      for (let k = off[p]; k < off[p + 1]; k++) {
        const q = list[k];
        const c = board[q];
        if (c === EMPTY) { if (!seen[q]) { seen[q] = 1; pts.push(q); } }
        else if (c === BLACK) sawB = true; else sawW = true;
      }
    }
    const own = (sawB && !sawW) ? BLACK : (sawW && !sawB) ? WHITE : EMPTY;
    if (own !== EMPTY) for (const p of pts) if (area[p] === EMPTY) area[p] = own;
  }
}

/* KataGo feature 18/19 area: pass-alive + big territories + remaining stones */
function calculateArea(pos) {
  const area = new Uint8Array(pos.n);
  passAliveArea(pos, BLACK, area);
  passAliveArea(pos, WHITE, area);
  bigTerritories(pos, area);
  for (let i = 0; i < pos.n; i++) if (area[i] === EMPTY) area[i] = pos.board[i];
  return area;
}

/* ======================================================================== *
 *  Final scoring (Chinese / area) with dead stones removed
 *  dead: Uint8Array flags per point (1 = stone is dead)
 * ======================================================================== */
/* Territory scoring: enclosed empty points + prisoners taken during play +
   the opponent's dead stones, plus komi for White.
   prisoners is the game's [_, takenByBlack, takenByWhite] counter. */
function scoreTerritory(pos, dead, komi, prisoners) {
  const n = pos.n;
  const work = pos.clone();
  let deadBlack = 0, deadWhite = 0;
  for (let i = 0; i < n; i++) {
    if (dead && dead[i] && work.board[i] !== EMPTY) {
      if (work.board[i] === BLACK) deadBlack++; else deadWhite++;
      work.board[i] = EMPTY;
    }
  }
  const terr = new Uint8Array(n);
  bigTerritories(work, terr);            // only assigns empty regions with one bordering colour
  let tb = 0, tw = 0;
  for (let i = 0; i < n; i++) {
    if (work.board[i] !== EMPTY) continue;
    if (terr[i] === BLACK) tb++; else if (terr[i] === WHITE) tw++;
  }
  const takenB = prisoners ? prisoners[BLACK] : 0;
  const takenW = prisoners ? prisoners[WHITE] : 0;
  const black = tb + takenB + deadWhite;
  const white = tw + takenW + deadBlack + komi;
  return { black, white, area: terr, territory: [0, tb, tw],
           deadBlack, deadWhite, diff: black - white };
}

function scoreArea(pos, dead, komi) {
  const n = pos.n;
  const work = pos.clone();
  let removedByBlack = 0, removedByWhite = 0;
  for (let i = 0; i < n; i++) {
    if (dead && dead[i] && work.board[i] !== EMPTY) {
      if (work.board[i] === BLACK) removedByWhite++; else removedByBlack++;
      work.board[i] = EMPTY;
    }
  }
  const area = new Uint8Array(n);
  bigTerritories(work, area);
  for (let i = 0; i < n; i++) if (area[i] === EMPTY) area[i] = work.board[i];
  let b = 0, w = 0;
  for (let i = 0; i < n; i++) { if (area[i] === BLACK) b++; else if (area[i] === WHITE) w++; }
  return {
    black: b, white: w + komi, area,
    removedByBlack, removedByWhite,
    diff: b - (w + komi)   // >0 black wins
  };
}
