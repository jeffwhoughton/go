/* store.js — localStorage: remembered settings, the game in progress,
 * and the match history.  Every accessor is defensive: a corrupt or
 * unavailable store must never stop the app from starting.
 */
'use strict';

const Store = (() => {
  const K_SET = 'go.settings', K_CUR = 'go.current', K_HIST = 'go.history';
  const MAX_MATCHES = 60;
  const MIN_MOVES_TO_KEEP = 6;      // a 2-3 move stub is not worth remembering

  const get = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const del = k => { try { localStorage.removeItem(k); } catch (e) {} };

  return {
    /* ---- remembered menu settings ---- */
    settings() {
      const s = get(K_SET) || {};
      return { size: [9, 13, 19].includes(s.size) ? s.size : 19,
               levelIdx: Number.isInteger(s.levelIdx) ? s.levelIdx : 16 };
    },
    saveSettings(size, levelIdx) { put(K_SET, { size, levelIdx }); },

    /* ---- game in progress ---- */
    saveCurrent(game, levelIdx) {
      put(K_CUR, { size: game.size, komi: game.komi, levelIdx,
                   moves: game.moves.map(m => m.loc), ts: Date.now() });
    },
    loadCurrent() {
      const c = get(K_CUR);
      if (!c || !Array.isArray(c.moves) || !c.moves.length) return null;
      if (![9, 13, 19].includes(c.size)) return null;
      return c;
    },
    clearCurrent() { del(K_CUR); },

    /* ---- finished matches ---- */
    history() {
      const h = get(K_HIST);
      return Array.isArray(h) ? h : [];
    },
    addMatch(entry) {
      if (!entry || !entry.moves || entry.moves.length < MIN_MOVES_TO_KEEP) return false;
      const h = this.history();
      h.unshift(entry);
      while (h.length > MAX_MATCHES) h.pop();
      if (!put(K_HIST, h)) {            // quota: drop the oldest until it fits
        while (h.length > 5) { h.pop(); if (put(K_HIST, h)) return true; }
        return false;
      }
      return true;
    },
    clearHistory() { del(K_HIST); },
    MIN_MOVES_TO_KEEP,
  };
})();
