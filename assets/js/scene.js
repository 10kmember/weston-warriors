/**
 * scene.js — the scroll-driven WebGL backdrop.
 *
 * One point cloud, three baked position sets, blended in the vertex shader:
 *
 *   A · COLOSSEUM  — a crumbling arcade of arches with rubble on the sand
 *   B · STORM      — the same matter torn into a vortex (the untamed middle)
 *   C · THE RING   — a lattice-precise boxing ring: canvas, ropes, corner posts
 *
 * Scroll position drives the blend weights, so the page reads as one continuous
 * transformation from ruin to discipline. Colour follows the same arc: bronze
 * and ember at the start, cooling to stark white as the structure resolves.
 */

const COUNT_DESKTOP = 12000;
const COUNT_MOBILE = 5200;

/* ------------------------------------------------------------- geometry -- */

function fillColosseum(out, count) {
  const R = 3.35;
  const TIERS = 3;
  const COLS = 34;
  const TIER_H = 1.0;
  const HALF_W = 0.26;
  const PILLAR = 0.62;
  const Y0 = -1.55;
  const GAP_A = 0.55;          // the collapsed sector, in radians
  const GAP_B = 2.05;

  for (let i = 0; i < count; i++) {
    let x, y, z;
    const roll = Math.random();

    if (roll < 0.13) {
      // arena sand and scattered rubble on the floor
      const a = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random()) * R * 0.92;
      x = Math.cos(a) * rad;
      z = Math.sin(a) * rad;
      y = Y0 + Math.random() * 0.14;
    } else {
      const tier = Math.floor(Math.random() * TIERS);
      const col = Math.floor(Math.random() * COLS);
      const angle = (col / COLS) * Math.PI * 2 + (Math.random() - 0.5) * 0.012;
      const collapsed = angle > GAP_A && angle < GAP_B && tier >= 1;

      if (collapsed && Math.random() < 0.88) {
        // fallen masonry, heaped outside the footprint
        const rad = R * (0.75 + Math.random() * 0.55);
        x = Math.cos(angle) * rad + (Math.random() - 0.5) * 0.5;
        z = Math.sin(angle) * rad + (Math.random() - 0.5) * 0.5;
        y = Y0 + Math.pow(Math.random(), 2) * 0.55;
      } else {
        // arch outline in the plane tangent to the ring
        const u = Math.random();
        let s, h;
        if (u < 0.34) { s = -HALF_W; h = (u / 0.34) * PILLAR; }
        else if (u < 0.68) { s = HALF_W; h = ((u - 0.34) / 0.34) * PILLAR; }
        else {
          const th = Math.PI * ((u - 0.68) / 0.32);
          s = -HALF_W * Math.cos(th);
          h = PILLAR + Math.sin(th) * HALF_W * 1.15;
        }
        const rad = R - tier * 0.07;
        const decay = tier * 0.08;                        // upper tiers erode
        x = Math.cos(angle) * rad - Math.sin(angle) * s;
        z = Math.sin(angle) * rad + Math.cos(angle) * s;
        y = Y0 + 0.1 + tier * TIER_H + h;
        x += (Math.random() - 0.5) * (0.03 + decay);
        y += (Math.random() - 0.5) * (0.03 + decay);
        z += (Math.random() - 0.5) * (0.03 + decay);
      }
    }

    // a little dust always in the air
    if (Math.random() < 0.05) {
      x += (Math.random() - 0.5) * 1.6;
      y += Math.random() * 1.4;
      z += (Math.random() - 0.5) * 1.6;
    }

    out[i * 3] = x;
    out[i * 3 + 1] = y - 0.55;
    out[i * 3 + 2] = z;
  }
  return out;
}

function fillStorm(out, count) {
  for (let i = 0; i < count; i++) {
    const rad = 0.5 + Math.pow(Math.random(), 0.62) * 3.3;
    const angle = Math.random() * Math.PI * 2 + rad * 1.75;
    const band = 2.5 - rad * 0.48;
    const y = (Math.random() * 2 - 1) * Math.max(0.25, band);
    out[i * 3] = Math.cos(angle) * rad + (Math.random() - 0.5) * 0.35;
    out[i * 3 + 1] = y + Math.sin(rad * 2.2) * 0.35;
    out[i * 3 + 2] = Math.sin(angle) * rad + (Math.random() - 0.5) * 0.35;
  }
  return out;
}

function fillRing(out, count) {
  const HALF = 2.45;
  const FLOOR = -1.35;
  const POST_H = 1.75;
  const ROPES = [0.5, 0.95, 1.4];
  const GRID = 46;

  const snap = (t) => (Math.floor(t * GRID) / (GRID - 1)) * 2 - 1;

  for (let i = 0; i < count; i++) {
    let x, y, z;
    const roll = Math.random();

    if (roll < 0.40) {
      // canvas: a snapped lattice, so the eye reads order after the storm
      x = snap(Math.random()) * HALF;
      z = snap(Math.random()) * HALF;
      y = FLOOR + (Math.random() - 0.5) * 0.02;
    } else if (roll < 0.62) {
      // ropes, with a touch of sag between posts
      const side = Math.floor(Math.random() * 4);
      const rope = ROPES[Math.floor(Math.random() * ROPES.length)];
      const t = Math.random();
      const along = (t * 2 - 1) * HALF;
      const sag = -Math.sin(t * Math.PI) * 0.07;
      if (side === 0) { x = along; z = -HALF; }
      else if (side === 1) { x = along; z = HALF; }
      else if (side === 2) { x = -HALF; z = along; }
      else { x = HALF; z = along; }
      y = FLOOR + rope + sag;
      x += (Math.random() - 0.5) * 0.015;
      z += (Math.random() - 0.5) * 0.015;
    } else if (roll < 0.74) {
      // corner posts
      const cx = Math.random() < 0.5 ? -HALF : HALF;
      const cz = Math.random() < 0.5 ? -HALF : HALF;
      const a = Math.random() * Math.PI * 2;
      const rad = 0.05 + Math.random() * 0.02;
      x = cx + Math.cos(a) * rad;
      z = cz + Math.sin(a) * rad;
      y = FLOOR + Math.random() * POST_H;
    } else if (roll < 0.86) {
      // apron skirt around the platform edge
      const t = Math.random() * 4;
      const side = Math.floor(t);
      const along = ((t - side) * 2 - 1) * HALF;
      const edge = HALF + 0.16;
      if (side === 0) { x = along; z = -edge; }
      else if (side === 1) { x = along; z = edge; }
      else if (side === 2) { x = -edge; z = along; }
      else { x = edge; z = along; }
      y = FLOOR - Math.random() * 0.34;
    } else {
      // understructure: a frame lattice beneath the canvas
      const level = FLOOR - 0.45 - Math.floor(Math.random() * 2) * 0.28;
      if (Math.random() < 0.5) {
        x = snap(Math.random()) * HALF;
        z = (Math.random() * 2 - 1) * HALF;
      } else {
        x = (Math.random() * 2 - 1) * HALF;
        z = snap(Math.random()) * HALF;
      }
      y = level + (Math.random() - 0.5) * 0.015;
    }

    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}

/* --------------------------------------------------------------- shaders -- */

const VERT = /* glsl */`
  uniform vec3  uWeights;
  uniform float uTime;
  uniform float uSize;
  uniform float uDrift;
  uniform float uPixelRatio;

  attribute vec3  aColosseum;
  attribute vec3  aStorm;
  attribute vec3  aRing;
  attribute float aSeed;
  attribute float aScale;

  varying float vSeed;
  varying float vFade;

  void main() {
    vec3 pos = aColosseum * uWeights.x + aStorm * uWeights.y + aRing * uWeights.z;

    float phase = aSeed * 6.2831853;
    vec3 drift = vec3(
      sin(uTime * 0.45 + phase),
      cos(uTime * 0.38 + phase * 1.7),
      sin(uTime * 0.31 + phase * 2.3)
    );
    // the storm state breathes hardest; the ring holds still
    pos += drift * uDrift * (0.35 + aSeed * 0.8) * (0.25 + uWeights.y * 1.4);

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    // 22.0 is tuned against the camera's resting z (~10) to land a mid-sized
    // particle at roughly 2.5 CSS px; the clamp stops near-camera dust from
    // blooming into saturated blobs under additive blending.
    float size = uSize * aScale * (22.0 / max(-mv.z, 0.001));
    gl_PointSize = clamp(size, 0.6, 5.0) * uPixelRatio;

    vSeed = aSeed;
    vFade = clamp(1.0 - (-mv.z - 5.0) / 15.0, 0.12, 1.0);
  }
`;

// No explicit `precision` line here: three.js prepends one to both stages, and
// declaring mediump only in the fragment shader makes the shared uWeights
// uniform mismatch the vertex stage's highp — the program then fails to link.
const FRAG = /* glsl */`
  uniform vec3  uEmber;
  uniform vec3  uBronze;
  uniform vec3  uBone;
  uniform vec3  uWeights;
  uniform float uOpacity;

  varying float vSeed;
  varying float vFade;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = dot(c, c);
    if (d > 0.25) discard;

    float alpha = smoothstep(0.25, 0.0, d);
    float core  = smoothstep(0.06, 0.0, d);

    vec3 col = mix(uBronze, uEmber, smoothstep(0.15, 0.9, vSeed));
    col = mix(col, uEmber, uWeights.y * 0.4);          // the storm burns
    col = mix(col, uBone, uWeights.z * (0.5 + vSeed * 0.4));  // the ring cools
    col += core * 0.35;

    gl_FragColor = vec4(col, alpha * vFade * uOpacity);
  }
`;

/* ------------------------------------------------------------------ init -- */

/**
 * @param {object}   opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {() => number} opts.getProgress  scroll progress, 0..1
 * @param {boolean}  opts.reduceMotion
 * @returns {Promise<null | {count:number, dispose:Function}>} null if WebGL/three is unavailable
 */
export async function initScene({ canvas, getProgress, reduceMotion = false }) {
  let THREE;
  try {
    THREE = await import('three');
  } catch (err) {
    console.warn('[ww] three.js unavailable — running without the WebGL backdrop.', err);
    return null;
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      powerPreference: 'high-performance',
    });
  } catch (err) {
    console.warn('[ww] WebGL context unavailable.', err);
    return null;
  }

  const mobile = window.matchMedia('(max-width: 820px)').matches;
  const count = mobile ? COUNT_MOBILE : COUNT_DESKTOP;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0.35, 10);

  const group = new THREE.Group();
  scene.add(group);

  /* --- attributes ------------------------------------------------------- */

  const colosseum = fillColosseum(new Float32Array(count * 3), count);
  const storm = fillStorm(new Float32Array(count * 3), count);
  const ring = fillRing(new Float32Array(count * 3), count);
  const seeds = new Float32Array(count);
  const scales = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    seeds[i] = Math.random();
    scales[i] = 0.55 + Math.pow(Math.random(), 2.2) * 1.5;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(colosseum, 3));
  geometry.setAttribute('aColosseum', new THREE.BufferAttribute(colosseum, 3));
  geometry.setAttribute('aStorm', new THREE.BufferAttribute(storm, 3));
  geometry.setAttribute('aRing', new THREE.BufferAttribute(ring, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));

  const uniforms = {
    uWeights:    { value: new THREE.Vector3(1, 0, 0) },
    uTime:       { value: 0 },
    uSize:       { value: mobile ? 0.95 : 1.15 },
    uDrift:      { value: reduceMotion ? 0.02 : 0.11 },
    uOpacity:    { value: 0.9 },
    uPixelRatio: { value: renderer.getPixelRatio() },
    uEmber:      { value: new THREE.Color('#FF5500') },
    uBronze:     { value: new THREE.Color('#8C5A2B') },
    uBone:       { value: new THREE.Color('#F4F4F5') },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;          // positions live in the shader
  group.add(points);

  /* --- state ------------------------------------------------------------ */

  const weights = { a: 1, b: 0, c: 0 };
  const pointerTarget = { x: 0, y: 0 };
  const pointerEased = { x: 0, y: 0 };
  const clock = new THREE.Clock();
  let running = true;
  let raf = 0;
  let spin = 0;

  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  function targetWeights(progress) {
    // 0 → colosseum, 0.5 → storm, 1 → ring
    const t = clamp01(progress) * 2;
    const a = smooth(clamp01(1 - t));
    const c = smooth(clamp01(t - 1));
    const b = smooth(clamp01(1 - Math.abs(t - 1)));
    const sum = a + b + c || 1;
    return { a: a / sum, b: b / sum, c: c / sum };
  }

  function onPointerMove(event) {
    pointerTarget.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointerTarget.y = (event.clientY / window.innerHeight) * 2 - 1;
  }

  function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    uniforms.uPixelRatio.value = renderer.getPixelRatio();
  }

  function onVisibility() {
    if (document.hidden) pause();
    else resume();
  }

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);

  /* --- loop ------------------------------------------------------------- */

  function frame() {
    if (!running) return;
    raf = requestAnimationFrame(frame);

    const dt = Math.min(clock.getDelta(), 0.05);
    const progress = clamp01(getProgress());
    const target = targetWeights(progress);
    const ease = reduceMotion ? 1 : 1 - Math.pow(0.001, dt);

    weights.a = lerp(weights.a, target.a, ease);
    weights.b = lerp(weights.b, target.b, ease);
    weights.c = lerp(weights.c, target.c, ease);
    uniforms.uWeights.value.set(weights.a, weights.b, weights.c);
    uniforms.uTime.value += dt;

    pointerEased.x = lerp(pointerEased.x, pointerTarget.x, 1 - Math.pow(0.002, dt));
    pointerEased.y = lerp(pointerEased.y, pointerTarget.y, 1 - Math.pow(0.002, dt));

    if (!reduceMotion) spin += dt * 0.045;
    // idle turn plus a scroll-driven swing, so the ring squares up as it forms
    group.rotation.y = spin + progress * 0.85 + pointerEased.x * 0.1;
    group.rotation.x = lerp(group.rotation.x, -0.06 + pointerEased.y * 0.12 + progress * 0.22, 0.06);
    // the ring sits low in model space — lift it as it forms so the coda frames it
    group.position.y = lerp(group.position.y, progress * 0.75, 0.06);

    camera.position.x = lerp(camera.position.x, pointerEased.x * 0.9, 0.05);
    camera.position.y = lerp(camera.position.y, 0.35 - pointerEased.y * 0.5, 0.05);
    camera.position.z = lerp(camera.position.z, 10 - progress * 2.6, 0.04);
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  }

  function pause() {
    running = false;
    cancelAnimationFrame(raf);
  }
  function resume() {
    if (running) return;
    running = true;
    clock.getDelta();          // drop the paused interval
    raf = requestAnimationFrame(frame);
  }

  onResize();
  raf = requestAnimationFrame(frame);
  canvas.classList.add('is-ready');

  function dispose() {
    pause();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    geometry.dispose();
    material.dispose();
    renderer.dispose();
  }

  return { count, dispose, pause, resume };
}
