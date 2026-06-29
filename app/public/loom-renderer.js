/* ============================================================================
 * Weave — Loom Renderer  (framework-agnostic, zero dependencies)
 * ----------------------------------------------------------------------------
 * Draws the "living loom": one horizontal string per participant. Each string
 * vibrates, glows and swells with that person's voice level, and when 2+ people
 * speak at once their strings pull together and braid (weave) through one
 * another. Three visual modes: 'cloth' | 'harp' | 'web'.
 *
 * Ported from the design handoff ES module to a classic-script global so it can
 * be loaded with a plain <script> tag (Weave uses no ES modules). The drawing
 * math is verbatim; only `export` was removed and `window.*` added at the foot.
 *
 * DATA CONTRACT  (the app owns voice state — see voice-levels.js)
 *   id    : stable string, used to key the avatar-glow callback
 *   hue   : 0..359, the participant's colour (HSL hue)
 *   level : 0..1, smoothed instantaneous loudness ("glow & thicken")
 *   pluck : 0..1, transient spike on speech onset, you decay it toward 0
 *
 * The renderer never mutates voices; it only reads level+pluck each frame.
 * ==========================================================================*/

class LoomRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   * @param {'cloth'|'harp'|'web'} [opts.mode='cloth']
   * @param {() => Array<{id:string,hue:number,level:number,pluck:number}>} opts.getVoices
   * @param {(id:string, glowCss:string)=>void} [opts.onRing]  per-voice avatar glow
   * @param {number} [opts.maxDpr=2]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = opts.mode || 'cloth';
    this.getVoices = opts.getVoices || (() => []);
    this.onRing = opts.onRing || null;
    this.maxDpr = opts.maxDpr || 2;
    this._raf = 0;
    this._t0 = 0;
    this._dimW = 0;
    this._dimH = 0;
    this._animate = this._animate.bind(this);
  }

  setMode(mode) { this.mode = mode; }

  start() {
    if (this._raf) return;
    this._t0 = performance.now();
    this._raf = requestAnimationFrame(this._animate);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  destroy() { this.stop(); }

  // ---- HSL helpers -----------------------------------------------------------
  _hsl(h, s, l, a) {
    return a == null ? `hsl(${h},${s}%,${l}%)` : `hsla(${h},${s}%,${l}%,${a})`;
  }

  // ---- size canvas backing store for crisp lines on HiDPI --------------------
  _resize() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return false;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this._dimW = w; this._dimH = h;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    return true;
  }

  // ---- string displacement at fractional position tx (0..1) ------------------
  // env = sin(pi*tx) pins both ends to 0 and bulges the middle (a plucked string).
  // `harm` adds 2nd + 0.5x harmonics so cloth/web strings shimmer; harp stays pure.
  _disp(tx, amp, freq, t, harm) {
    const env = Math.sin(Math.PI * tx);
    let d = env * amp * Math.sin(2 * Math.PI * freq * t);
    if (harm) {
      d += env * amp * 0.34 * Math.sin(2 * Math.PI * freq * 2 * t + 1.1)
         + Math.sin(2 * Math.PI * tx) * amp * 0.18 * Math.sin(2 * Math.PI * freq * 0.5 * t);
    }
    return d;
  }

  // ---- draw one string (glow pass + bright core). Returns {amp}. -------------
  // offFn(tx) optionally bends the whole string's baseline (used for weaving).
  _drawString(ctx, x0, x1, y, v, rowH, t, mode, offFn) {
    const maxA = rowH * 0.34, pluckA = rowH * 0.42;
    const idle = 0.05 + 0.04 * Math.sin(t * 1.1 + v.phase);
    let amp = (v.level * maxA) + (v.pluck * pluckA) + idle * (rowH * 0.16);
    amp = Math.min(amp, rowH * 0.47);
    const harm = mode !== 'harp';
    const N = 46;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const tx = i / N;
      const x = x0 + (x1 - x0) * tx;
      const off = offFn ? offFn(tx) : 0;
      pts.push([x, y + off - this._disp(tx, amp, v.freq, t, harm)]);
    }
    const lvl = Math.min(1, v.level + v.pluck);
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // glow pass
    ctx.shadowBlur = 5 + lvl * 20;
    ctx.shadowColor = this._hsl(v.hue, 90, 62, 0.9);
    ctx.strokeStyle = this._hsl(v.hue, 78, 56 + lvl * 8, 0.55 + lvl * 0.4);
    ctx.lineWidth = 1.3 + v.level * 3 + v.pluck * 2.4;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    // bright core
    ctx.shadowBlur = 0;
    ctx.strokeStyle = this._hsl(v.hue, 100, 86, 0.25 + lvl * 0.6);
    ctx.lineWidth = 0.8 + lvl * 1.1;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.restore();
    return { amp };
  }

  // ---- the full loom frame ---------------------------------------------------
  _drawLoom(ctx, w, h, t) {
    const mode = this.mode;
    const raw = this.getVoices();
    const n = raw.length;
    if (!n) return;
    const rowH = h / n;
    const x0 = 6, x1 = w - 8;

    // each voice gets a stable phase/freq for organic idle motion
    this._phase = this._phase || {};
    const voices = raw.map((r, i) => {
      if (!this._phase[r.id]) this._phase[r.id] = Math.random() * 6.28;
      return {
        id: r.id, hue: r.hue,
        level: Math.max(0, Math.min(1, r.level || 0)),
        pluck: Math.max(0, Math.min(1, r.pluck || 0)),
        phase: this._phase[r.id],
        freq: 2.0 + i * 0.27,
      };
    });

    // ---- warp / scaffold (the static "loom frame") --------------------------
    if (mode === 'cloth') {
      const step = 26; ctx.lineWidth = 1;
      for (let x = x0 + step * 0.5; x < x1; x += step) {
        const dx = 2.2 * Math.sin(t * 0.3 + x * 0.05);
        ctx.strokeStyle = this._hsl(40, 55, 52, 0.10);
        ctx.beginPath(); ctx.moveTo(x + dx, 0); ctx.lineTo(x + dx, h); ctx.stroke();
      }
    } else if (mode === 'harp') {
      ctx.strokeStyle = this._hsl(40, 45, 55, 0.16); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x0, 6); ctx.lineTo(x0, h - 6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1, 6); ctx.lineTo(x1, h - 6); ctx.stroke();
    } else if (mode === 'web') {
      ctx.strokeStyle = this._hsl(264, 40, 55, 0.06); ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        const yy = (i + 0.5) / 5 * h;
        ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, h - yy); ctx.stroke();
      }
    }

    // ---- weave: when 2+ people speak, pull their strings together & braid ----
    const sd = voices.map((v, i) => ({
      v, i, y: (i + 0.5) * rowH, strength: Math.min(1, v.level + v.pluck),
    }));
    const active = sd.filter(d => d.strength > 0.2);
    let centerY = 0; active.forEach(d => centerY += d.y); if (active.length) centerY /= active.length;
    let spread = 0;
    if (active.length >= 2) {
      const ys = active.map(d => d.y);
      spread = Math.max(...ys) - Math.min(...ys);
    }
    const offFnFor = (d) => {
      if (active.length < 2 || d.strength <= 0.2) return null;
      const k = active.indexOf(d);
      const braidAmp = spread * 0.5 + rowH * 0.35;
      const up = -(d.y - 6), down = (h - 6 - d.y);
      return (tx) => {
        const env = Math.sin(Math.PI * tx);                       // ends stay anchored
        const pull = (centerY - d.y) * 0.6 * d.strength * env;     // gravitate to shared band
        const braid = Math.sin(2 * Math.PI * tx * 1.4 + k * (2 * Math.PI / active.length) + t * 2.0)
                    * braidAmp * d.strength * env;                 // cross over/under
        return Math.max(up, Math.min(down, pull + braid));
      };
    };

    const meta = [];
    for (const d of sd) {
      const off = offFnFor(d);
      const info = this._drawString(ctx, x0, x1, d.y, d.v, rowH, t, mode, off);
      meta.push({ v: d.v, y: d.y, amp: info.amp, offFn: off });
    }

    // ---- cloth interlace: paint warp segments OVER strings at "under" crossings
    if (mode === 'cloth') {
      const step = 26;
      for (let i = 0; i < n; i++) {
        const m = meta[i]; let col = 0;
        for (let x = x0 + step * 0.5; x < x1; x += step, col++) {
          if (((i + col) & 1) !== 0) continue;
          const tx = (x - x0) / (x1 - x0);
          const dx = 2.2 * Math.sin(t * 0.3 + x * 0.05);
          const yy = m.y + (m.offFn ? m.offFn(tx) : 0) - this._disp(tx, m.amp, m.v.freq, t, true);
          ctx.strokeStyle = this._hsl(40, 60, 56, 0.34);
          ctx.lineWidth = 2.4;
          ctx.beginPath();
          ctx.moveTo(x + dx, yy - rowH * 0.28);
          ctx.lineTo(x + dx, yy + rowH * 0.28);
          ctx.stroke();
        }
      }
    }

    // ---- harp pegs at the left rail ----------------------------------------
    if (mode === 'harp') {
      for (let i = 0; i < n; i++) {
        const m = meta[i];
        ctx.fillStyle = this._hsl(m.v.hue, 70, 60, 0.9);
        ctx.beginPath(); ctx.arc(x0, m.y, 3.1, 0, 6.28); ctx.fill();
      }
    }

    // ---- web: glowing connectors between every pair of active speakers ------
    if (mode === 'web') {
      const act = meta.filter(m => (m.v.level + m.v.pluck) > 0.18);
      for (let a = 0; a < act.length; a++) {
        for (let b = a + 1; b < act.length; b++) {
          const A = act[a], B = act[b];
          const strength = Math.min(A.v.level + A.v.pluck, B.v.level + B.v.pluck);
          const ax = (x0 + x1) / 2, ay = A.y + (A.offFn ? A.offFn(0.5) : 0) - A.amp * 0.7;
          const bx = (x0 + x1) / 2, by = B.y + (B.offFn ? B.offFn(0.5) : 0) - B.amp * 0.7;
          ctx.save();
          ctx.shadowBlur = 8 * strength; ctx.shadowColor = this._hsl(A.v.hue, 80, 60, 0.6);
          const g = ctx.createLinearGradient(ax, ay, bx, by);
          g.addColorStop(0, this._hsl(A.v.hue, 80, 62, 0.16 + strength * 0.5));
          g.addColorStop(1, this._hsl(B.v.hue, 80, 62, 0.16 + strength * 0.5));
          ctx.strokeStyle = g; ctx.lineWidth = 0.8 + strength * 2.2;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.quadraticCurveTo((ax + bx) / 2 + 18 * Math.sin(t * 1.5), (ay + by) / 2, bx, by);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // ---- reflect each level onto the avatar ring via callback ---------------
    if (this.onRing) {
      for (const m of meta) {
        const lvl = Math.min(1, m.v.level + m.v.pluck);
        const glow = lvl > 0.04
          ? `0 0 0 ${1.5 + lvl * 2.5}px ${this._hsl(m.v.hue, 80, 55, 0.18 + lvl * 0.4)}, 0 0 ${lvl * 16}px ${this._hsl(m.v.hue, 85, 55, lvl * 0.5)}`
          : 'none';
        this.onRing(m.v.id, glow);
      }
    }
  }

  _animate(now) {
    try {
      const t = (now - this._t0) / 1000;
      if (this._resize()) {
        this._drawLoom(this.ctx, this._dimW, this._dimH, t);
      }
    } catch (e) {
      /* keep the loom alive even if one frame misbehaves */
    }
    this._raf = requestAnimationFrame(this._animate);
  }
}

/* ----------------------------------------------------------------------------
 * Convenience: derive the link/avatar gradient for a hue (matches the prototype)
 * --------------------------------------------------------------------------*/
function avatarGradient(hue) {
  return `linear-gradient(135deg, hsl(${hue},68%,62%), hsl(${hue + 26},62%,48%))`;
}

/* Per-user hue palette used by the prototype (violet, red, cyan, green, pink, gold) */
const HUE_PALETTE = [268, 20, 198, 142, 330, 46];

// ---- expose as globals (Weave loads classic scripts, not ES modules) --------
window.LoomRenderer = LoomRenderer;
window.avatarGradient = avatarGradient;
window.HUE_PALETTE = HUE_PALETTE;
