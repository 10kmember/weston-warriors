/**
 * audio.js — Weston Warriors sound engine.
 *
 * Everything is synthesised at runtime with the Web Audio API; the site ships
 * no audio files. Two layers:
 *
 *   1. AMBIENT DRONE — three detuned low oscillators plus a filtered noise bed,
 *      swept by a slow LFO on the master lowpass. The "room tone" of the arena.
 *   2. IMPACT SFX    — a noise burst (leather/canvas) stacked with a pitch-swept
 *      sine (the thud), stereo-panned to where the collision happened and gain-
 *      scaled by collision impulse.
 *
 * Browsers block audio until a user gesture, so the context is created lazily
 * and resumed on the first interaction. Muted state persists in localStorage.
 */

const STORE_KEY = 'ww:audio';
const MASTER_LEVEL = 0.5;
const DRONE_LEVEL = 0.16;

export function createAudioEngine() {
  let ctx = null;
  let master = null;      // final gain, ramped for mute
  let droneBus = null;
  let noiseBuffer = null;
  let started = false;
  let muted = readStored();
  let lastImpactAt = 0;
  let voices = 0;         // live one-shot voices, for cheap throttling
  const listeners = new Set();

  function readStored() {
    try { return localStorage.getItem(STORE_KEY) !== 'on'; } catch { return true; }
  }
  function writeStored() {
    try { localStorage.setItem(STORE_KEY, muted ? 'off' : 'on'); } catch { /* private mode */ }
  }

  /* ------------------------------------------------------------------ core */

  function ensureContext() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;

    ctx = new AC();

    // Soft limiter so stacked impacts never clip the drone.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 12;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;

    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(limiter);
    limiter.connect(ctx.destination);

    noiseBuffer = makeNoiseBuffer(ctx, 1.2);
    return ctx;
  }

  function makeNoiseBuffer(context, seconds) {
    const len = Math.floor(context.sampleRate * seconds);
    const buffer = context.createBuffer(1, len, context.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      // mild low-pass on the noise source: less hiss, more air
      last = (last + 0.035 * white) / 1.035;
      data[i] = last * 3.2;
    }
    return buffer;
  }

  /* ----------------------------------------------------------------- drone */

  function buildDrone() {
    if (droneBus) return;

    droneBus = ctx.createGain();
    droneBus.gain.value = DRONE_LEVEL;

    const shape = ctx.createBiquadFilter();
    shape.type = 'lowpass';
    shape.frequency.value = 220;
    shape.Q.value = 6;
    shape.connect(droneBus);
    droneBus.connect(master);

    // Slow filter sweep — the room breathing.
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.045;
    lfoGain.gain.value = 130;
    lfo.connect(lfoGain);
    lfoGain.connect(shape.frequency);
    lfo.start();

    // Voices: sub, root, and a bronze-coloured fifth.
    const voiceSpecs = [
      { type: 'sine',     freq: 27.5,  gain: 0.85, detune: 0 },
      { type: 'sawtooth', freq: 55.0,  gain: 0.30, detune: -6 },
      { type: 'sawtooth', freq: 55.0,  gain: 0.26, detune: +7 },
      { type: 'triangle', freq: 82.41, gain: 0.18, detune: +3 },
    ];
    for (const spec of voiceSpecs) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = spec.type;
      osc.frequency.value = spec.freq;
      osc.detune.value = spec.detune;
      gain.gain.value = spec.gain;
      osc.connect(gain);
      gain.connect(shape);
      osc.start();
    }

    // Distant wind / crowd bed.
    const air = ctx.createBufferSource();
    air.buffer = noiseBuffer;
    air.loop = true;
    const airBand = ctx.createBiquadFilter();
    airBand.type = 'bandpass';
    airBand.frequency.value = 420;
    airBand.Q.value = 0.7;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.05;
    air.connect(airBand);
    airBand.connect(airGain);
    airGain.connect(droneBus);
    air.start();

    // Very slow amplitude drift so the bed never feels looped.
    const drift = ctx.createOscillator();
    const driftGain = ctx.createGain();
    drift.frequency.value = 0.021;
    driftGain.gain.value = 0.03;
    drift.connect(driftGain);
    driftGain.connect(airGain.gain);
    drift.start();
  }

  /* ------------------------------------------------------------ public API */

  /** Boot the graph. Safe to call repeatedly and from any user gesture. */
  function start() {
    if (!ensureContext()) return false;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (!started) {
      buildDrone();
      started = true;
    }
    applyGain(muted ? 0 : MASTER_LEVEL, 1.8);
    return true;
  }

  function applyGain(value, seconds) {
    if (!master) return;
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(value, now + seconds);
  }

  function setMuted(next) {
    muted = !!next;
    writeStored();
    if (!muted) start();
    else applyGain(0, 0.4);
    listeners.forEach((fn) => fn(muted));
    return muted;
  }

  const toggle = () => setMuted(!muted);
  const isMuted = () => muted;
  const onChange = (fn) => { listeners.add(fn); fn(muted); return () => listeners.delete(fn); };

  /**
   * Collision sound.
   * @param {number} strength 0..1 — normalised collision impulse.
   * @param {number} pan      -1..1 — stereo position of the impact.
   * @param {number} weight   0..1 — heavier bodies read lower and longer.
   */
  function impact(strength, pan = 0, weight = 0.5) {
    if (muted || !started || !ctx || ctx.state !== 'running') return;

    const now = ctx.currentTime;
    // Throttle: dense pile-ups would otherwise sound like static.
    if (now - lastImpactAt < 0.022 || voices > 12) return;
    lastImpactAt = now;

    const s = Math.min(1, Math.max(0.05, strength));
    const level = 0.10 + s * 0.55;
    const decay = 0.06 + s * 0.16 + weight * 0.1;

    const out = createPanner(pan);
    out.connect(master);
    voices++;
    window.setTimeout(() => { voices--; }, (decay + 0.4) * 1000);

    // — leather crack: filtered noise burst
    const burst = ctx.createBufferSource();
    burst.buffer = noiseBuffer;
    burst.playbackRate.value = 0.75 + Math.random() * 0.6;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(600 + s * 2400, now);
    band.frequency.exponentialRampToValueAtTime(180 + s * 300, now + decay);
    band.Q.value = 1.1;
    const burstGain = ctx.createGain();
    burstGain.gain.setValueAtTime(0.0001, now);
    burstGain.gain.exponentialRampToValueAtTime(level, now + 0.004);
    burstGain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    burst.connect(band); band.connect(burstGain); burstGain.connect(out);
    burst.start(now, Math.random() * 0.4, decay + 0.05);

    // — body: pitch-swept sine, lower for heavier objects
    const thud = ctx.createOscillator();
    const thudGain = ctx.createGain();
    const top = 210 - weight * 90 + s * 90;
    thud.type = 'sine';
    thud.frequency.setValueAtTime(top, now);
    thud.frequency.exponentialRampToValueAtTime(Math.max(28, top * 0.28), now + decay * 1.4);
    thudGain.gain.setValueAtTime(0.0001, now);
    thudGain.gain.exponentialRampToValueAtTime(level * 0.9, now + 0.006);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, now + decay * 1.5);
    thud.connect(thudGain); thudGain.connect(out);
    thud.start(now); thud.stop(now + decay * 1.6);
  }

  /** Low swell used for the shockwave / boost gesture. */
  function boom(intensity = 1) {
    if (muted || !started || !ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const out = createPanner(0);
    out.connect(master);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120 * intensity, now);
    osc.frequency.exponentialRampToValueAtTime(26, now + 0.9);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.55 * intensity, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
    osc.connect(gain); gain.connect(out);
    osc.start(now); osc.stop(now + 1.2);

    const air = ctx.createBufferSource();
    air.buffer = noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 700;
    const airGain = ctx.createGain();
    airGain.gain.setValueAtTime(0.22 * intensity, now);
    airGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    air.connect(hp); hp.connect(airGain); airGain.connect(out);
    air.start(now, 0, 0.6);
  }

  function createPanner(pan) {
    const clamped = Math.max(-1, Math.min(1, pan));
    if (ctx.createStereoPanner) {
      const node = ctx.createStereoPanner();
      node.pan.value = clamped;
      return node;
    }
    // Safari fallback: equal-power pan on a 3D panner.
    const node = ctx.createPanner();
    node.panningModel = 'equalpower';
    node.setPosition(clamped, 0, 1 - Math.abs(clamped) * 0.5);
    return node;
  }

  return { start, toggle, setMuted, isMuted, onChange, impact, boom };
}
