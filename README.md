# Weston Warriors — Digital Web Experience

A single-page, zero-build web experience for Weston Warriors ABC, a boxing club
at 22 Coker Rd, Worle, Weston-super-Mare. The creative spine is the journey from
**untamed grit to tamed mastery**: the Roman Colosseum's brutal grandeur
dissolving into the mechanical precision of a modern boxing ring, told through a
scroll-driven WebGL particle field.

```
01 // THE ARENA     the building, the coaching staff, how the floor runs
02 // TRIUMPHS      Tiah-Mai Ayton's record and the wider roster
03 // THE CODE      five tenets
04 // THE EXCHANGE  a sparring round rendered from particles
05 // THE SUMMONS   membership tiers and enquiry
```

## Running it

Plain HTML, CSS and ES modules. No build step and no runtime dependency beyond a
vendored copy of three.js. It must be served over HTTP, because ES modules and
import maps do not work from `file://`:

```bash
python3 -m http.server 8000     # or: npx http-server -p 8000
# → http://localhost:8000
```

Deploy by copying the directory to any static host.

## Structure

```
index.html                    all content, in markup, for SEO and no-JS reading
assets/css/main.css           design tokens, layout, motion
assets/js/main.js             entry point; wires subsystems, degrades each one
assets/js/scene.js            scroll-driven backdrop: particle morph shaders
assets/js/sparring.js         section 04: two particle rigs, IK, punch script
assets/js/audio.js            Web Audio drone and synthesised impact SFX
assets/js/ui.js               scroll, reveals, counters, boot, cursor, nav, form
assets/vendor/three.module.js three.js r169, vendored
llms.txt                      machine-readable summary for language models
robots.txt · sitemap.xml      crawler directives
humans.txt                    credits
.well-known/security.txt      RFC 9116 security contact
.nojekyll                     so GitHub Pages serves dot-directories verbatim
```

## Design system

| Token | Value | Role |
| --- | --- | --- |
| `--ink` | `#0A0A0A` | ground, dominant |
| `--ember` | `#FF5500` | accent, energy, active state |
| `--bronze` | `#8C5A2B` | structure, metadata, rules |
| `--bone` | `#F4F4F5` | primary text |

**Amatic SC** carries every display line, oversized and uppercase. **Nunito**
carries all body copy and UI. A system monospace stack carries the technical
readouts, so the metadata layer reads as instrumentation rather than typography.

## The scroll backdrop

One `THREE.Points` cloud of 12,000 particles (5,200 on small screens) holds
three baked position sets as vertex attributes and blends them in the shader:

```
uWeights.x  A · COLOSSEUM  a 34-column arcade over three tiers, one sector
                           collapsed into rubble on the sand
uWeights.y  B · STORM      the same matter torn into a vortex
uWeights.z  C · THE RING   a snapped lattice canvas, sagging ropes, corner posts
```

Scroll progress maps to `0 → A`, `0.5 → B`, `1 → C`. Weights are smoothstepped,
normalised and eased frame to frame so the morph has inertia. Colour follows the
same arc, bronze and ember through the ruin and the storm, cooling toward stark
white as the ring resolves. The coda section before the footer is deliberately
transparent so the resolved ring is the subject rather than the backdrop.

If WebGL or the module is unavailable, `initScene` resolves `null`, the canvas is
removed, and the vignette carries the backdrop alone.

## The sparring scene

Section 04 renders a round between two particle figures inside a dotted ring.

Each fighter is a skeleton of about sixteen joints. Every particle is bound to a
bone at build time with three numbers: `t` along the bone and `(u, v)` inside the
unit disc. Each frame the skeleton is posed, a perpendicular frame is rebuilt per
bone, and the particle is placed at

```
A + (B - A) * t + (n1 * u + n2 * v * squash) * radius(t)
```

so 1,540 points per fighter cost about sixteen bone solves and a linear write.
Elbows and knees come from a two-bone IK solve against a pole vector, which is
what stops the arms bending backwards.

The two styles are the point of the scene. The dark fighter throws **straight**:
the glove travels a near-linear path and snaps home in 0.34s. The light fighter
**loops**: the glove rides a quadratic Bézier bowed out to the side over 0.52s,
so it is late coming back and gets blocked or slipped every time. A punch script
drives the round, each entry naming the thrower, the arm, the punch and what the
other fighter does about it. Embers shed from a glove in flight, because a
cluster moving 40cm in a third of a second is otherwise easy to miss.

On colour: with additive blending on a near-black ground, a genuinely black
particle emits nothing and is invisible. The dark fighter is drawn in the deepest
graphite that still reads as a body, with ember gloves.

## The audio engine

Pure Web Audio. The site ships no audio files.

- **Ambient drone:** a 27.5 Hz sub, two detuned 55 Hz saws and an 82.4 Hz
  triangle through a resonant lowpass swept by a 0.045 Hz LFO, plus a bandpassed
  noise bed with slow amplitude drift.
- **Impacts:** a bandpassed noise burst stacked with a pitch-swept sine, gain and
  decay scaled by the punch, stereo panned to the point of contact.

Everything runs through a soft limiter. The context is created lazily and resumed
on the first gesture, per browser autoplay policy. The mute state persists in
`localStorage` and the site starts muted.

## Accessibility and performance

- All content lives in markup. JavaScript only adds behaviour.
- `prefers-reduced-motion` disables parallax, reveals, counters, grain and
  particle drift, and holds the sparring figures in a static guard.
- Skip link, visible focus rings, labelled controls, `aria-pressed` on toggles,
  and text alternatives on the chart, the capacity bars and both canvases.
- Both canvases pause via `IntersectionObserver` and `visibilitychange`, device
  pixel ratio is capped at 2, and scroll work is batched into one rAF pass.

## Deploying to GitHub Pages

`.github/workflows/deploy-pages.yml` builds and deploys on every push. Creating a
Pages site for the first time needs repository admin rights that the workflow
token does not have, so once per repository you must set **Settings → Pages →
Source** to **GitHub Actions**. After that the workflow handles everything.

The canonical URL appears in `index.html`, `robots.txt`, `sitemap.xml` and
`llms.txt`. Change it in those four files if you host elsewhere.

## Notes on content

Real and verified: the club, the address and coordinates, head coach Dean Lewis,
deputy coach Simon Flett, and Tiah-Mai Ayton's record (21-0 as an amateur, five
national titles, gold at 57kg at the 2024 World Under-19 Championships, 6-0 with
5 knockouts as a professional under Matchroom).

Still placeholder, and worth replacing before this goes anywhere public: the
other three roster fighters, the membership tiers and prices, the capacity
numbers, and the training-load chart. The enquiry form validates and reports
locally but posts nowhere. Wire `initForm` in `assets/js/ui.js` to your endpoint.

## Credits

Designed and built by [father](https://princey.netlify.app).
