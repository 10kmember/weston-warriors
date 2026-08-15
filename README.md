# Weston Warriors — Digital Web Experience

A single-page, zero-build web experience for a fictional elite boxing sanctuary.
The creative spine is the journey from **untamed grit to tamed mastery**: the
Roman Colosseum's brutal grandeur dissolving into the mechanical precision of a
modern boxing ring, told through a scroll-driven WebGL particle field.

```
01 // THE ARENA          — facility, capacity, and floor metrics
02 // TRIUMPHS           — fight record, roster, training load
03 // THE CODE           — five tenets
04 // THE PROVING GROUND — interactive 2D physics playground
05 // THE SUMMONS        — membership tiers and enquiry
```

## Running it

The site is plain HTML/CSS/ES modules with no build step and no runtime
dependencies beyond a vendored copy of three.js. It must be served over HTTP
(ES modules and import maps do not work from `file://`):

```bash
python3 -m http.server 8000     # or: npx http-server -p 8000
# → http://localhost:8000
```

Deploy by copying the directory to any static host.

## Structure

```
index.html                  all content, in markup, for SEO and no-JS reading
assets/css/main.css         design tokens, layout, motion
assets/js/main.js           entry point; wires subsystems, degrades each one
assets/js/scene.js          three.js particle field + morph shaders
assets/js/physics.js        standalone 2D rigid-body engine
assets/js/playground.js     canvas renderer, input, and audio wiring for 04
assets/js/audio.js          Web Audio drone + synthesised impact SFX
assets/js/ui.js             scroll, reveals, counters, boot, cursor, form
assets/vendor/three.module.js   three.js r169, vendored
```

## Design system

| Token | Value | Role |
| --- | --- | --- |
| `--ink` | `#0A0A0A` | ground, dominant |
| `--ember` | `#FF5500` | accent, energy, active state |
| `--bronze` | `#8C5A2B` | structure, metadata, rules |
| `--bone` | `#F4F4F5` | primary text |

**Amatic SC** carries every display line — oversized, uppercase, tightly
leaded. **Nunito** carries all body copy and UI. A system monospace stack
carries the technical readouts (coordinates, section indices, engine notes) so
the metadata layer reads as instrumentation rather than typography.

## The WebGL backdrop

One `THREE.Points` cloud of 12,000 particles (5,200 on small screens) holds
three baked position sets as vertex attributes and blends them in the shader:

```
uWeights.x  A · COLOSSEUM  a 34-column arcade over three tiers, one sector
                           collapsed into rubble on the sand
uWeights.y  B · STORM      the same matter torn into a vortex — the untamed middle
uWeights.z  C · THE RING   a snapped lattice canvas, sagging ropes, corner posts
```

Scroll progress maps to `0 → A`, `0.5 → B`, `1 → C`; weights are smoothstepped,
normalised, and eased frame-to-frame so the morph has inertia. Colour follows
the same arc — bronze and ember through the ruin and the storm, cooling toward
stark white as the ring resolves. Per-particle drift is scaled by the storm
weight, so chaos breathes and structure holds still.

Nothing about the page depends on it: if WebGL or the module is unavailable,
`initScene` resolves `null`, the canvas is removed, and the vignette carries the
backdrop alone.

## The physics engine

`physics.js` is self-contained — no external physics library — and models
circles in an axis-aligned box:

- semi-implicit Euler on a fixed 120 Hz substep with an accumulator
- mass-weighted normal impulses, `e = min(eA, eB)` per pair
- Coulomb friction on the collision tangent, driving body spin
- Baumgarte positional correction with slop, so stacks do not sink or jitter
- sleeping for settled bodies
- grabbed bodies become infinite-mass kinematic movers, so dragging one body
  genuinely shoves the others rather than tunnelling through them

Contacts are gated by closing speed (`World.impactSpeed`) before they count as
impacts — without that gate a body resting on the floor reports a
micro-collision every substep and the audio turns to static.

**Controls:** drag to grab, release to throw, click open floor for a shockwave.
With the canvas focused: `S` shockwave, `R` reset, `G` gravity, `A` add a body.

## The audio engine

Pure Web Audio — the site ships no audio files.

- **Ambient drone:** a 27.5 Hz sub, two detuned 55 Hz saws and an 82.4 Hz
  triangle through a resonant lowpass swept by a 0.045 Hz LFO, plus a bandpassed
  noise bed with slow amplitude drift.
- **Impacts:** a bandpassed noise burst (the leather) stacked with a
  pitch-swept sine (the body), gain- and decay-scaled by collision impulse,
  stereo-panned to the impact's x position, throttled so pile-ups stay legible.
- **Shockwave:** a 120 → 26 Hz swell with a highpassed air layer.

Everything runs through a soft limiter. The context is created lazily and
resumed on the first gesture, per browser autoplay policy; the mute state
persists in `localStorage` and the site starts muted.

## Accessibility and performance

- All content lives in markup; JavaScript only adds behaviour.
- `prefers-reduced-motion` disables parallax, reveals, counters, grain, and
  particle drift, and settles the playground without animating it.
- Skip link, visible focus rings, labelled controls, `aria-pressed` on toggles,
  and text alternatives on the chart and capacity bars.
- Both canvases pause via `IntersectionObserver` and `visibilitychange`; device
  pixel ratio is capped at 2; scroll work is batched into one rAF pass.

## Notes for production

- Google Fonts is loaded from the CDN as specified; self-host the two families
  if you need to remove the third-party request.
- The enquiry form validates and reports locally but posts nowhere — wire
  `initForm` in `assets/js/ui.js` to your endpoint.
- Roster names, records, metrics, and contact details are placeholder content.
