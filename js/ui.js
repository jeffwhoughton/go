/* ui.js — canvas goban with drag-to-place */
'use strict';

const FLY_MS = 600;

class BoardView {
  constructor(canvas, onPlay) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.onPlay = onPlay;
    this.size = 19;
    this.board = null;
    this.lastMove = null;
    this.ghost = -1;          // intersection under the finger
    this.ghostColor = 1;
    this.interactive = false;
    this.overlay = null;      // {area:Uint8Array, dead:Uint8Array}
    this.px = 0; this.dpr = 1;
    this._wood = null;
    this.flying = [];         // captured stones on their way to a player's row
    this._raf = null;
    this._bind();
  }

  /* Drop cached pixels and repaint.  Mobile browsers may discard a canvas'
     backing store while the app sits in the background; the cached wood
     texture then draws as nothing and the board loses its background. */
  invalidate() {
    this._wood = null;
    this.render();
  }

  /* ---------- captured-stone animation ---------- */
  flyCaptures(locs, color, toBottom) {
    if (!locs || !locs.length || !this.px) return;
    const now = performance.now();
    for (let i = 0; i < locs.length; i++)
      this.flying.push({ loc: locs[i], color, toBottom, t0: now + i * 50 });
    this._animate();
  }
  _animate() {
    if (this._raf) return;
    const step = () => {
      this._raf = null;
      const now = performance.now();
      this.flying = this.flying.filter(f => now - f.t0 < FLY_MS);
      this.render();
      if (this.flying.length) this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }
  clearFlying() {
    this.flying.length = 0;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }

  /* ---------- geometry ---------- */
  layout() {
    const wrap = this.cv.parentElement;
    const avail = Math.min(wrap.clientWidth, wrap.clientHeight);
    const px = Math.max(160, Math.floor(avail));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (px === this.px && dpr === this.dpr) return;
    this.px = px; this.dpr = dpr;
    this.cv.style.width = px + 'px';
    this.cv.style.height = px + 'px';
    this.cv.width = Math.round(px * dpr);
    this.cv.height = Math.round(px * dpr);
    this._wood = null;
    this.render();
  }
  get cell() { return this.px / (this.size + 0.9); }
  get pad() { return this.cell * 0.95; }
  cx(col) { return this.pad + col * this.cell; }
  cy(row) { return this.pad + row * this.cell; }

  locFromXY(x, y) {
    const c = Math.round((x - this.pad) / this.cell);
    const r = Math.round((y - this.pad) / this.cell);
    if (c < 0 || r < 0 || c >= this.size || r >= this.size) return -1;
    return r * this.size + c;
  }

  /* ---------- input ---------- */
  _bind() {
    const cv = this.cv;
    const pt = e => {
      const b = cv.getBoundingClientRect();
      return [e.clientX - b.left, e.clientY - b.top];
    };
    const down = e => {
      if (!this.interactive) return;
      cv.setPointerCapture(e.pointerId);
      const [x, y] = pt(e);
      this.ghost = this.locFromXY(x, y);
      this.render();
      e.preventDefault();
    };
    const move = e => {
      if (!this.interactive || this.ghost === -1 && !cv.hasPointerCapture(e.pointerId)) return;
      if (!cv.hasPointerCapture(e.pointerId)) return;
      const [x, y] = pt(e);
      const g = this.locFromXY(x, y);
      if (g !== this.ghost) { this.ghost = g; this.render(); }
      e.preventDefault();
    };
    const up = e => {
      if (!cv.hasPointerCapture(e.pointerId)) return;
      cv.releasePointerCapture(e.pointerId);
      const g = this.ghost;
      this.ghost = -1;
      this.render();
      if (g >= 0 && this.interactive) this.onPlay(g);
    };
    const cancel = () => { this.ghost = -1; this.render(); };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', cancel);
    cv.addEventListener('contextmenu', e => e.preventDefault());
  }

  /* ---------- wood ---------- */
  _makeWood() {
    const s = Math.round(this.px * this.dpr);
    const c = document.createElement('canvas');
    c.width = s; c.height = s;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, s * 0.35, s);
    grd.addColorStop(0, '#e9c684');
    grd.addColorStop(0.45, '#d9ab60');
    grd.addColorStop(1, '#c08f45');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    // grain
    g.globalAlpha = 0.035;
    for (let i = 0; i < 130; i++) {
      const y = Math.random() * s;
      g.strokeStyle = Math.random() < .5 ? '#7a4d16' : '#fff2cf';
      g.lineWidth = (0.5 + Math.random() * 2.4) * this.dpr;
      g.beginPath();
      g.moveTo(0, y);
      const amp = (4 + Math.random() * 20) * this.dpr;
      for (let x = 0; x <= s; x += s / 8) g.lineTo(x, y + Math.sin(x / s * 6 + i) * amp);
      g.stroke();
    }
    g.globalAlpha = 1;
    // vignette
    const v = g.createRadialGradient(s / 2, s / 2, s * 0.25, s / 2, s / 2, s * 0.78);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(70,40,8,0.20)');
    g.fillStyle = v; g.fillRect(0, 0, s, s);
    this._wood = c;
  }

  /* ---------- painting ---------- */
  render() {
    if (!this.px) return;
    const ctx = this.ctx, dpr = this.dpr, size = this.size, cell = this.cell;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.px, this.px);
    if (!this._wood) this._makeWood();
    ctx.drawImage(this._wood, 0, 0, this.px, this.px);

    /* grid */
    const a = this.cx(0), b = this.cx(size - 1);
    ctx.strokeStyle = 'rgba(48,30,8,0.72)';
    ctx.lineWidth = Math.max(0.7, cell * 0.035);
    ctx.beginPath();
    for (let i = 0; i < size; i++) {
      const p = this.cx(i);
      ctx.moveTo(a, p + 0); ctx.lineTo(b, p);
      ctx.moveTo(p, a); ctx.lineTo(p, b);
    }
    ctx.stroke();
    ctx.lineWidth = Math.max(1.1, cell * 0.055);
    ctx.strokeRect(a, a, b - a, b - a);

    /* star points */
    const stars = this._stars(size);
    ctx.fillStyle = 'rgba(48,30,8,0.85)';
    for (const [c0, r0] of stars) {
      ctx.beginPath();
      ctx.arc(this.cx(c0), this.cy(r0), Math.max(1.6, cell * 0.085), 0, 7);
      ctx.fill();
    }

    /* territory overlay */
    if (this.overlay) {
      const { area, dead } = this.overlay;
      const w = cell * 0.28;
      for (let i = 0; i < size * size; i++) {
        const col = i % size, row = (i / size) | 0;
        if (this.board[i] !== 0 && !(dead && dead[i])) continue;
        if (!area[i]) continue;
        ctx.fillStyle = area[i] === 1 ? 'rgba(12,14,18,0.62)' : 'rgba(255,252,244,0.72)';
        ctx.fillRect(this.cx(col) - w / 2, this.cy(row) - w / 2, w, w);
      }
    }

    /* placement guide lines — drawn under the stones so they read as part
       of the board rather than covering it */
    if (this.ghost >= 0) {
      const col = this.ghost % size, row = (this.ghost / size) | 0;
      const gx = this.cx(col), gy = this.cy(row);
      ctx.save();
      ctx.lineCap = 'butt';
      ctx.strokeStyle = 'rgba(255,248,228,0.42)';       // soft halo
      ctx.lineWidth = cell * 0.20;
      ctx.beginPath();
      ctx.moveTo(a, gy); ctx.lineTo(b, gy);
      ctx.moveTo(gx, a); ctx.lineTo(gx, b);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(84,48,6,0.95)';            // crisp guide line
      ctx.lineWidth = Math.max(1.3, cell * 0.09);
      ctx.beginPath();
      ctx.moveTo(a, gy); ctx.lineTo(b, gy);
      ctx.moveTo(gx, a); ctx.lineTo(gx, b);
      ctx.stroke();
      ctx.restore();
    }

    /* stones */
    if (this.board) {
      for (let i = 0; i < size * size; i++) {
        const c = this.board[i];
        if (!c) continue;
        const dead = this.overlay && this.overlay.dead && this.overlay.dead[i];
        this._stone(this.cx(i % size), this.cy((i / size) | 0), cell * 0.475, c, dead ? 0.22 : 1);
      }
    }

    /* last move */
    if (this.lastMove !== null && this.lastMove >= 0 && this.board && this.board[this.lastMove]) {
      const c = this.board[this.lastMove];
      const x = this.cx(this.lastMove % size), y = this.cy((this.lastMove / size) | 0);
      ctx.strokeStyle = c === 1 ? 'rgba(255,255,255,.9)' : 'rgba(20,20,20,.75)';
      ctx.lineWidth = Math.max(1.4, cell * 0.07);
      ctx.beginPath(); ctx.arc(x, y, cell * 0.185, 0, 7); ctx.stroke();
    }

    /* placement ghost sits on top of everything */
    if (this.ghost >= 0) {
      const col = this.ghost % size, row = (this.ghost / size) | 0;
      const x = this.cx(col), y = this.cy(row);
      this._stone(x, y, cell * 0.475, this.ghostColor, 0.85);
      ctx.strokeStyle = 'rgba(255,246,220,0.92)';
      ctx.lineWidth = Math.max(1.3, cell * 0.06);
      ctx.beginPath(); ctx.arc(x, y, cell * 0.58, 0, 7); ctx.stroke();
    }

    /* captured stones travelling to their captor's row */
    if (this.flying.length) {
      const now = performance.now();
      for (const f of this.flying) {
        const p = Math.max(0, Math.min(1, (now - f.t0) / FLY_MS));
        if (p <= 0) continue;
        const e = p * p * (3 - 2 * p);                          // smooth in-out
        const sx = this.cx(f.loc % size), sy = this.cy((f.loc / size) | 0);
        const tx = this.px / 2;
        // stop just at the board edge and fade out on the way, so a stone is
        // gone before it would be sliced off by the canvas boundary
        const ty = f.toBottom ? this.px + cell * 0.4 : -cell * 0.4;
        const alpha = p < 0.5 ? 1 : 1 - (p - 0.5) / 0.5;
        this._stone(sx + (tx - sx) * e, sy + (ty - sy) * e,
                    cell * 0.475 * (1 - 0.3 * e), f.color, Math.max(0, alpha));
      }
    }
    ctx.restore();
  }

  _stone(x, y, r, color, alpha) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    // shadow
    ctx.beginPath();
    ctx.ellipse(x + r * 0.10, y + r * 0.16, r * 0.99, r * 0.94, 0, 0, 7);
    ctx.fillStyle = 'rgba(45,25,5,0.34)';
    ctx.filter = 'blur(0px)';
    ctx.fill();
    const g = ctx.createRadialGradient(x - r * 0.34, y - r * 0.38, r * 0.06, x, y, r * 1.08);
    if (color === 1) {
      g.addColorStop(0, '#7e838d'); g.addColorStop(0.28, '#3a3e46');
      g.addColorStop(0.72, '#15181d'); g.addColorStop(1, '#05070a');
    } else {
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.42, '#f3f0e8');
      g.addColorStop(0.82, '#d6d1c4'); g.addColorStop(1, '#b3ad9e');
    }
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = g; ctx.fill();
    // rim
    ctx.strokeStyle = color === 1 ? 'rgba(0,0,0,.55)' : 'rgba(120,113,98,.55)';
    ctx.lineWidth = r * 0.06; ctx.stroke();
    // specular
    ctx.beginPath();
    ctx.ellipse(x - r * 0.33, y - r * 0.36, r * 0.30, r * 0.19, -0.7, 0, 7);
    ctx.fillStyle = color === 1 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.75)';
    ctx.fill();
    ctx.restore();
  }

  _stars(size) {
    if (size === 19) { const p = [3, 9, 15]; return p.flatMap(a => p.map(b => [a, b])); }
    if (size === 13) { const p = [3, 6, 9]; return [[3,3],[3,9],[9,3],[9,9],[6,6]]; }
    if (size === 9) return [[2,2],[2,6],[6,2],[6,6],[4,4]];
    return [];
  }
}
