/**
 * physics.js — a small, dependency-free 2D rigid-body engine.
 *
 * Scope is deliberately narrow: circles in an axis-aligned box, which is all
 * the Proving Ground needs and lets the whole solver stay readable.
 *
 *   · semi-implicit Euler integration on a fixed 120 Hz substep
 *   · mass-weighted impulse resolution with per-body restitution
 *   · Coulomb friction on the collision tangent
 *   · Baumgarte-style positional correction so stacks do not sink
 *   · grabbed bodies become infinite-mass kinematic movers, so dragging one
 *     body genuinely shoves the others
 *
 * Units are world units (roughly metres); the renderer maps them to pixels.
 */

export class Body {
  constructor(opts = {}) {
    this.x = opts.x ?? 0;
    this.y = opts.y ?? 0;
    this.vx = opts.vx ?? 0;
    this.vy = opts.vy ?? 0;
    this.r = opts.r ?? 0.4;

    this.density = opts.density ?? 1;
    this.restitution = opts.restitution ?? 0.45;
    this.friction = opts.friction ?? 0.25;
    this.drag = opts.drag ?? 0.06;          // air resistance, per second

    this.label = opts.label ?? '';
    this.tint = opts.tint ?? '#F4F4F5';
    this.kind = opts.kind ?? 'ball';

    this.angle = 0;
    this.spin = 0;
    this.held = false;
    this.sleeping = false;
    this.flash = 0;                          // 0..1, decays; drives the render glow

    this.setMassFromArea();
  }

  setMassFromArea() {
    this.mass = Math.PI * this.r * this.r * this.density;
    this.invMass = this.mass > 0 ? 1 / this.mass : 0;
  }

  get speed() { return Math.hypot(this.vx, this.vy); }

  applyImpulse(ix, iy) {
    if (this.held) return;
    this.vx += ix * this.invMass;
    this.vy += iy * this.invMass;
    this.sleeping = false;
  }
}

export class World {
  /**
   * @param {object} opts
   * @param {number} opts.width   world width in units
   * @param {number} opts.height  world height in units
   * @param {number} opts.gravity downward acceleration (units/s²)
   */
  constructor(opts = {}) {
    this.width = opts.width ?? 10;
    this.height = opts.height ?? 6;
    this.gravity = opts.gravity ?? 18;
    this.wallRestitution = opts.wallRestitution ?? 0.52;
    this.wallFriction = opts.wallFriction ?? 0.16;

    this.bodies = [];
    this.onCollision = null;      // (impulse, x, y, bodyA, bodyB) => void

    this.fixedStep = 1 / 120;
    this.maxSteps = 5;
    this.accumulator = 0;

    // A contact only counts as an "impact" above this closing speed (units/s).
    // Without it, a body resting on the floor reports a micro-collision on
    // every substep — the counter runs away and the audio turns to static.
    this.impactSpeed = 0.7;

    // A body slower than this for long enough stops integrating.
    this.sleepSpeed = 0.045;
    this.sleepFrames = new WeakMap();
  }

  add(body) { this.bodies.push(body); return body; }
  remove(body) {
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
  }
  clear() { this.bodies.length = 0; }

  wake() {
    for (const b of this.bodies) { b.sleeping = false; this.sleepFrames.set(b, 0); }
  }

  /** Topmost body whose disc contains the point, or null. */
  pick(x, y, slop = 0) {
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      if (Math.hypot(b.x - x, b.y - y) <= b.r + slop) return b;
    }
    return null;
  }

  /** Radial impulse falling off with distance — the shockwave / boost. */
  blast(x, y, power = 9, radius = 4) {
    for (const b of this.bodies) {
      const dx = b.x - x;
      const dy = b.y - y;
      const dist = Math.hypot(dx, dy) || 0.0001;
      if (dist > radius) continue;
      const falloff = 1 - dist / radius;
      const mag = power * falloff * falloff * b.mass;
      b.sleeping = false;
      b.applyImpulse((dx / dist) * mag, (dy / dist) * mag);
      b.spin += (Math.random() - 0.5) * 6 * falloff;
      b.flash = Math.max(b.flash, falloff);
    }
  }

  /** Advance the simulation by `dt` seconds using fixed substeps. */
  update(dt) {
    this.accumulator += Math.min(dt, 0.1);
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < this.maxSteps) {
      this.step(this.fixedStep);
      this.accumulator -= this.fixedStep;
      steps++;
    }
    if (steps === this.maxSteps) this.accumulator = 0;   // shed backlog after a stall
    for (const b of this.bodies) b.flash *= Math.pow(0.0025, dt);
  }

  step(h) {
    this.integrate(h);
    this.solveContacts();
    this.solveBounds();
    this.updateSleep(h);
  }

  integrate(h) {
    for (const b of this.bodies) {
      if (b.held || b.sleeping) continue;
      b.vy += this.gravity * h;
      const damp = Math.max(0, 1 - b.drag * h);
      b.vx *= damp;
      b.vy *= damp;
      b.x += b.vx * h;
      b.y += b.vy * h;
      b.angle += b.spin * h;
      b.spin *= Math.max(0, 1 - 0.9 * h);
    }
  }

  solveContacts() {
    const list = this.bodies;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (a.sleeping && b.sleeping) continue;

        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const min = a.r + b.r;
        let distSq = dx * dx + dy * dy;
        if (distSq >= min * min) continue;

        let dist = Math.sqrt(distSq);
        if (dist === 0) {                        // perfectly concentric — nudge apart
          dx = 0; dy = -1; dist = 0.0001;
        } else {
          dx /= dist; dy /= dist;
        }

        const invSum = a.invMass + b.invMass;
        if (invSum === 0) continue;              // both held: nothing to resolve

        // — positional correction (Baumgarte, with slop to avoid jitter)
        const penetration = min - dist;
        const correction = Math.max(penetration - 0.002, 0) / invSum * 0.8;
        a.x -= dx * correction * a.invMass;
        a.y -= dy * correction * a.invMass;
        b.x += dx * correction * b.invMass;
        b.y += dy * correction * b.invMass;

        // — normal impulse
        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const along = rvx * dx + rvy * dy;
        if (along > 0) continue;                 // already separating

        const e = Math.min(a.restitution, b.restitution);
        const jn = -(1 + e) * along / invSum;
        const nx = dx * jn;
        const ny = dy * jn;
        a.vx -= nx * a.invMass; a.vy -= ny * a.invMass;
        b.vx += nx * b.invMass; b.vy += ny * b.invMass;

        // — tangential (friction) impulse, clamped by Coulomb's cone
        let tx = rvx - dx * along;
        let ty = rvy - dy * along;
        const tLen = Math.hypot(tx, ty);
        if (tLen > 1e-6) {
          tx /= tLen; ty /= tLen;
          const mu = Math.sqrt(a.friction * b.friction);
          let jt = -(rvx * tx + rvy * ty) / invSum;
          jt = Math.max(-jn * mu, Math.min(jn * mu, jt));
          a.vx -= tx * jt * a.invMass; a.vy -= ty * jt * a.invMass;
          b.vx += tx * jt * b.invMass; b.vy += ty * jt * b.invMass;
          // spin from the tangential rub, so the labels roll believably
          const wheel = jt * 2.2;
          a.spin -= wheel * a.invMass;
          b.spin += wheel * b.invMass;
        }

        a.sleeping = b.sleeping = false;
        this.report(-along, jn, a.x + dx * a.r, a.y + dy * a.r, a, b);
      }
    }
  }

  solveBounds() {
    const { width: w, height: hgt } = this;
    for (const b of this.bodies) {
      if (b.held) continue;

      if (b.x - b.r < 0) {
        b.x = b.r;
        if (b.vx < 0) { this.report(-b.vx, -b.vx * b.mass, 0, b.y, b, null); b.vx *= -this.wallRestitution; b.vy *= (1 - this.wallFriction); }
      } else if (b.x + b.r > w) {
        b.x = w - b.r;
        if (b.vx > 0) { this.report(b.vx, b.vx * b.mass, w, b.y, b, null); b.vx *= -this.wallRestitution; b.vy *= (1 - this.wallFriction); }
      }

      if (b.y - b.r < 0) {
        b.y = b.r;
        if (b.vy < 0) { this.report(-b.vy, -b.vy * b.mass, b.x, 0, b, null); b.vy *= -this.wallRestitution; b.vx *= (1 - this.wallFriction); }
      } else if (b.y + b.r > hgt) {
        b.y = hgt - b.r;
        if (b.vy > 0) {
          this.report(b.vy, b.vy * b.mass, b.x, hgt, b, null);
          b.vy *= -(b.restitution * this.wallRestitution * 1.6);
          b.vx *= (1 - this.wallFriction);
          b.spin += b.vx * 0.6;
        }
      }
    }
  }

  /**
   * Funnel every contact through one gate.
   * @param {number} closing  approach speed along the normal (units/s)
   * @param {number} impulse  magnitude of the resolving impulse (mass·units/s)
   */
  report(closing, impulse, x, y, a, b) {
    if (closing < this.impactSpeed) return;
    const strength = Math.abs(impulse);
    const glow = Math.min(1, strength / 3.2);
    a.flash = Math.max(a.flash, glow);
    if (b) b.flash = Math.max(b.flash, glow);
    if (this.onCollision) this.onCollision(strength, x, y, a, b);
  }

  updateSleep(h) {
    for (const b of this.bodies) {
      if (b.held) { this.sleepFrames.set(b, 0); continue; }
      const resting = b.speed < this.sleepSpeed && b.y + b.r > this.height - 0.02;
      const count = (this.sleepFrames.get(b) ?? 0) + (resting ? h : -h * 4);
      const clamped = Math.max(0, Math.min(0.5, count));
      this.sleepFrames.set(b, clamped);
      if (clamped >= 0.4) {
        b.sleeping = true;
        b.vx = 0; b.vy = 0; b.spin *= 0.5;
      } else if (!resting) {
        b.sleeping = false;
      }
    }
  }
}
