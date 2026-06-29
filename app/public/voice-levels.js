/* ============================================================================
 * Weave — Voice level tracking helper  (Web Audio → loom data contract)
 * ----------------------------------------------------------------------------
 * The LoomRenderer is presentation-only: it asks for { id, hue, level, pluck }
 * each frame. VoiceMeter produces `level` (smoothed RMS) and `pluck` (onset
 * transient) from a real MediaStream — one meter per participant stream.
 *
 * Ported from the design handoff ES module to a classic-script global (Weave
 * uses no ES modules). The no-mic simulator from the handoff is omitted — Weave
 * drives the loom from real audio. Only `export` was removed and
 * `window.VoiceMeter` added at the foot.
 * ==========================================================================*/

class VoiceMeter {
  /**
   * @param {AudioContext} audioCtx
   * @param {MediaStream}  stream     mic or remote participant stream
   * @param {object} [opts]
   * @param {number} [opts.smoothing=0.18]  level attack/decay (0..1 per frame)
   * @param {number} [opts.gain=1.8]        scales RMS into a usable 0..1 range
   * @param {number} [opts.pluckThreshold=0.12] rise in level that triggers a pluck
   */
  constructor(audioCtx, stream, opts = {}) {
    this.smoothing = opts.smoothing ?? 0.18;
    // Sensitivity for soft / suppressed mics. `level` is mapped pow(rms*gain, curve): the
    // gain is a flat boost and curve < 1 lifts quiet speech while compressing loud mics, so
    // soft voices still register and bounce. Raise gain / lower curve for even more sensitivity.
    this.gain = opts.gain ?? 2.6;
    this.curve = opts.curve ?? 0.6;
    // Pluck = the visible "bounce" on speech onset. Lower gate/threshold so soft onsets fire it;
    // higher response makes the bounce bigger.
    this.pluckThreshold = opts.pluckThreshold ?? 0.06;
    this.pluckGate = opts.pluckGate ?? 0.08;
    this.pluckResponse = opts.pluckResponse ?? 3.2;
    this.level = 0;
    this.pluck = 0;
    this._prev = 0;
    this._src = audioCtx.createMediaStreamSource(stream);
    this._analyser = audioCtx.createAnalyser();
    this._analyser.fftSize = 512;
    this._analyser.smoothingTimeConstant = 0.6;
    this._src.connect(this._analyser);
    this._buf = new Uint8Array(this._analyser.fftSize);
  }

  /** Call once per animation frame BEFORE reading .level / .pluck */
  sample() {
    this._analyser.getByteTimeDomainData(this._buf);
    let sum = 0;
    for (let i = 0; i < this._buf.length; i++) {
      const x = (this._buf[i] - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / this._buf.length);
    // perceptual sensitivity curve — lifts quiet speech, compresses loud (see constructor)
    const target = Math.min(1, Math.pow(rms * this.gain, this.curve));
    // onset detection → transient pluck (the visible bounce)
    if (target - this._prev > this.pluckThreshold && target > this.pluckGate) {
      this.pluck = Math.min(1, this.pluck + (target - this._prev) * this.pluckResponse);
    }
    this._prev = target;
    // smooth the level, decay the pluck (~settles within ~1s)
    this.level += (target - this.level) * this.smoothing;
    this.pluck *= 0.92;
    return this;
  }

  /** Force a pluck (e.g. user clicked their own string) */
  trigger() { this.pluck = 1; }

  disconnect() { try { this._src.disconnect(); this._analyser.disconnect(); } catch (e) {} }
}

// ---- expose as global (Weave loads classic scripts, not ES modules) ---------
window.VoiceMeter = VoiceMeter;
