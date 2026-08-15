/**
 * sparring.js — section 04, "The Exchange".
 *
 * A sparring round rendered entirely from points: the same dotted language as
 * the scroll backdrop, but animated. Two particle-bound rigs trade punches
 * inside a dotted ring.
 *
 * How a figure is drawn
 * ---------------------
 * Each fighter is a skeleton of ~16 joints. Every particle is bound to one
 * bone with three numbers baked at build time: `t` along the bone, and `(u,v)`
 * inside the unit disc. Each frame we pose the skeleton, rebuild a
 * perpendicular frame per bone, and place the particle at
 *
 *     A + (B - A) * t + (n1 * u + n2 * v * squash) * radius(t)
 *
 * so 1,540 points per fighter cost ~16 bone solves and a linear write. Elbows
 * and knees come from a two-bone IK solve against a pole vector, which is what
 * makes the arms bend like arms instead of bending backwards.
 *
 * The two styles
 * --------------
 * The dark fighter throws straight: the glove travels a near-linear path to the
 * target and snaps back in 0.34s. The light fighter loops: the glove rides a
 * quadratic Bézier bowed out to the side, over 0.52s, so it is late coming home
 * and gets blocked or slipped. That difference is the whole point of the scene.
 *
 * A note on colour: on a near-black ground with additive blending, a genuinely
 * black particle emits nothing and is invisible. The dark fighter is therefore
 * drawn in the deepest graphite that still reads as a body, with ember gloves.
 */

const RING_COUNT = 4200;
const SPARK_POOL = 320;
const ROUND_LENGTH = 11.0;          // seconds before the script loops

/* ------------------------------------------------------------- rig  ------ */

/** Rest pose in fighter-local space: +x forward (at the opponent), +y up, +z lead side. */
const REST = {
  footLead:     [ 0.26, 0.00,  0.15],
  footRear:     [-0.26, 0.00, -0.13],
  hipLead:      [ 0.02, 0.86,  0.11],
  hipRear:      [-0.02, 0.86, -0.11],
  pelvis:       [ 0.00, 0.90,  0.00],
  chest:        [ 0.02, 1.26,  0.00],
  neck:         [ 0.01, 1.40,  0.00],
  headTop:      [ 0.02, 1.68,  0.00],
  shoulderLead: [ 0.07, 1.31,  0.17],
  shoulderRear: [-0.06, 1.31, -0.17],
  handLead:     [ 0.26, 1.36,  0.13],
  handRear:     [ 0.17, 1.40, -0.09],
};

const ARM_UPPER = 0.30;
const ARM_FORE  = 0.28;
const LEG_UPPER = 0.47;
const LEG_LOWER = 0.47;
const GLOVE_LEN = 0.09;

/** [boneA, boneB, radiusA, radiusB, count, squash, bulge, tone] */
const BONES = [
  // The torso is deliberately slimmer and less dense than anatomy suggests:
  // a fat torso swallows the limbs, and the limbs are what tell the story.
  ['pelvis',       'chest',     0.145, 0.175, 250, 0.58, 0.00, 'body'],
  ['chest',        'neck',      0.08,  0.065,  40, 0.85, 0.00, 'body'],
  ['neck',         'headTop',   0.10,  0.075, 220, 0.90, 0.035, 'head'],
  ['shoulderLead', 'shoulderRear', 0.07, 0.07, 70, 0.80, 0.00, 'body'],
  ['hipLead',      'hipRear',   0.08,  0.08,   40, 0.80, 0.00, 'body'],
  ['shoulderLead', 'elbowLead', 0.062, 0.05,  100, 0.90, 0.00, 'body'],
  ['elbowLead',    'handLead',  0.05,  0.055, 100, 0.90, 0.00, 'body'],
  ['handLead',     'gloveLead', 0.095, 0.082,  95, 0.95, 0.012, 'glove'],
  ['shoulderRear', 'elbowRear', 0.064, 0.052, 100, 0.90, 0.00, 'body'],
  ['elbowRear',    'handRear',  0.052, 0.057, 100, 0.90, 0.00, 'body'],
  ['handRear',     'gloveRear', 0.098, 0.085,  95, 0.95, 0.012, 'glove'],
  ['hipLead',      'kneeLead',  0.09,  0.068, 100, 0.90, 0.00, 'body'],
  ['kneeLead',     'footLead',  0.068, 0.05,   95, 0.90, 0.00, 'body'],
  ['hipRear',      'kneeRear',  0.09,  0.068, 100, 0.90, 0.00, 'body'],
  ['kneeRear',     'footRear',  0.068, 0.05,   95, 0.90, 0.00, 'body'],
];

/**
 * The round, as a script. `by` names the fighter, `response` is what the other
 * one does about it. The dark corner (A) throws more and lands clean twice;
 * the light corner (B) is answered every time.
 */
const SCRIPT = [
  { t: 0.80, by: 'a', arm: 'lead', kind: 'jab',   response: 'block' },
  { t: 1.25, by: 'a', arm: 'rear', kind: 'cross', response: 'slip'  },
  { t: 2.20, by: 'b', arm: 'lead', kind: 'hook',  response: 'slip'  },
  { t: 3.00, by: 'b', arm: 'rear', kind: 'cross', response: 'block' },
  { t: 3.95, by: 'a', arm: 'lead', kind: 'jab',   response: 'block' },
  { t: 4.32, by: 'a', arm: 'lead', kind: 'jab',   response: 'block' },
  { t: 4.75, by: 'a', arm: 'rear', kind: 'cross', response: 'land'  },
  { t: 5.85, by: 'b', arm: 'lead', kind: 'jab',   response: 'block' },
  { t: 6.45, by: 'b', arm: 'rear', kind: 'hook',  response: 'slip'  },
  { t: 7.45, by: 'a', arm: 'lead', kind: 'hook',  response: 'block' },
  { t: 7.90, by: 'a', arm: 'rear', kind: 'cross', response: 'land'  },
  { t: 8.95, by: 'b', arm: 'lead', kind: 'jab',   response: 'slip'  },
  { t: 9.60, by: 'b', arm: 'rear', kind: 'cross', response: 'block' },
];

/* -------------------------------------------------------- small maths ---- */

const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function sub(a, b, out) { out.x = a.x - b.x; out.y = a.y - b.y; out.z = a.z - b.z; return out; }
function len(a) { return Math.hypot(a.x, a.y, a.z); }

/**
 * Two-bone IK. Returns the mid joint (elbow/knee) placed so the chain reaches
 * `target`, bending toward `pole`.
 */
function solveTwoBone(root, target, l1, l2, pole, out) {
  const dx = target.x - root.x;
  const dy = target.y - root.y;
  const dz = target.z - root.z;
  let d = Math.hypot(dx, dy, dz);
  const reach = l1 + l2;
  if (d < 1e-5) d = 1e-5;
  const dc = Math.min(d, reach * 0.999);

  const ax = dx / d, ay = dy / d, az = dz / d;
  const a = (dc * dc + l1 * l1 - l2 * l2) / (2 * dc);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));

  // pole, projected onto the plane perpendicular to the root→target axis
  const dot = pole.x * ax + pole.y * ay + pole.z * az;
  let px = pole.x - ax * dot;
  let py = pole.y - ay * dot;
  let pz = pole.z - az * dot;
  const pl = Math.hypot(px, py, pz);
  if (pl < 1e-5) { px = 0; py = -1; pz = 0; }
  else { px /= pl; py /= pl; pz /= pl; }

  out.x = root.x + ax * a + px * h;
  out.y = root.y + ay * a + py * h;
  out.z = root.z + az * a + pz * h;
  return out;
}

/* ------------------------------------------------------------ builders --- */

function buildRing(THREE, count) {
  const HALF = 2.1;
  const FLOOR = 0;
  const POST_H = 1.52;
  const ROPES = [0.42, 0.80, 1.18];
  const GRID = 40;
  const pos = new Float32Array(count * 3);
  const snap = (t) => (Math.floor(t * GRID) / (GRID - 1)) * 2 - 1;

  for (let i = 0; i < count; i++) {
    let x, y, z;
    const roll = Math.random();

    if (roll < 0.44) {                                   // canvas lattice
      x = snap(Math.random()) * HALF;
      z = snap(Math.random()) * HALF;
      y = FLOOR + (Math.random() - 0.5) * 0.012;
    } else if (roll < 0.70) {                            // ropes, with sag
      const side = Math.floor(Math.random() * 4);
      const rope = ROPES[Math.floor(Math.random() * ROPES.length)];
      const t = Math.random();
      const along = (t * 2 - 1) * HALF;
      const sag = -Math.sin(t * Math.PI) * 0.05;
      if (side === 0) { x = along; z = -HALF; }
      else if (side === 1) { x = along; z = HALF; }
      else if (side === 2) { x = -HALF; z = along; }
      else { x = HALF; z = along; }
      y = FLOOR + rope + sag;
      x += (Math.random() - 0.5) * 0.012;
      z += (Math.random() - 0.5) * 0.012;
    } else if (roll < 0.84) {                            // corner posts
      const cx = Math.random() < 0.5 ? -HALF : HALF;
      const cz = Math.random() < 0.5 ? -HALF : HALF;
      const a = Math.random() * Math.PI * 2;
      const rad = 0.045 + Math.random() * 0.02;
      x = cx + Math.cos(a) * rad;
      z = cz + Math.sin(a) * rad;
      y = FLOOR + Math.random() * POST_H;
    } else {                                             // apron skirt
      const t = Math.random() * 4;
      const side = Math.floor(t);
      const along = ((t - side) * 2 - 1) * HALF;
      const edge = HALF + 0.14;
      if (side === 0) { x = along; z = -edge; }
      else if (side === 1) { x = along; z = edge; }
      else if (side === 2) { x = -edge; z = along; }
      else { x = edge; z = along; }
      y = FLOOR - Math.random() * 0.3;
    }

    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return geo;
}

/** Bakes the particle→bone bindings for one fighter. */
function bindFighter(tones) {
  const bindings = [];
  let total = 0;
  for (const bone of BONES) total += bone[4];

  const positions = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  let cursor = 0;

  for (let b = 0; b < BONES.length; b++) {
    const [, , rA, rB, count, squash, bulge, tone] = BONES[b];
    const colour = tones[tone];
    for (let i = 0; i < count; i++) {
      // uniform-ish point in the unit disc, biased outward so limbs read hollow
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random()) * 0.55 + 0.45;
      bindings.push({
        bone: b,
        t: Math.random(),
        u: Math.cos(ang) * rad,
        v: Math.sin(ang) * rad,
        rA, rB, squash, bulge,
      });
      colors[cursor * 3] = colour[0];
      colors[cursor * 3 + 1] = colour[1];
      colors[cursor * 3 + 2] = colour[2];
      cursor++;
    }
  }
  return { bindings, positions, colors, total };
}

/* ------------------------------------------------------------- shaders --- */

const VERT = /* glsl */`
  uniform float uSize;
  uniform float uPixelRatio;
  attribute vec3 aColor;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = uSize * (22.0 / max(-mv.z, 0.001));
    gl_PointSize = clamp(size, 0.6, 5.0) * uPixelRatio;
    vColor = aColor;
    vAlpha = aAlpha;
  }
`;

const FRAG = /* glsl */`
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = dot(c, c);
    if (d > 0.25) discard;
    float alpha = smoothstep(0.25, 0.0, d);
    float core = smoothstep(0.05, 0.0, d);
    gl_FragColor = vec4(vColor + core * 0.28, alpha * vAlpha);
  }
`;

/* ---------------------------------------------------------------- init --- */

export async function initSparring({ canvas, audio, reduceMotion = false }) {
  if (!canvas) return null;

  let THREE;
  try {
    THREE = await import('three');
  } catch (err) {
    console.warn('[ww] three.js unavailable, sparring scene skipped.', err);
    return null;
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.warn('[ww] WebGL unavailable, sparring scene skipped.', err);
    return null;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);

  const makeMaterial = (size) => new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: size },
      uPixelRatio: { value: renderer.getPixelRatio() },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  /* --- ring ------------------------------------------------------------- */

  const ringGeo = buildRing(THREE, RING_COUNT);
  {
    const c = new Float32Array(RING_COUNT * 3);
    const a = new Float32Array(RING_COUNT);
    for (let i = 0; i < RING_COUNT; i++) {
      c[i * 3] = 0.72; c[i * 3 + 1] = 0.72; c[i * 3 + 2] = 0.74;
      a[i] = 0.30 + Math.random() * 0.22;
    }
    ringGeo.setAttribute('aColor', new THREE.BufferAttribute(c, 3));
    ringGeo.setAttribute('aAlpha', new THREE.BufferAttribute(a, 1));
  }
  const ringPoints = new THREE.Points(ringGeo, makeMaterial(0.5));
  ringPoints.frustumCulled = false;
  scene.add(ringPoints);

  /* --- fighters --------------------------------------------------------- */

  // Deepest graphite that still emits against #0A0A0A, plus ember gloves.
  const TONE_A = {
    body:  [0.30, 0.34, 0.40],
    head:  [0.38, 0.42, 0.48],
    glove: [1.00, 0.33, 0.00],
  };
  // Warm cream with bronze gloves, bright enough to read against the body.
  const TONE_B = {
    body:  [0.80, 0.68, 0.53],
    head:  [0.90, 0.78, 0.62],
    glove: [0.86, 0.50, 0.18],
  };

  const rigA = bindFighter(TONE_A);
  const rigB = bindFighter(TONE_B);

  const fighters = [
    { id: 'a', x: -0.42, dir: 1, rig: rigA, style: 'straight', dur: 0.34, thrown: 0, landed: 0 },
    { id: 'b', x: 0.42, dir: -1, rig: rigB, style: 'looping', dur: 0.52, thrown: 0, landed: 0 },
  ];

  const bodyTotal = rigA.total + rigB.total;
  const bodyPos = new Float32Array(bodyTotal * 3);
  const bodyCol = new Float32Array(bodyTotal * 3);
  const bodyAlpha = new Float32Array(bodyTotal);
  bodyCol.set(rigA.colors, 0);
  bodyCol.set(rigB.colors, rigA.total * 3);
  for (let i = 0; i < bodyTotal; i++) bodyAlpha[i] = 0.62 + Math.random() * 0.3;

  const bodyGeo = new THREE.BufferGeometry();
  const bodyPosAttr = new THREE.BufferAttribute(bodyPos, 3);
  bodyPosAttr.setUsage(THREE.DynamicDrawUsage);
  bodyGeo.setAttribute('position', bodyPosAttr);
  bodyGeo.setAttribute('aColor', new THREE.BufferAttribute(bodyCol, 3));
  bodyGeo.setAttribute('aAlpha', new THREE.BufferAttribute(bodyAlpha, 1));
  const bodyPoints = new THREE.Points(bodyGeo, makeMaterial(0.62));
  bodyPoints.frustumCulled = false;
  scene.add(bodyPoints);

  /* --- sparks ----------------------------------------------------------- */

  const sparkPos = new Float32Array(SPARK_POOL * 3);
  const sparkCol = new Float32Array(SPARK_POOL * 3);
  const sparkAlpha = new Float32Array(SPARK_POOL);
  const sparks = [];
  for (let i = 0; i < SPARK_POOL; i++) {
    sparks.push({ x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1 });
    sparkPos[i * 3 + 1] = -99;
  }
  const sparkGeo = new THREE.BufferGeometry();
  const sparkPosAttr = new THREE.BufferAttribute(sparkPos, 3);
  sparkPosAttr.setUsage(THREE.DynamicDrawUsage);
  const sparkAlphaAttr = new THREE.BufferAttribute(sparkAlpha, 1);
  sparkAlphaAttr.setUsage(THREE.DynamicDrawUsage);
  sparkGeo.setAttribute('position', sparkPosAttr);
  sparkGeo.setAttribute('aColor', new THREE.BufferAttribute(sparkCol, 3));
  sparkGeo.setAttribute('aAlpha', sparkAlphaAttr);
  const sparkPoints = new THREE.Points(sparkGeo, makeMaterial(0.95));
  sparkPoints.frustumCulled = false;
  scene.add(sparkPoints);

  let sparkCursor = 0;

  /**
   * A few embers shed from a glove in flight. Without these a punch is a small
   * cluster moving 40cm in a third of a second, which the eye simply misses.
   */
  function trail(x, y, z, warm, strength) {
    const n = strength > 0.6 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const idx = sparkCursor;
      const s = sparks[idx];
      sparkCursor = (sparkCursor + 1) % SPARK_POOL;
      s.x = x + (Math.random() - 0.5) * 0.05;
      s.y = y + (Math.random() - 0.5) * 0.05;
      s.z = z + (Math.random() - 0.5) * 0.05;
      s.vx = 0; s.vy = 0.05; s.vz = 0;
      s.max = 0.16 + Math.random() * 0.12;
      s.life = s.max;
      s.drag = true;
      sparkCol[idx * 3] = warm ? 0.95 : 1.0;
      sparkCol[idx * 3 + 1] = warm ? 0.62 : 0.35;
      sparkCol[idx * 3 + 2] = warm ? 0.32 : 0.05;
    }
    sparkGeo.attributes.aColor.needsUpdate = true;
  }

  function burst(x, y, z, power, warm) {
    const n = Math.round(14 + power * 22);
    for (let i = 0; i < n; i++) {
      const s = sparks[sparkCursor];
      const idx = sparkCursor;
      sparkCursor = (sparkCursor + 1) % SPARK_POOL;
      const a = Math.random() * Math.PI * 2;
      const b = Math.acos(Math.random() * 2 - 1);
      const speed = (0.5 + Math.random() * 1.6) * (0.5 + power);
      s.x = x; s.y = y; s.z = z;
      s.vx = Math.sin(b) * Math.cos(a) * speed;
      s.vy = Math.cos(b) * speed * 0.8 + 0.4;
      s.vz = Math.sin(b) * Math.sin(a) * speed;
      s.max = 0.32 + Math.random() * 0.35;
      s.life = s.max;
      s.drag = false;
      sparkCol[idx * 3] = 1.0;
      sparkCol[idx * 3 + 1] = warm ? 0.42 : 0.33;
      sparkCol[idx * 3 + 2] = warm ? 0.12 : 0.0;
    }
    sparkGeo.attributes.aColor.needsUpdate = true;
  }

  /* --- pose scratch ----------------------------------------------------- */

  const JOINT_NAMES = [
    'footLead', 'footRear', 'hipLead', 'hipRear', 'pelvis', 'chest', 'neck',
    'headTop', 'shoulderLead', 'shoulderRear', 'handLead', 'handRear',
    'elbowLead', 'elbowRear', 'kneeLead', 'kneeRear', 'gloveLead', 'gloveRear',
  ];
  for (const f of fighters) {
    f.joints = {};
    for (const name of JOINT_NAMES) f.joints[name] = v3();
    f.punch = null;
    f.react = { kind: null, until: 0, from: 0, side: 1 };
    f.snap = 0;                 // head snap-back after taking one
  }

  const tmpA = v3(), tmpPole = v3();

  /** Rest-pose joint in world space, ignoring bob, lunge and lean. */
  function basePoint(f, name, out) {
    const p = REST[name];
    out.x = f.x + f.dir * p[0];
    out.y = p[1];
    out.z = f.dir * p[2];
    return out;
  }

  /* --- the round -------------------------------------------------------- */

  const state = { time: 0, cycle: 0, running: false, visible: false };
  const extra = [];             // user-called punches, absolute round time

  function punchWindow(f, ev) {
    return f.dur * (ev.kind === 'hook' ? 1.25 : 1);
  }

  function resolvePunches() {
    for (const f of fighters) f.punch = null;
    for (const ev of SCRIPT) applyEvent(ev);
    for (const ev of extra) applyEvent(ev);
  }

  function applyEvent(ev) {
    {
      const thrower = fighters.find((f) => f.id === ev.by);
      const defender = fighters.find((f) => f.id !== ev.by);
      const dur = punchWindow(thrower, ev);
      const start = ev.t;
      const u = (state.time - start) / dur;
      if (u < 0 || u > 1) return;

      // fire-once bookkeeping
      if (ev.cycle !== state.cycle) {
        ev.cycle = state.cycle;
        ev.hit = false;
        thrower.thrown++;
        defender.react.kind = ev.response;
        defender.react.until = start + dur;
        defender.react.from = start;
        defender.react.side = ev.arm === 'lead' ? 1 : -1;
        // snapshot the target: you punch where they were, not where they go
        ev.target = v3();
        if (ev.response === 'block') {
          const glove = ev.arm === 'lead' ? 'handLead' : 'handRear';
          basePoint(defender, glove, ev.target);
          ev.target.x += defender.dir * 0.06;
        } else {
          basePoint(defender, 'neck', ev.target);
          ev.target.y += 0.14;
          ev.target.x += defender.dir * 0.10;   // just in front of the face
          ev.target.z += defender.dir * (ev.arm === 'lead' ? 0.04 : -0.04);
        }
      }

      // extension curve
      const style = thrower.style;
      const outPhase = style === 'straight' ? 0.38 : 0.46;
      let e;
      if (u < outPhase) {
        const k = u / outPhase;
        e = style === 'straight' ? easeOutQuint(k) : easeOutQuad(k);
      } else if (u < outPhase + 0.12) {
        e = 1;
      } else {
        e = 1 - easeInOutCubic((u - outPhase - 0.12) / (1 - outPhase - 0.12));
      }

      thrower.punch = { ev, e, u };

      if (!ev.hit && e > 0.88) {
        ev.hit = true;
        const clean = ev.response === 'land';
        if (clean) { thrower.landed++; defender.snap = 1; }
        if (ev.response !== 'slip') {
          const t = ev.target;
          burst(t.x, t.y, t.z, clean ? 1 : 0.5, thrower.id === 'b');
          if (audio) {
            const pan = clamp(t.x / 1.6, -1, 1);
            audio.impact(clean ? 0.95 : 0.5, pan * 0.8, clean ? 0.62 : 0.4);
          }
        }
      }
    }
  }

  /** Hand position for a punch in flight. */
  function punchHand(f, guard, target, e, kind, out) {
    if (kind === 'hook') {
      // quadratic Bézier bowed out to the lead side
      const mx = (guard.x + target.x) / 2;
      const my = (guard.y + target.y) / 2 + 0.04;
      const mz = (guard.z + target.z) / 2 + f.dir * 0.34;
      const inv = 1 - e;
      out.x = inv * inv * guard.x + 2 * inv * e * mx + e * e * target.x;
      out.y = inv * inv * guard.y + 2 * inv * e * my + e * e * target.y;
      out.z = inv * inv * guard.z + 2 * inv * e * mz + e * e * target.z;
    } else {
      out.x = lerp(guard.x, target.x, e);
      out.y = lerp(guard.y, target.y, e) + Math.sin(e * Math.PI) * 0.018;
      out.z = lerp(guard.z, target.z, e);
    }
    return out;
  }

  function poseFighter(f, time) {
    const J = f.joints;
    const punch = f.punch;
    const e = punch ? punch.e : 0;
    const kind = punch ? punch.ev.kind : null;
    const arm = punch ? punch.ev.arm : null;

    // torso twist and forward lunge come from the punch
    const twist = punch ? e * (arm === 'rear' ? 0.34 : 0.16) * (kind === 'hook' ? 1.3 : 1) : 0;
    const lunge = punch ? e * 0.10 : 0;

    const bob = reduceMotion ? 0 : Math.sin(time * 2.3) * 0.011;
    const weave = reduceMotion ? 0 : Math.sin(time * 0.95) * 0.016;

    // defensive reaction
    let leanX = 0, leanZ = 0, leanY = 0;
    const r = f.react;
    if (r.kind === 'slip' && time < r.until + 0.18) {
      const k = clamp((time - r.from) / Math.max(0.001, r.until + 0.18 - r.from), 0, 1);
      const amount = Math.sin(k * Math.PI);
      leanZ = amount * 0.17 * r.side;
      leanY = -amount * 0.07;
      leanX = -amount * 0.05;
    }
    if (f.snap > 0) {
      leanX -= f.snap * 0.09;
      leanY += f.snap * 0.03;
    }

    // feet stay planted; everything above the pelvis moves
    const place = (name, upper) => {
      const p = REST[name];
      let lx = p[0], ly = p[1], lz = p[2];
      if (upper) {
        lx += lunge;
        ly += bob;
        lz += weave;
        if (twist !== 0) {
          const c = Math.cos(twist), s = Math.sin(twist);
          const rx = lx * c - lz * s;
          const rz = lx * s + lz * c;
          lx = rx; lz = rz;
        }
      }
      const j = J[name];
      j.x = f.x + f.dir * lx + leanX * f.dir * (upper ? 1 : 0);
      j.y = ly + (upper ? leanY : 0);
      j.z = f.dir * lz + (upper ? leanZ * f.dir : 0);
      return j;
    };

    place('footLead', false);
    place('footRear', false);
    place('hipLead', true);
    place('hipRear', true);
    place('pelvis', true);
    place('chest', true);
    place('neck', true);
    place('headTop', true);
    place('shoulderLead', true);
    place('shoulderRear', true);

    // hands: guard, punch, or block
    for (const side of ['Lead', 'Rear']) {
      const handName = `hand${side}`;
      const guard = place(handName, true);
      const isPunching = punch && ((arm === 'lead') === (side === 'Lead'));

      if (isPunching) {
        punchHand(f, { x: guard.x, y: guard.y, z: guard.z }, punch.ev.target, e, kind, guard);
      } else if (r.kind === 'block' && time < r.until) {
        // meet the incoming shot: near glove comes up and forward a little
        const near = (r.side === 1) === (side === 'Lead');
        if (near) {
          const k = Math.sin(clamp((time - r.from) / Math.max(0.001, r.until - r.from), 0, 1) * Math.PI);
          guard.x += f.dir * k * 0.07;
          guard.y += k * 0.035;
        }
      }
    }

    // elbows
    for (const side of ['Lead', 'Rear']) {
      const shoulder = J[`shoulder${side}`];
      const hand = J[`hand${side}`];
      const sign = side === 'Lead' ? 1 : -1;
      tmpPole.x = f.dir * -0.25;
      tmpPole.y = -1;
      tmpPole.z = f.dir * 0.32 * sign;
      solveTwoBone(shoulder, hand, ARM_UPPER, ARM_FORE, tmpPole, J[`elbow${side}`]);

      // glove sits just beyond the wrist, along the forearm
      const elbow = J[`elbow${side}`];
      sub(hand, elbow, tmpA);
      const l = len(tmpA) || 1;
      const g = J[`glove${side}`];
      g.x = hand.x + (tmpA.x / l) * GLOVE_LEN;
      g.y = hand.y + (tmpA.y / l) * GLOVE_LEN;
      g.z = hand.z + (tmpA.z / l) * GLOVE_LEN;
    }

    // knees
    for (const side of ['Lead', 'Rear']) {
      const hip = J[`hip${side}`];
      const foot = J[`foot${side}`];
      const sign = side === 'Lead' ? 1 : -1;
      tmpPole.x = f.dir * 0.9;
      tmpPole.y = 0.1;
      tmpPole.z = f.dir * 0.28 * sign;
      solveTwoBone(hip, foot, LEG_UPPER, LEG_LOWER, tmpPole, J[`knee${side}`]);
    }
  }

  /* --- particle write --------------------------------------------------- */

  const REF_UP = v3(0, 1, 0);
  const REF_X = v3(1, 0, 0);

  function writeFighter(f, rig, offset) {
    const J = f.joints;
    // per-bone frames
    const frames = [];
    for (let b = 0; b < BONES.length; b++) {
      const A = J[BONES[b][0]];
      const B = J[BONES[b][1]];
      const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
      const l = Math.hypot(dx, dy, dz) || 1e-5;
      const ux = dx / l, uy = dy / l, uz = dz / l;
      // a stable-ish reference that is never parallel to the bone
      const ref = Math.abs(uy) > 0.9 ? REF_X : REF_UP;
      let n1x = uy * ref.z - uz * ref.y;
      let n1y = uz * ref.x - ux * ref.z;
      let n1z = ux * ref.y - uy * ref.x;
      const n1l = Math.hypot(n1x, n1y, n1z) || 1e-5;
      n1x /= n1l; n1y /= n1l; n1z /= n1l;
      const n2x = uy * n1z - uz * n1y;
      const n2y = uz * n1x - ux * n1z;
      const n2z = ux * n1y - uy * n1x;
      frames.push({ ax: A.x, ay: A.y, az: A.z, dx, dy, dz, n1x, n1y, n1z, n2x, n2y, n2z });
    }

    const list = rig.bindings;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const fr = frames[p.bone];
      const t = p.t;
      let r = lerp(p.rA, p.rB, t);
      if (p.bulge) r += Math.sin(t * Math.PI) * p.bulge;
      const ox = fr.n1x * p.u + fr.n2x * p.v * p.squash;
      const oy = fr.n1y * p.u + fr.n2y * p.v * p.squash;
      const oz = fr.n1z * p.u + fr.n2z * p.v * p.squash;
      const j = (offset + i) * 3;
      bodyPos[j] = fr.ax + fr.dx * t + ox * r;
      bodyPos[j + 1] = fr.ay + fr.dy * t + oy * r;
      bodyPos[j + 2] = fr.az + fr.dz * t + oz * r;
    }
  }

  function updateSparks(dt) {
    for (let i = 0; i < SPARK_POOL; i++) {
      const s = sparks[i];
      if (s.life <= 0) { sparkAlpha[i] = 0; continue; }
      s.life -= dt;
      if (!s.drag) s.vy -= 4.2 * dt;      // trail embers hang, impact debris falls
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      sparkPos[i * 3] = s.x;
      sparkPos[i * 3 + 1] = s.y;
      sparkPos[i * 3 + 2] = s.z;
      sparkAlpha[i] = clamp(s.life / s.max, 0, 1) * 0.9;
    }
    sparkGeo.attributes.position.needsUpdate = true;
    sparkGeo.attributes.aAlpha.needsUpdate = true;
  }

  /* --- readouts --------------------------------------------------------- */

  const ui = {
    clock: document.getElementById('spar-clock'),
    aThrown: document.getElementById('rd-a-thrown'),
    aLanded: document.getElementById('rd-a-landed'),
    bThrown: document.getElementById('rd-b-thrown'),
    bLanded: document.getElementById('rd-b-landed'),
    hint: document.getElementById('spar-hint'),
  };
  const pad = (n) => String(n).padStart(2, '0');
  let uiClock = 0;
  function tickUI(dt) {
    uiClock += dt;
    if (uiClock < 0.12) return;
    uiClock = 0;
    const secs = Math.floor(state.time);
    if (ui.clock) ui.clock.textContent = `R1 ${Math.floor(secs / 60)}:${pad(secs % 60)}`;
    if (ui.aThrown) ui.aThrown.textContent = pad(fighters[0].thrown);
    if (ui.aLanded) ui.aLanded.textContent = pad(fighters[0].landed);
    if (ui.bThrown) ui.bThrown.textContent = pad(fighters[1].thrown);
    if (ui.bLanded) ui.bLanded.textContent = pad(fighters[1].landed);
  }

  /* --- interaction ------------------------------------------------------ */

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  let interacted = false;

  function callCombination() {
    if (!interacted) {
      interacted = true;
      ui.hint?.classList.add('is-hidden');
    }
    audio?.start();
    const base = state.time + 0.12;
    const combo = [
      { t: base, by: 'a', arm: 'lead', kind: 'jab', response: 'block' },
      { t: base + 0.36, by: 'a', arm: 'lead', kind: 'jab', response: 'block' },
      { t: base + 0.78, by: 'a', arm: 'rear', kind: 'cross', response: 'land' },
    ];
    for (const ev of combo) { ev.cycle = -1; extra.push(ev); }
    // clear once they can no longer be in flight
    window.setTimeout(() => { extra.length = 0; }, 2600);
  }

  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    callCombination();
  });
  canvas.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      callCombination();
    }
  });
  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.tx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.ty = ((event.clientY - rect.top) / rect.height) * 2 - 1;
  }, { passive: true });
  canvas.addEventListener('pointerleave', () => { pointer.tx = 0; pointer.ty = 0; });
  document.getElementById('ctl-combo')?.addEventListener('click', callCombination);

  /* --- loop ------------------------------------------------------------- */

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    const ratio = renderer.getPixelRatio();
    for (const p of [ringPoints, bodyPoints, sparkPoints]) p.material.uniforms.uPixelRatio.value = ratio;
  }

  let raf = 0;
  let last = 0;

  function frame(now) {
    if (!state.running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000 || 0.016, 0.05);
    last = now;

    if (!reduceMotion) {
      state.time += dt;
      if (state.time >= ROUND_LENGTH) {
        state.time -= ROUND_LENGTH;
        state.cycle++;
        for (const ev of extra) ev.t -= ROUND_LENGTH;
      }
    }

    resolvePunches(dt);
    for (const f of fighters) {
      poseFighter(f, state.time + (f.id === 'b' ? 1.7 : 0));
      f.snap = Math.max(0, f.snap - dt * 3.2);

      // shed embers off a glove while it is travelling outward
      const p = f.punch;
      if (p && !reduceMotion && p.e > 0.12 && p.e > (f.prevE || 0)) {
        const g = f.joints[p.ev.arm === 'lead' ? 'gloveLead' : 'gloveRear'];
        trail(g.x, g.y, g.z, f.id === 'b', p.e);
      }
      f.prevE = p ? p.e : 0;
    }
    writeFighter(fighters[0], rigA, 0);
    writeFighter(fighters[1], rigB, rigA.total);
    bodyGeo.attributes.position.needsUpdate = true;

    updateSparks(dt);

    // camera: three-quarter view with a slow drift and pointer parallax
    pointer.x = lerp(pointer.x, pointer.tx, 1 - Math.pow(0.005, dt));
    pointer.y = lerp(pointer.y, pointer.ty, 1 - Math.pow(0.005, dt));
    const drift = reduceMotion ? 0 : Math.sin(state.time * 0.16) * 0.22;
    const ang = 0.34 + drift + pointer.x * 0.28;
    // far enough back that a raised glove never clips the top edge
    const dist = 3.05;
    camera.position.set(Math.sin(ang) * dist, 1.34 - pointer.y * 0.3, Math.cos(ang) * dist);
    camera.lookAt(0, 1.0, 0);

    renderer.render(scene, camera);
    tickUI(dt);
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

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const io = new IntersectionObserver((entries) => {
    state.visible = entries.some((e) => e.isIntersecting);
    if (state.visible && !document.hidden) start(); else stop();
  }, { threshold: 0.05 });
  io.observe(canvas);

  const onVisibility = () => {
    if (document.hidden) stop();
    else if (state.visible) start();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', resize);

  function dispose() {
    stop();
    ro.disconnect();
    io.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('resize', resize);
    ringGeo.dispose();
    bodyGeo.dispose();
    sparkGeo.dispose();
    renderer.dispose();
  }

  return { dispose, start, stop, callCombination };
}
