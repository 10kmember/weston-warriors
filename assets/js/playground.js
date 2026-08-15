/**
 * playground.js — section 04, "The Proving Ground".
 *
 * Binds the 2D engine in physics.js to a canvas renderer, pointer/keyboard
 * input, and the Web Audio engine. Every collision the solver reports becomes
 * a synthesised impact, panned to where it happened on screen.
 */

import { World, Body } from './physics.js';

const PALETTE = {
  ink: '#0A0A0A',
  ember: '#FF5500',
  bronze: '#8C5A2B',
  bone: '#F4F4F5',
};

const KIT = [
  { label: 'GLOVE',  r: 0.40, density: 1.0, restitution: 0.56, friction: 0.30, tint: PALETTE.ember },
  { label: 'GLOVE',  r: 0.40, density: 1.0, restitution: 0.56, friction: 0.30, tint: PALETTE.ember },
  { label: 'MEDBALL',r: 0.62, density: 2.6, restitution: 0.22, friction: 0.55, tint: PALETTE.bronze },
  { label: 'SPEED',  r: 0.26, density: 0.6, restitution: 0.80, friction: 0.14, tint: PALETTE.bone },
  { label: 'SPEED',  r: 0.26, density: 0.6, restitution: 0.80, friction: 0.14, tint: PALETTE.bone },
  { label: 'HEAVY',  r: 0.74, density: 3.4, restitution: 0.14, friction: 0.62, tint: PALETTE.bronze },
  { label: 'WRAP',   r: 0.30, density: 0.8, restitution: 0.42, friction: 0.44, tint: PALETTE.bone },
  { label: 'MITT',   r: 0.36, density: 1.1, restitution: 0.48, friction: 0.36, tint: PALETTE.ember },
  { label: 'ROPE',   r: 0.33, density: 1.4, restitution: 0.30, friction: 0.50, tint: PALETTE.bronze },
];

const MAX_BODIES = 26;
const WORLD_WIDTH = 12;          // world units across the canvas
const THROW_SCALE = 1.0;
const MAX_THROW = 26;            // units/s

export function initPlayground({ canvas, audio, reduceMotion = false }) {
  if (!canvas) return null;

  const ctx = canvas.getContext('2d');
  const world = new World({ width: WORLD_WIDTH, height: 7, gravity: 18 });

  const ui = {
    bodies:  document.getElementById('rd-bodies'),
    impacts: document.getElementById('rd-impacts'),
    peak:    document.getElementById('rd-peak'),
    gravity: document.getElementById('rd-gravity'),
    fps:     document.getElementById('play-fps'),
    hint:    document.getElementById('play-hint'),
  };

  const state = {
    scale: 60,            // pixels per world unit
    dpr: 1,
    impacts: 0,
    peak: 0,
    fps: 60,
    running: false,
    visible: false,
    interacted: false,
    zeroG: false,
  };

  const ripples = [];
  const pointer = { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, down: false, id: null };
  let held = null;
  let heldInvMass = 0;

  /* ------------------------------------------------------------- geometry */

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * state.dpr);
    canvas.height = Math.round(rect.height * state.dpr);
    state.scale = canvas.width / world.width;
    world.height = canvas.height / state.scale;
    // keep everything inside the new box
    for (const b of world.bodies) {
      b.x = Math.min(Math.max(b.x, b.r), world.width - b.r);
      b.y = Math.min(Math.max(b.y, b.r), world.height - b.r);
    }
  }

  const toWorld = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * world.width,
      y: ((clientY - rect.top) / rect.height) * world.height,
    };
  };

  /* --------------------------------------------------------------- bodies */

  function populate() {
    world.clear();
    KIT.forEach((spec, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      world.add(new Body({
        ...spec,
        x: world.width * (0.18 + col * 0.22) + (Math.random() - 0.5) * 0.3,
        y: 1.1 + row * 1.5,
        vx: (Math.random() - 0.5) * 2,
        vy: 0,
      }));
    });
    state.impacts = 0;
    state.peak = 0;
    syncReadouts();
  }

  function addGlove() {
    if (world.bodies.length >= MAX_BODIES) return;
    const spec = KIT[Math.floor(Math.random() * KIT.length)];
    world.add(new Body({
      ...spec,
      x: world.width * (0.25 + Math.random() * 0.5),
      y: 0.9,
      vx: (Math.random() - 0.5) * 5,
      vy: 1,
    }));
    world.wake();
    syncReadouts();
  }

  /* --------------------------------------------------------------- audio  */

  world.onCollision = (impulse, x, y) => {
    state.impacts++;
    if (impulse > state.peak) state.peak = impulse;
    ripples.push({ x, y, r: 0, life: 1, power: Math.min(1, impulse / 3) });
    if (ripples.length > 40) ripples.shift();

    if (audio) {
      const strength = Math.min(1, impulse / 3.6);
      const pan = (x / world.width) * 2 - 1;
      audio.impact(strength, pan * 0.85, 0.5);
    }
  };

  /* ---------------------------------------------------------------- input */

  function firstTouch() {
    if (state.interacted) return;
    state.interacted = true;
    ui.hint?.classList.add('is-hidden');
    audio?.start();
  }

  function grab(x, y) {
    const body = world.pick(x, y, 0.12);
    if (!body) return false;
    held = body;
    heldInvMass = body.invMass;
    body.held = true;
    body.invMass = 0;          // kinematic while carried: it pushes, nothing pushes it
    body.sleeping = false;
    body.spin *= 0.3;
    return true;
  }

  function release() {
    if (!held) return;
    held.held = false;
    held.invMass = heldInvMass;
    const speed = Math.hypot(pointer.vx, pointer.vy);
    const clamp = speed > MAX_THROW ? MAX_THROW / speed : 1;
    held.vx = pointer.vx * THROW_SCALE * clamp;
    held.vy = pointer.vy * THROW_SCALE * clamp;
    held.spin += (Math.random() - 0.5) * 4 + held.vx * 0.4;
    held = null;
    world.wake();
  }

  function onPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    firstTouch();
    const p = toWorld(event.clientX, event.clientY);
    pointer.x = pointer.px = p.x;
    pointer.y = pointer.py = p.y;
    pointer.vx = pointer.vy = 0;
    pointer.down = true;
    pointer.id = event.pointerId;
    canvas.setPointerCapture?.(event.pointerId);

    if (!grab(p.x, p.y)) {
      // empty floor: directional shockwave from the click point
      world.blast(p.x, p.y, 7.5, 4.2);
      ripples.push({ x: p.x, y: p.y, r: 0, life: 1, power: 1 });
      audio?.boom(0.65);
      world.wake();
    }
    event.preventDefault();
  }

  function onPointerMove(event) {
    const p = toWorld(event.clientX, event.clientY);
    pointer.x = p.x;
    pointer.y = p.y;
    if (pointer.down) event.preventDefault();
  }

  function onPointerUp(event) {
    if (pointer.id != null && event.pointerId !== pointer.id) return;
    release();
    pointer.down = false;
    pointer.id = null;
    canvas.releasePointerCapture?.(event.pointerId);
  }

  function onKeyDown(event) {
    const key = event.key.toLowerCase();
    if (key === 's') { firstTouch(); shockwave(); }
    else if (key === 'r') { firstTouch(); populate(); }
    else if (key === 'g') { firstTouch(); toggleGravity(); }
    else if (key === 'a') { firstTouch(); addGlove(); }
    else return;
    event.preventDefault();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('keydown', onKeyDown);

  /* ------------------------------------------------------------- controls */

  function shockwave() {
    world.blast(world.width / 2, world.height * 0.72, 13, world.width);
    ripples.push({ x: world.width / 2, y: world.height * 0.72, r: 0, life: 1, power: 1 });
    audio?.start();
    audio?.boom(1);
    world.wake();
  }

  function toggleGravity() {
    state.zeroG = !state.zeroG;
    world.gravity = state.zeroG ? 0 : 18;
    if (state.zeroG) {
      for (const b of world.bodies) {
        b.sleeping = false;
        b.vx += (Math.random() - 0.5) * 3;
        b.vy -= 2 + Math.random() * 2;
      }
    }
    world.wake();
    syncReadouts();
    return state.zeroG;
  }

  /* ------------------------------------------------------------ readouts  */

  function syncReadouts() {
    if (ui.bodies) ui.bodies.textContent = String(world.bodies.length).padStart(2, '0');
    if (ui.gravity) ui.gravity.textContent = state.zeroG ? '0.00 G' : '1.00 G';
  }

  let readoutClock = 0;
  function tickReadouts(dt) {
    readoutClock += dt;
    if (readoutClock < 0.1) return;
    readoutClock = 0;
    if (ui.impacts) ui.impacts.textContent = String(state.impacts).padStart(4, '0');
    if (ui.peak) ui.peak.textContent = state.peak.toFixed(2);
    if (ui.fps) ui.fps.textContent = `${Math.round(state.fps)} FPS`;
  }

  /* -------------------------------------------------------------- drawing */

  function drawFurniture() {
    const s = state.scale;
    const w = canvas.width;
    const h = canvas.height;

    ctx.save();
    // faint ring lattice
    ctx.strokeStyle = 'rgba(244,244,245,0.05)';
    ctx.lineWidth = 1;
    const gap = s * 0.75;
    ctx.beginPath();
    for (let x = gap; x < w; x += gap) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = gap; y < h; y += gap) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();

    // canvas floor + ropes, drawn as ring furniture
    ctx.strokeStyle = 'rgba(140,90,43,0.55)';
    ctx.lineWidth = 2 * state.dpr;
    ctx.beginPath();
    ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(140,90,43,0.22)';
    ctx.lineWidth = 1.5 * state.dpr;
    for (let i = 1; i <= 3; i++) {
      const y = h - (h * 0.06 * i) - h * 0.02;
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(w, y);
      ctx.stroke();
    }

    // corner posts
    ctx.fillStyle = 'rgba(140,90,43,0.35)';
    const postW = 4 * state.dpr;
    const postH = h * 0.26;
    ctx.fillRect(0, h - postH, postW, postH);
    ctx.fillRect(w - postW, h - postH, postW, postH);
    ctx.restore();
  }

  function drawRipples(dt) {
    const s = state.scale;
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      rp.r += (2.2 + rp.power * 5) * dt;
      rp.life -= dt * 1.7;
      if (rp.life <= 0) { ripples.splice(i, 1); continue; }
      ctx.beginPath();
      ctx.arc(rp.x * s, rp.y * s, rp.r * s, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,85,0,${(rp.life * 0.5 * rp.power).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, 2 * state.dpr * rp.life);
      ctx.stroke();
    }
  }

  function drawBody(b) {
    const s = state.scale;
    const cx = b.x * s;
    const cy = b.y * s;
    const r = b.r * s;
    const hot = Math.min(1, b.flash);

    // motion smear
    const speed = b.speed;
    if (speed > 3 && !b.held) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx - b.vx * s * 0.045, cy - b.vy * s * 0.045);
      ctx.strokeStyle = `rgba(255,85,0,${Math.min(0.35, speed / 60).toFixed(3)})`;
      ctx.lineWidth = r * 1.4;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(cx, cy);

    // body fill
    const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.10)');
    grad.addColorStop(1, 'rgba(10,10,10,0.86)');
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // rim, brightened by recent impact
    ctx.lineWidth = (b.held ? 2.4 : 1.4) * state.dpr;
    ctx.strokeStyle = b.tint;
    ctx.globalAlpha = 0.55 + hot * 0.45 + (b.held ? 0.3 : 0);
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (hot > 0.02) {
      ctx.beginPath();
      ctx.arc(0, 0, r + 3 * state.dpr * hot, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,85,0,${(hot * 0.5).toFixed(3)})`;
      ctx.lineWidth = 1.5 * state.dpr;
      ctx.stroke();
    }

    // seam, so rotation is legible
    ctx.rotate(b.angle);
    ctx.beginPath();
    ctx.moveTo(-r * 0.72, 0);
    ctx.lineTo(r * 0.72, 0);
    ctx.strokeStyle = 'rgba(244,244,245,0.16)';
    ctx.lineWidth = 1 * state.dpr;
    ctx.stroke();
    ctx.rotate(-b.angle);

    // label
    if (r > 18 * state.dpr) {
      ctx.fillStyle = 'rgba(244,244,245,0.68)';
      ctx.font = `${Math.round(8 * state.dpr)}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, 0, 0);
    }
    ctx.restore();
  }

  function render(dt) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawFurniture();
    drawRipples(dt);
    for (const b of world.bodies) drawBody(b);

    // tether line while dragging
    if (held) {
      const s = state.scale;
      ctx.beginPath();
      ctx.moveTo(held.x * s, held.y * s);
      ctx.lineTo(pointer.x * s, pointer.y * s);
      ctx.strokeStyle = 'rgba(255,85,0,0.35)';
      ctx.lineWidth = 1 * state.dpr;
      ctx.setLineDash([4 * state.dpr, 4 * state.dpr]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /* ----------------------------------------------------------------- loop */

  let raf = 0;
  let last = 0;

  function frame(now) {
    if (!state.running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000 || 0.016, 0.05);
    last = now;
    state.fps += ((1 / Math.max(dt, 0.001)) - state.fps) * 0.08;

    // carry the held body and derive throw velocity from pointer motion
    if (held) {
      const nx = Math.min(Math.max(pointer.x, held.r), world.width - held.r);
      const ny = Math.min(Math.max(pointer.y, held.r), world.height - held.r);
      held.vx = (nx - held.x) / Math.max(dt, 0.001);
      held.vy = (ny - held.y) / Math.max(dt, 0.001);
      held.x = nx;
      held.y = ny;
      held.angle += held.vx * dt * 0.5;
    }
    pointer.vx = (pointer.x - pointer.px) / Math.max(dt, 0.001);
    pointer.vy = (pointer.y - pointer.py) / Math.max(dt, 0.001);
    pointer.px = pointer.x;
    pointer.py = pointer.y;

    world.update(dt);
    render(dt);
    tickReadouts(dt);
  }

  function start() {
    if (state.running) return;
    state.running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    state.running = false;
    cancelAnimationFrame(raf);
  }

  /* ------------------------------------------------------ lifecycle glue  */

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  populate();
  if (reduceMotion) {
    // settle the pile without animating it, then hold still until touched
    for (let i = 0; i < 240; i++) world.step(1 / 120);
  }

  const io = new IntersectionObserver((entries) => {
    state.visible = entries.some((e) => e.isIntersecting);
    if (state.visible && !document.hidden) start(); else stop();
  }, { threshold: 0.05 });
  io.observe(canvas);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (state.visible) start();
  });

  // control buttons
  document.getElementById('ctl-shock')?.addEventListener('click', () => { firstTouch(); shockwave(); });
  document.getElementById('ctl-add')?.addEventListener('click', () => { firstTouch(); addGlove(); });
  document.getElementById('ctl-reset')?.addEventListener('click', () => { populate(); world.wake(); });
  const gravityBtn = document.getElementById('ctl-gravity');
  gravityBtn?.addEventListener('click', () => {
    firstTouch();
    const zero = toggleGravity();
    gravityBtn.setAttribute('aria-pressed', String(zero));
    gravityBtn.textContent = zero ? 'Restore Gravity' : 'Cut Gravity';
  });

  syncReadouts();

  return { world, start, stop, reset: populate, shockwave, addGlove, toggleGravity };
}
