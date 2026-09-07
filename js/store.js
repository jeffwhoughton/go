/* store.js — localStorage: remembered settings, the game in progress,
 * and the match history.  Every accessor is defensive: a corrupt or
 * unavailable store must never stop the app from starting.
 */
'use strict';

const Store = (() => {
  const K_SET = 'go.settings', K_CUR = 'go.current', K_HIST = 'go.history';
  const MAX_MATCHES = 60;
  const MIN_MOVES_TO_KEEP = 6;      // a 2-3 move stub is not worth remembering

  /* Levels used to be stored by array index.  Two rungs (8k, 6k) were added
     later, so a bare index from an older build has to be translated through
     the ranks it used to mean. */
  const LEGACY_IDS = ['30k','27k','25k','22k','20k','18k','15k','13k','11k','9k',
                      '7k','5k','4k','3k','2k','1k','1d','2d','3d','4d','5d','max'];

  const get = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const del = k => { try { localStorage.removeItem(k); } catch (e) {} };

  return {
    /* ---- remembered menu settings ---- */
    settings() {
      const s = get(K_SET) || {};
      return { size: [9, 13, 19].includes(s.size) ? s.size : 19,
               levelId: this.readLevelId(s, '1d') };
    },
    saveSettings(size, levelId) { put(K_SET, { size, levelId }); },

    /* accepts {levelId} from current builds, {levelIdx} from older ones */
    readLevelId(o, dflt) {
      if (o && typeof o.levelId === 'string') return o.levelId;
      if (o && Number.isInteger(o.levelIdx) && LEGACY_IDS[o.levelIdx]) return LEGACY_IDS[o.levelIdx];
      return dflt;
    },

    /* ---- game in progress ---- */
    saveCurrent(game, levelId) {
      put(K_CUR, { size: game.size, komi: game.komi, levelId,
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
