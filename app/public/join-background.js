/* ============================================================================
 * Weave — Join / Login screen background  (framework-agnostic, zero deps)
 * ----------------------------------------------------------------------------
 * An ambient field of horizontal strings, each in a different hue, that pluck
 * themselves at random intervals — the "tapestry weaving itself". Put a canvas
 * behind the login card; lay a radial vignette over it so the card stays legible.
 *
 * Ported from the design handoff ES module to a classic-script global (Weave
 * uses no ES modules). Drawing math is verbatim; only `export` was removed and
 * `window.JoinBackground` added at the foot.
 * ==========================================================================*/

class JoinBackground {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.rows = opts.rows || 11;
    this.maxDpr = opts.maxDpr || 2;
    this.strings = null;
    this._raf = 0;
    this._t0 = 0;
    this._animate = this._animate.bind(this);
  }

  start() {
    if (this._raf) return;
    this._t0 = performance.now();
    this._raf = requestAnimationFrame(this._animate);
  }
  stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; }
  destroy() { this.stop(); }

  _hsl(h, s, l, a) {
    return a == null ? `hsl(${h},${s}%,${l}%)` : `hsla(${h},${s}%,${l}%,${a})`;
  }

  _resize() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return null;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    return { w, h };
  }

  _disp(tx, amp, freq, t) {
    const env = Math.sin(Math.PI * tx);
    return env * amp * Math.sin(2 * Math.PI * freq * t)
         + env * amp * 0.34 * Math.sin(2 * Math.PI * freq * 2 * t + 1.1)
         + Math.sin(2 * Math.PI * tx) * amp * 0.18 * Math.sin(2 * Math.PI * freq * 0.5 * t);
  }

  _drawString(ctx, w, y, st, rowH, t) {
    const maxA = rowH * 0.34, pluckA = rowH * 0.42;
    const idle = 0.05 + 0.04 * Math.sin(t * 1.1 + st.phase);
    let amp = (st.level * maxA) + (st.pluck * pluckA) + idle * (rowH * 0.16);
    amp = Math.min(amp, rowH * 0.47);
    const N = 46, pts = [];
    for (let i = 0; i <= N; i++) {
      const tx = i / N;
      pts.push([w * tx, y - this._disp(tx, amp, st.freq, t)]);
    }
    const lvl = Math.min(1, st.level + st.pluck);
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowBlur = 5 + lvl * 20;
    ctx.shadowColor = this._hsl(st.hue, 90, 62, 0.9);
    ctx.strokeStyle = this._hsl(st.hue, 78, 56 + lvl * 8, 0.55 + lvl * 0.4);
    ctx.lineWidth = 1.3 + st.level * 3 + st.pluck * 2.4;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = this._hsl(st.hue, 100, 86, 0.25 + lvl * 0.6);
    ctx.lineWidth = 0.8 + lvl * 1.1;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.restore();
  }

  _animate(now) {
    const t = (now - this._t0) / 1000;
    const dim = this._resize();
    if (!dim) { this._raf = requestAnimationFrame(this._animate); return; }
    const { w, h } = dim;
    const ctx = this.ctx;

    if (!this.strings) {
      this.strings = [];
      for (let i = 0; i < this.rows; i++) {
        this.strings.push({
          hue: (i * 33) % 360, level: 0, pluck: 0,
          phase: Math.random() * 6.28,
          freq: 1.6 + Math.random() * 1.4,
          next: t + Math.random() * 1.5,
        });
      }
    }

    const rowH = h / this.rows;
    // faint warp
    const step = 34; ctx.lineWidth = 1;
    for (let x = step * 0.5; x < w; x += step) {
      ctx.strokeStyle = this._hsl(40, 40, 50, 0.04);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let i = 0; i < this.rows; i++) {
      const st = this.strings[i];
      if (t > st.next) {
        st.pluck = 0.7 + Math.random() * 0.3;
        st.level = 0.3 + Math.random() * 0.4;
        st.next = t + 0.8 + Math.random() * 2.2;
      }
      st.pluck *= 0.965; st.level *= 0.97;
      this._drawString(ctx, w, (i + 0.5) * rowH, st, rowH * 1.1, t);
    }
    this._raf = requestAnimationFrame(this._animate);
  }
}

// ---- expose as global (Weave loads classic scripts, not ES modules) ---------
window.JoinBackground = JoinBackground;
