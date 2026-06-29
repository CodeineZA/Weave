/* ============================================================================
 * Weave — Channel background  "The Gathering"  (Option B)
 * Framework-agnostic, zero dependencies.
 * ----------------------------------------------------------------------------
 * A slowly-weaving field of strands behind the chat whitespace: ONE STRAND PER
 * PERSON in the channel (the weave grows as people arrive, thins as they leave),
 * with the PACE driven by channel "noise" alone, eased very gradually.
 *
 * Ported from the design handoff ES module to a classic-script global (Weave
 * uses no ES modules). Drawing math is verbatim; wrapped in an IIFE so its
 * top-level names can't collide with the other engine scripts, and exposed as
 * window.ChannelWeave at the foot.
 * ==========================================================================*/
(function () {
  const HUE_PALETTE = [268, 20, 198, 142, 330, 46, 290, 174, 312, 100, 232, 8];

  // pace, in phase-radians per second, before paceScale
  const PACE_IDLE = 0.10;   // a silent channel still drifts, very slowly
  const PACE_GAIN = 0.55;   // extra pace at full noise
  const PACE_EASE = 0.28;   // per-second approach rate → "very gradual" ramp
  const PRESENCE  = 0.9;    // join / leave fade rate (≈1.1s to fully fade)

  class ChannelWeave {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.getState = opts.getState || (() => ({ participants: [], noise: 0 }));
      this.paceScale = opts.paceScale ?? 1.0;
      this.maxDpr = opts.maxDpr || 2;
      this.reduceMotion = opts.reduceMotion ??
        (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

      this.order = [];          // ordered list of strand ids currently drawn (incl. fading-out)
      this.strands = new Map(); // id -> { hue, phase, kjit, ajit, present, target }
      this.phase = 0;           // accumulated weave phase
      this.spd = PACE_IDLE * this.paceScale;
      this.drift = 0;
      this.effNoise = 0;
      this._raf = 0;
      this._last = 0;
      this._animate = this._animate.bind(this);
    }

    start() { if (!this._raf) { this._t0 = performance.now(); this._raf = requestAnimationFrame(this._animate); } }
    stop()  { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; }
    destroy() { this.stop(); }

    _hsl(h, s, l, a) { return a == null ? `hsl(${h},${s}%,${l}%)` : `hsla(${h},${s}%,${l}%,${a})`; }

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

    // reconcile the drawn strand set with the current participant list
    _sync(participants, dt) {
      const want = new Map(participants.map(p => [p.id, p]));
      // add newcomers (append → they slot in at the bottom, then everything reflows)
      let slot = this.order.length;
      for (const p of participants) {
        if (!this.strands.has(p.id)) {
          this.order.push(p.id);
          this.strands.set(p.id, {
            hue: p.hue,
            phase: slot * 0.85,
            kjit: (slot % 3 - 1) * 0.06,                 // tiny spatial-freq offset → crossings
            ajit: 0.82 + ((slot * 37) % 100) / 100 * 0.3, // amplitude jitter → organic weave
            present: 0, target: 1,
          });
          slot++;
        }
      }
      // set targets + ease presence; keep latest hue if a person recoloured
      for (const id of this.order) {
        const st = this.strands.get(id);
        const live = want.get(id);
        st.target = live ? 1 : 0;
        if (live) st.hue = live.hue;
        st.present += (st.target - st.present) * Math.min(1, dt * PRESENCE * (this.reduceMotion ? 4 : 1));
      }
      // retire fully-faded departures
      this.order = this.order.filter(id => {
        const st = this.strands.get(id);
        if (st.target === 0 && st.present < 0.02) { this.strands.delete(id); return false; }
        return true;
      });
    }

    _drawStrand(ctx, w, baseY, spacing, st, activity) {
      const lam = w * 0.55;                 // base wavelength
      const amp = spacing * 0.92;           // > spacing so neighbours overlap and weave
      const N = 56;
      const kx = (2 * Math.PI / lam) * (1 + st.kjit);
      const a = (0.11 + activity * 0.11) * st.present;   // low opacity, lifts a touch with noise
      if (a <= 0.002) return;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const x = (w * i) / N;
        const y = baseY
          + amp * st.ajit * Math.sin(kx * x + this.phase + st.phase)
          + amp * 0.28    * Math.sin(kx * 1.7 * x - this.phase * 0.6 + st.phase * 1.4);
        pts.push([x, y]);
      }
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      // soft glow body
      ctx.shadowBlur = 6 + activity * 12;
      ctx.shadowColor = this._hsl(st.hue, 88, 62, 0.85 * st.present);
      ctx.strokeStyle = this._hsl(st.hue, 74, 60, a);
      ctx.lineWidth = 4.0 + activity * 2.8;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      // bright thread core
      ctx.shadowBlur = 0;
      ctx.strokeStyle = this._hsl(st.hue, 100, 84, a * 0.9);
      ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
      ctx.restore();
    }

    _animate(now) {
      const dim = this._resize();
      const dt = Math.min(0.05, this._last ? (now - this._last) / 1000 : 0.016);
      this._last = now;
      if (!dim) { this._raf = requestAnimationFrame(this._animate); return; }

      let state;
      try { state = this.getState() || {}; } catch (e) { state = {}; }
      const participants = state.participants || [];
      const noise = Math.max(0, Math.min(1, state.noise || 0));

      this._sync(participants, dt);

      // smoothed noise → eased pace (the gradual scale up/down)
      this.effNoise += (noise - this.effNoise) * Math.min(1, dt * 2.0);
      const target = (PACE_IDLE + this.effNoise * PACE_GAIN) * this.paceScale;
      this.spd += (target - this.spd) * Math.min(1, dt * PACE_EASE);

      if (!this.reduceMotion) {
        this.phase += dt * this.spd;
        this.drift += dt * 0.05;
      }

      const { w, h } = dim;
      const n = Math.max(1, this.order.length);
      const spacing = h / n;
      const fieldDrift = Math.sin(this.drift) * spacing * 0.12;
      for (let s = 0; s < this.order.length; s++) {
        const st = this.strands.get(this.order[s]);
        this._drawStrand(this.ctx, w, (s + 0.5) * spacing + fieldDrift, spacing, st, this.effNoise);
      }
      this._raf = requestAnimationFrame(this._animate);
    }
  }

  // ---- expose as global (Weave loads classic scripts, not ES modules) -------
  window.ChannelWeave = ChannelWeave;
  window.CHANNEL_HUE_PALETTE = HUE_PALETTE;
})();
