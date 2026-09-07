/* features.js — KataGo neural-net input encoding (input version 7:
 * 22 spatial channels + 19 global), ported from cpp/neuralnet/nninputs.cpp
 * fillRowV7 for the Chinese ruleset (area scoring, simple ko, no tax,
 * no button, encore phase 0).
 *
 * The network was exported with a fixed 19x19 tensor, but KataGo nets are
 * mask-aware: channel 0 flags on-board points and every pooling layer
 * normalises by that mask, so a 9x9 or 13x13 board is encoded into the
 * top-left corner of the 19x19 buffer and the net masks the rest itself.
 */
'use strict';

const NN_LEN = 19, NN_AREA = NN_LEN * NN_LEN, NUM_BIN = 22, NUM_GLOBAL = 19;
const POS_PASS = NN_AREA;

/* ---------------- ladder search --------------------------------------- */
function _nbs(pos, i) {
  const { off, list } = pos.nb, out = [];
  for (let k = off[i]; k < off[i + 1]; k++) out.push(list[k]);
  return out;
}

/* Returns true if the chain containing `loc` is captured in a ladder.
   Mirrors Board::searchIsLadderCaptured. */
function ladderCaptured(pos, loc, defenderFirst, budget) {
  const ch = pos.chainAt(loc);
  const libs = ch.libs.length;
  if (libs > 2 || (defenderFirst && libs > 1)) return false;
  const work = pos.clone();
  work.ko = -1;                       // assume kos work for the defender
  const maxDepth = pos.n * 3 / 2 + 1;
  return _lad(work, loc, defenderFirst, 0, maxDepth, budget);
}

function _lad(pos, loc, isDefender, depth, maxDepth, budget) {
  if (budget.n <= 0) return false;
  if (depth >= maxDepth) return true;
  budget.n--;
  const pla = pos.board[loc];
  if (pla === 0) return true;                       // already gone
  const ch = pos.chainAt(loc);
  const libs = ch.libs.length;
  if (!isDefender) {
    if (libs <= 1) return true;                     // attacker wins
    if (libs >= 3) return false;                    // attacker lost
  } else {
    if (libs >= 2) return false;                    // defender escaped
    if (pos.ko !== -1) return false;                // don't claim ko-dependent ladders
  }
  const att = pla === 1 ? 2 : 1;

  if (isDefender) {
    const moves = [];
    const seen = new Set();
    for (const s of ch.stones) {
      for (const q of _nbs(pos, s)) {
        if (pos.board[q] === att) {
          const c2 = pos.chainAt(q);
          if (c2.libs.length === 1) { const m = c2.libs[0]; if (!seen.has(m)) { seen.add(m); moves.push(m); } }
        }
      }
    }
    for (const l of ch.libs) if (!seen.has(l)) { seen.add(l); moves.push(l); }
    for (const m of moves) {
      const p2 = pos.clone();
      if (!p2.play(m, pla)) continue;
      if (!_lad(p2, loc, false, depth + 1, maxDepth, budget)) return false;  // defender survives
      if (budget.n <= 0) return false;
    }
    return true;
  } else {
    for (const m of ch.libs) {
      const p2 = pos.clone();
      if (!p2.play(m, att)) continue;
      if (p2.board[loc] === 0) return true;
      if (_lad(p2, loc, true, depth + 1, maxDepth, budget)) return true;
      if (budget.n <= 0) return false;
    }
    return false;
  }
}

/* Iterate laddered stones on a board, calling f(loc, workingMoves) */
function iterLadders(pos, budget, f) {
  const solved = new Map();           // chain-representative -> bool
  const rep = new Int32Array(pos.n).fill(-1);
  for (let i = 0; i < pos.n; i++) {
    const c = pos.board[i];
    if (c === 0) continue;
    if (rep[i] < 0) {
      const ch = pos.chainAt(i);
      let head = ch.stones[0];
      for (const s of ch.stones) if (s < head) head = s;
      for (const s of ch.stones) rep[s] = head;
      if (!solved.has(head)) {
        const libs = ch.libs.length;
        if (libs === 1 || libs === 2) {
          let laddered = false, working = [];
          if (libs === 1) laddered = ladderCaptured(pos, i, true, budget);
          else {
            // attacker plays first at one of the two liberties
            const o = c === 1 ? 2 : 1;
            for (const m of ch.libs) {
              const p2 = pos.clone();
              if (!p2.play(m, o)) continue;
              if (p2.board[i] === 0) { laddered = true; working.push(m); continue; }
              if (ladderCaptured(p2, i, true, budget)) { laddered = true; working.push(m); }
            }
          }
          solved.set(head, { laddered, working });
        } else solved.set(head, { laddered: false, working: [] });
      }
    }
    const r = solved.get(rep[i]);
    if (r && r.laddered) f(i, r.working);
  }
}

/* ---------------- main encoder ---------------------------------------- */
/* game: Game instance; returns {bin: Float32Array, global: Float32Array} */
function encode(game, opts) {
  opts = opts || {};
  const pos = game.pos, size = game.size, komi = game.komi;
  const pla = opts.pla || pos.toMove;
  const oppC = pla === 1 ? 2 : 1;
  const bin = new Float32Array(NN_AREA * NUM_BIN);
  const glob = new Float32Array(NUM_GLOBAL);
  const nnPos = (loc) => { const x = loc % size, y = (loc / size) | 0; return y * NN_LEN + x; };
  const set = (p, f) => { bin[p * NUM_BIN + f] = 1.0; };

  /* 0 on-board, 1/2 stones, 3/4/5 liberties */
  const libCache = new Int32Array(pos.n).fill(0);
  const done = new Uint8Array(pos.n);
  for (let i = 0; i < pos.n; i++) {
    const p = nnPos(i);
    set(p, 0);
    const c = pos.board[i];
    if (c === pla) set(p, 1); else if (c === oppC) set(p, 2);
    if (c !== 0) {
      if (!done[i]) {
        const ch = pos.chainAt(i);
        const l = ch.libs.length;
        for (const s of ch.stones) { libCache[s] = l; done[s] = 1; }
      }
      const l = libCache[i];
      if (l === 1) set(p, 3); else if (l === 2) set(p, 4); else if (l === 3) set(p, 5);
    }
  }

  /* 6 ko ban (simple ko under Chinese rules) */
  if (pos.ko >= 0) set(nnPos(pos.ko), 6);

  /* 18/19 current area (area scoring, tax none) */
  const area = calculateArea(pos);
  for (let i = 0; i < pos.n; i++) {
    if (area[i] === pla) set(nnPos(i), 18);
    else if (area[i] === oppC) set(nnPos(i), 19);
  }

  /* 9..13 + global 0..4 — last five moves, alternating opp/pla */
  const mv = game.moves;
  let historyIncluded = 0;
  const featForAgo = [9, 10, 11, 12, 13];
  for (let k = 1; k <= 5; k++) {
    const m = mv[mv.length - k];
    if (!m) break;
    const expect = (k % 2 === 1) ? oppC : pla;
    if (m.color !== expect) break;
    historyIncluded = k;
    if (m.loc === -1) glob[k - 1] = 1.0;
    else set(nnPos(m.loc), featForAgo[k - 1]);
  }

  /* 14/15/16/17 ladder features */
  const budget = { n: opts.ladderBudget === undefined ? 2500 : opts.ladderBudget };
  if (budget.n > 0) {
    iterLadders(pos, budget, (loc, working) => {
      const p = nnPos(loc);
      set(p, 14);
      if (pos.board[loc] === oppC && libCache[loc] > 1)
        for (const w of working) set(nnPos(w), 17);
    });
    const prev = historyIncluded < 1 ? pos : game.boardAgo(1);
    iterLadders(prev, budget, (loc) => set(nnPos(loc), 15));
    const prev2 = historyIncluded < 2 ? prev : game.boardAgo(2);
    iterLadders(prev2, budget, (loc) => set(nnPos(loc), 16));
  }

  /* ---- global features ---- */
  const bArea = size * size;
  let selfKomi = (pla === 2) ? komi : -komi;          // komi is white's bonus
  const clip = bArea + 15;
  if (selfKomi > clip) selfKomi = clip;
  if (selfKomi < -clip) selfKomi = -clip;
  glob[5] = selfKomi / 20.0;
  /* 6,7 ko rule: SIMPLE -> 0,0.  8 suicide: illegal -> 0.
     9 scoring: AREA -> 0.  10,11 tax NONE -> 0,0.  12,13 encore -> 0. */
  const last = mv[mv.length - 1];
  glob[14] = (last && last.loc === -1) ? 1.0 : 0.0;   // a pass would end the phase
  /* 15,16 playoutDoublingAdvantage -> 0.  17 button -> 0. */

  /* 18 komi parity wave (area scoring) */
  const boardAreaIsEven = (bArea % 2) === 0;
  const komiFloor = boardAreaIsEven
    ? Math.floor(selfKomi / 2) * 2
    : Math.floor((selfKomi - 1) / 2) * 2 + 1;
  let d = selfKomi - komiFloor;
  if (d < 0) d = 0; if (d > 2) d = 2;
  glob[18] = d < 0.5 ? d : (d < 1.5 ? 1 - d : d - 2);

  return { bin, glob, pla };
}
