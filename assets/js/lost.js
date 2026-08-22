/**
 * lost.js — the 404 scene.
 *
 * A pair of gloves hung over a rope, drawn in the same dotted language as the
 * scroll backdrop and the sparring round. Hanging up the gloves is what a
 * fighter does when they are done, which is the right note for a page that is
 * not in the building: nothing is broken, this one has just retired.
 *
 * A glove is three primitives and a seam. The cuff is a short tapered cylinder
 * at the top, where the lace ties it to the rope; the mitt is an ellipsoid
 * hanging below it; the thumb is a smaller ellipsoid set off to the side. Every
 * particle is a surface sample pulled slightly inward, so the shape reads as a
 * shell rather than a solid lump, which is what keeps it legible at this
 * density.
 *
 * Each glove then swings as a rigid body about its knot on the rope, at its own
 * period, so the two drift in and out of phase and the pair never looks like a
 * loop. The rope is baked with the sag already in it, dipping a little deeper
 * under each knot, because a rope that hangs straight while something hangs off
 * it is the detail that makes the rest look weightless.
 */

const GLOVE_POINTS = 1350;
const ROPE_POINTS  = 900;
const FLOOR_POINTS = 700;
const MOTE_POINTS  = 220;

/* ------------------------------------------------------------ sampling --- */

/** A point on an ellipsoid surface, pulled inward a little so it reads as a shell. */
function onEllipsoid(rx, ry, rz) {
  // Marsaglia: a uniform direction, then scaled. Uniform on the sphere is not
  // uniform on the ellipsoid, but the bias is toward the flatter faces, which
  // is where a glove wants its density anyway.
  let a, b, s;
  do {
    a = Math.random() * 2 - 1;
    b = Math.random() * 2 - 1;
    s = a * a + b * b;
  } while (s >= 1);
  const f = 2 * Math.sqrt(1 - s);
  const dx = a * f;
  const dy = b * f;
  const dz = 1 - 2 * s;
  const shell = 0.93 + Math.random() * 0.07;
  return [dx * rx * shell, dy * ry * shell, dz * rz * shell];
}

/**
 * One glove, in local space with the knot at the origin and the mitt hanging
 * down the -y axis. `hand` is +1 for a right glove and -1 for a left, which
 * only moves the thumb across so the pair is a pair rather than two of the same.
 */
function buildGlove(hand) {
  const pos = new Float32Array(GLOVE_POINTS * 3);
  const shade = new Float32Array(GLOVE_POINTS);   // 0 body, 1 seam highlight

  const MITT = [0, -0.47, 0];
  const R = [0.205, 0.27, 0.18];

  for (let i = 0; i < GLOVE_POINTS; i++) {
    let x, y, z, lit = 0;
    const roll = Math.random();

    if (roll < 0.10) {
      // Lace: a few strands running from the knot down into the cuff.
      const t = Math.random();
      x = (Math.random() - 0.5) * 0.05;
      y = -t * 0.16;
      z = (Math.random() - 0.5) * 0.05;
      lit = 1;
    } else if (roll < 0.26) {
      // Cuff: a short cylinder, wider at the bottom where it meets the mitt.
      const t = Math.random();
      const ang = Math.random() * Math.PI * 2;
      const r = 0.105 + t * 0.055;
      x = Math.cos(ang) * r;
      y = -0.06 - t * 0.20;
      z = Math.sin(ang) * r * 0.86;
      lit = t > 0.86 ? 1 : 0;                     // the rim band round the wrist
    } else if (roll < 0.80) {
      // The mitt itself.
      const p = onEllipsoid(R[0], R[1], R[2]);
      x = MITT[0] + p[0];
      y = MITT[1] + p[1];
      z = MITT[2] + p[2];
    } else if (roll < 0.92) {
      // Knuckle roll: a band across the striking face, which is the one edge
      // that tells you which way the glove is pointing.
      const t = Math.random() * 2 - 1;
      const bow = Math.cos(t * 1.25) * 0.16;
      x = t * 0.185;
      y = MITT[1] - 0.055 + Math.sin(t * 1.6) * 0.03 + (Math.random() - 0.5) * 0.035;
      z = bow + 0.055 + (Math.random() - 0.5) * 0.03;
      lit = 1;
    } else {
      // Thumb.
      const p = onEllipsoid(0.098, 0.135, 0.088);
      x = hand * 0.185 + p[0];
      y = -0.375 + p[1] * 0.95;
      z = 0.03 + p[2];
    }

    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    shade[i] = lit;
  }
  return { pos, shade };
}

/**
 * The rope, with the sag baked in. `knots` are the x positions carrying a
 * glove; each one pulls an extra dip into the curve underneath it.
 */
function ropeHeight(x, span, knots) {
  const t = (x / span + 1) * 0.5;                 // 0..1 across the span
  let y = -Math.sin(t * Math.PI) * 0.085;         // the rope's own weight
  for (const k of knots) {
    const d = Math.abs(x - k);
    y -= 0.075 * Math.exp(-(d * d) / 0.22);       // and what hangs off it
  }
  return y;
}

/* ---------------------------------------------------------------- init --- */

export async function initLost({ canvas, reduceMotion = false }) {
  if (!canvas) return null;

  let THREE;
  try {
    THREE = await import('three');
  } catch (err) {
    console.warn('[ww] three.js unavailable, 404 scene skipped.', err);
    return null;
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.warn('[ww] WebGL unavailable, 404 scene skipped.', err);
    return null;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);

  const material = (size) => new THREE.ShaderMaterial({
    uniforms: { uSize: { value: size }, uPixelRatio: { value: renderer.getPixelRatio() } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: VERT,
    fragmentShader: FRAG,
  });

  const SPAN = 2.5;
  const KNOTS = [-0.34, 0.36];

  /* ------------------------------------------------------------ the rope -- */

  const ropeGeo = new THREE.BufferGeometry();
  {
    const p = new Float32Array(ROPE_POINTS * 3);
    const c = new Float32Array(ROPE_POINTS * 3);
    const a = new Float32Array(ROPE_POINTS);
    for (let i = 0; i < ROPE_POINTS; i++) {
      const x = (Math.random() * 2 - 1) * SPAN;
      const ang = Math.random() * Math.PI * 2;
      p[i * 3] = x;
      p[i * 3 + 1] = ropeHeight(x, SPAN, KNOTS) + Math.sin(ang) * 0.019;
      p[i * 3 + 2] = Math.cos(ang) * 0.019;
      // Cooling toward the ends, so the rope leaves the frame rather than
      // stopping in it.
      const fade = 1 - Math.pow(Math.abs(x) / SPAN, 2.4);
      c[i * 3] = 0.92; c[i * 3 + 1] = 0.90; c[i * 3 + 2] = 0.86;
      a[i] = 0.30 + fade * 0.55;
    }
    ropeGeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    ropeGeo.setAttribute('aColor', new THREE.BufferAttribute(c, 3));
    ropeGeo.setAttribute('aAlpha', new THREE.BufferAttribute(a, 1));
  }
  scene.add(new THREE.Points(ropeGeo, material(0.42)));

  /* ----------------------------------------------------------- the floor -- */

  // A long way down and very faint: it is there to say the gloves are hanging
  // above something, not to be looked at.
  const floorGeo = new THREE.BufferGeometry();
  {
    const p = new Float32Array(FLOOR_POINTS * 3);
    const c = new Float32Array(FLOOR_POINTS * 3);
    const a = new Float32Array(FLOOR_POINTS);
    const GRID = 26;
    const snap = (t) => (Math.floor(t * GRID) / (GRID - 1)) * 2 - 1;
    for (let i = 0; i < FLOOR_POINTS; i++) {
      const x = snap(Math.random()) * 2.6;
      const z = snap(Math.random()) * 2.2 - 0.4;
      p[i * 3] = x;
      p[i * 3 + 1] = -2.05 + (Math.random() - 0.5) * 0.01;
      p[i * 3 + 2] = z;
      c[i * 3] = 0.62; c[i * 3 + 1] = 0.42; c[i * 3 + 2] = 0.24;
      a[i] = 0.10 + Math.random() * 0.10;
    }
    floorGeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    floorGeo.setAttribute('aColor', new THREE.BufferAttribute(c, 3));
    floorGeo.setAttribute('aAlpha', new THREE.BufferAttribute(a, 1));
  }
  scene.add(new THREE.Points(floorGeo, material(0.36)));

  /* ---------------------------------------------------------- the gloves -- */

  // Ember on the left, bronze on the right: the same two tones the sparring
  // scene gives its two fighters, so the pair reads as one pair of theirs.
  const GLOVES = [
    { hand: -1, knot: KNOTS[0], tone: [1.00, 0.42, 0.12], period: 3.9, phase: 0.0,  tilt: -0.16 },
    { hand:  1, knot: KNOTS[1], tone: [0.86, 0.68, 0.46], period: 4.6, phase: 1.7,  tilt:  0.13 },
  ];

  const gloves = GLOVES.map((g) => {
    const { pos, shade } = buildGlove(g.hand);
    const geo = new THREE.BufferGeometry();
    const c = new Float32Array(GLOVE_POINTS * 3);
    const a = new Float32Array(GLOVE_POINTS);
    for (let i = 0; i < GLOVE_POINTS; i++) {
      const lift = shade[i] ? 0.34 : 0;
      c[i * 3]     = Math.min(g.tone[0] + lift, 1.3);
      c[i * 3 + 1] = Math.min(g.tone[1] + lift, 1.3);
      c[i * 3 + 2] = Math.min(g.tone[2] + lift, 1.3);
      a[i] = (shade[i] ? 0.92 : 0.52) + Math.random() * 0.18;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(c, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(a, 1));

    const points = new THREE.Points(geo, material(0.60));
    // The knot sits on the rope, and the glove rotates about it. Putting the
    // pivot on the object rather than in the vertex data is what makes the
    // swing one matrix instead of 1,350 rewrites a frame.
    points.position.set(g.knot, ropeHeight(g.knot, SPAN, KNOTS), 0);
    scene.add(points);
    return { ...g, points };
  });

  /* ----------------------------------------------------------- the motes -- */

  const moteGeo = new THREE.BufferGeometry();
  const motes = [];
  {
    const p = new Float32Array(MOTE_POINTS * 3);
    const c = new Float32Array(MOTE_POINTS * 3);
    const a = new Float32Array(MOTE_POINTS);
    for (let i = 0; i < MOTE_POINTS; i++) {
      const m = {
        x: (Math.random() * 2 - 1) * 2.4,
        y: -2.0 + Math.random() * 2.6,
        z: (Math.random() * 2 - 1) * 1.1,
        speed: 0.012 + Math.random() * 0.03,
        drift: (Math.random() - 0.5) * 0.012,
      };
      motes.push(m);
      p[i * 3] = m.x; p[i * 3 + 1] = m.y; p[i * 3 + 2] = m.z;
      c[i * 3] = 1.0; c[i * 3 + 1] = 0.55; c[i * 3 + 2] = 0.22;
      a[i] = 0.10 + Math.random() * 0.24;
    }
    moteGeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    moteGeo.setAttribute('aColor', new THREE.BufferAttribute(c, 3));
    moteGeo.setAttribute('aAlpha', new THREE.BufferAttribute(a, 1));
  }
  const motePos = moteGeo.attributes.position;
  scene.add(new THREE.Points(moteGeo, material(0.5)));

  /* ---------------------------------------------------------------- run -- */

  const LOOK = new THREE.Vector3(0, -0.52, 0);
  let pointerX = 0, pointerY = 0;
  let homeX = 0, homeY = -0.30;

  /**
   * Composition, which is the whole job here: the copy has to be readable over
   * this. On a wide screen the gloves are pushed into the right of the frame,
   * clear of the headline; on a narrow one there is no right to push them into,
   * so they go up above the text block instead. Both are done by moving the
   * camera rather than the gloves, so the rope still runs edge to edge.
   */
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    const aspect = w / h;
    renderer.setSize(w, h, false);
    camera.aspect = aspect;

    const wide = aspect >= 1.15;
    const dist = wide ? 3.05 : 4.35;

    // Half the world width visible at the subject's depth, so the offset is a
    // fraction of the frame rather than a number that only suits one viewport.
    const halfW = Math.tan((40 * Math.PI) / 360) * dist * aspect;

    homeX = wide ? -halfW * 0.40 : 0;
    homeY = wide ? -0.30 : -1.30;
    LOOK.set(homeX, wide ? -0.52 : -1.52, 0);

    camera.position.set(homeX, homeY, dist);
    camera.lookAt(LOOK);
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  if (!reduceMotion) {
    window.addEventListener('pointermove', (e) => {
      pointerX = (e.clientX / window.innerWidth) * 2 - 1;
      pointerY = (e.clientY / window.innerHeight) * 2 - 1;
    }, { passive: true });
  }

  let visible = true;
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0 });
  io.observe(canvas);
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; });

  const clock = new THREE.Clock();
  let raf = 0;

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!visible) return;

    const t = clock.getElapsedTime();
    const dt = Math.min(clock.getDelta(), 0.05);

    if (!reduceMotion) {
      for (const g of gloves) {
        const w = (Math.PI * 2) / g.period;
        // A touch of a second harmonic keeps the swing from reading as a
        // metronome, which is what a single sine always looks like.
        const swing = Math.sin(t * w + g.phase) * 0.075
                    + Math.sin(t * w * 2.3 + g.phase) * 0.014;
        g.points.rotation.z = swing + g.tilt * 0.35;
        g.points.rotation.y = g.tilt + Math.sin(t * w * 0.6 + g.phase) * 0.10;
        g.points.rotation.x = Math.sin(t * w * 0.8 + g.phase * 1.3) * 0.03;
      }

      const arr = motePos.array;
      for (let i = 0; i < motes.length; i++) {
        const m = motes[i];
        m.y += m.speed * dt * 6;
        m.x += m.drift * dt * 6;
        if (m.y > 0.7) { m.y = -2.1; m.x = (Math.random() * 2 - 1) * 2.4; }
        arr[i * 3] = m.x; arr[i * 3 + 1] = m.y; arr[i * 3 + 2] = m.z;
      }
      motePos.needsUpdate = true;

      // The camera leans a little toward the pointer, which is enough to make
      // the gloves sit in space rather than on the glass.
      camera.position.x += ((homeX + pointerX * 0.20) - camera.position.x) * 0.04;
      camera.position.y += ((homeY - pointerY * 0.13) - camera.position.y) * 0.04;
      camera.lookAt(LOOK);
    } else {
      for (const g of gloves) {
        g.points.rotation.z = g.tilt * 0.35;
        g.points.rotation.y = g.tilt;
      }
    }

    renderer.render(scene, camera);
  }
  frame();

  return {
    destroy() {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('resize', resize);
      renderer.dispose();
    },
  };
}

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
