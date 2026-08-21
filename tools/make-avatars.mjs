/**
 * Generates the default avatar set into assets/avatars/.
 *
 * The faces follow the illustration style of Alesyia Volkova: a flat coloured
 * disc, features in soft charcoal, and hair drawn as loose stroked lines in a
 * darker tone of the face that spill outside the circle.
 *
 * They are generated rather than hand drawn so the ten of them stay consistent
 * with each other: one change to a helper here moves every face at once.
 *
 *   node tools/make-avatars.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'avatars');

const INK = '#3D3D3D';
const WHITE = '#FFFFFF';

/* Layout, fixed once so every face lines up:
 *   face   circle cx 100, cy 105, r 78   (crown at y 27, chin at y 183)
 *   hair   fills the crown, hairline lands at y 62 to 76
 *   brows  y 84            eyes  cy 114            mouth  y 150 upward
 */

/* ------------------------------------------------------------------ hair -- */

/** Long hair with a straight fringe, falling either side of the face. */
function fringe(c) {
  const s = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const x = 28 + t * 144;
    // hairline dips at the temples and lifts over the middle of the forehead
    const end = 62 + Math.pow(Math.abs(t - 0.5) * 2, 2) * 16;
    s.push(`M${(100 + (x - 100) * 0.10).toFixed(1)} 29 Q${(100 + (x - 100) * 0.62).toFixed(1)} ${(40 + end * 0.28).toFixed(1)} ${x.toFixed(1)} ${end.toFixed(1)}`);
  }
  // the long outer sweeps, falling past the jaw
  s.push('M74 32 C28 48 12 118 26 180');
  s.push('M66 35 C22 56 6 122 20 184');
  s.push('M126 32 C172 48 188 118 174 180');
  s.push('M134 35 C178 56 194 122 180 184');
  return strokes(s, c);
}

/** Hair swept hard to one side, a few long strands leaving the crown. */
function swept(c) {
  const s = [];
  // a fan leaving the left temple and combed across the crown to the right
  for (let i = 0; i < 8; i++) {
    const lift = i * 5;
    s.push(`M20 ${74 - i * 2} C${44 + i * 2} ${26 - lift * 0.5} ${132 + i * 3} ${30 - lift * 0.3} ${178 - i * 3} ${64 + i * 4}`);
  }
  // strands dropping down the sides
  s.push('M20 72 C10 100 14 128 26 148');
  s.push('M178 68 C192 96 188 126 174 146');
  return strokes(s, c);
}

/** Gathered up into a knot, with loops above the crown. */
function topknot(c, loops = 5) {
  const s = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    const x = 26 + t * 148;
    const end = 66 + Math.pow(Math.abs(t - 0.5) * 2, 2) * 22;
    s.push(`M${x.toFixed(1)} ${end.toFixed(1)} Q${(100 + (x - 100) * 0.62).toFixed(1)} ${(44 + end * 0.18).toFixed(1)} 104 26`);
  }
  for (let i = 0; i < loops; i++) {
    const a = -0.55 + (i / (loops - 1)) * 1.8;
    const dx = Math.cos(a) * 40;
    const dy = Math.sin(a) * 26;
    s.push(`M104 26 C${(104 + dx * 0.5).toFixed(1)} ${(26 - 26 - dy).toFixed(1)} ${(104 + dx * 1.3).toFixed(1)} ${(20 - dy * 0.4).toFixed(1)} ${(104 + dx * 0.9).toFixed(1)} ${(24 + dy * 0.5).toFixed(1)}`);
  }
  return strokes(s, c);
}

/** Long wavy hair blowing sideways. */
function wild(c) {
  const s = [];
  // everything radiates from one point at the left temple, blowing right
  const ox = 48, oy = 62;
  for (let i = 0; i < 10; i++) {
    const y = 22 + i * 7;
    const amp = 6 + (i % 3) * 4;
    s.push(`M${ox} ${oy} C${ox + 30} ${y} ${120} ${y - amp} ${150} ${y + amp * 0.5} S${186} ${y - amp} ${204} ${y + 4}`);
  }
  // and a few falling down the left, clear of the face
  for (let i = 0; i < 6; i++) {
    s.push(`M${ox} ${oy} C${26 - i * 3} ${76 + i * 8} ${14 - i * 2} ${104 + i * 10} ${28 - i * 3} ${134 + i * 9}`);
  }
  return strokes(s, c);
}

/** Short hair combed across the crown. */
function short(c) {
  const s = [];
  for (let i = 0; i <= 15; i++) {
    const t = i / 15;
    const x = 30 + t * 140;
    const end = 58 + Math.pow(Math.abs(t - 0.5) * 2, 2) * 18;
    s.push(`M${(100 + (x - 100) * 0.25).toFixed(1)} 30 Q${(100 + (x - 100) * 0.8).toFixed(1)} ${(36 + end * 0.2).toFixed(1)} ${x.toFixed(1)} ${end.toFixed(1)}`);
  }
  return strokes(s, c);
}

/** Short bristles standing up around the crown. */
function spiky(c) {
  const s = [];
  for (let i = 0; i < 26; i++) {
    const a = Math.PI * (1.06 + (i / 25) * 0.88);
    const x = 100 + Math.cos(a) * 78;
    const y = 105 + Math.sin(a) * 78;
    const len = 10 + (i % 3) * 5;
    s.push(`M${x.toFixed(1)} ${y.toFixed(1)} L${(100 + Math.cos(a) * (78 + len)).toFixed(1)} ${(105 + Math.sin(a) * (78 + len)).toFixed(1)}`);
  }
  return strokes(s, c, 4.5);
}

const strokes = (list, colour, width = 3.4) =>
  `<g fill="none" stroke="${colour}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">` +
  list.map((d) => `<path d="${d}"/>`).join('') + '</g>';

/* ------------------------------------------------------------------ eyes -- */

const eyeWhite = (cx, cy, rx = 23, ry = 27) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${WHITE}"/>`;
const pupil = (cx, cy, r = 5.5) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${INK}"/>`;

const eyesOpen = (look = 0) =>
  eyeWhite(70, 114) + eyeWhite(130, 114) +
  pupil(70 + look, 110) + pupil(130 + look, 110);

const eyesWide = () =>
  eyeWhite(70, 113, 26, 30) + eyeWhite(130, 113, 26, 30) + pupil(70, 116, 7) + pupil(130, 116, 7);

/** Half closed: the whole eye, with the face colour painted back over the top. */
const eyesHeavy = (face) =>
  eyeWhite(70, 114) + eyeWhite(130, 114) +
  pupil(70, 118) + pupil(130, 118) +
  `<path d="M47 114a23 27 0 0 1 46 0z" fill="${face}"/>` +
  `<path d="M107 114a23 27 0 0 1 46 0z" fill="${face}"/>` +
  `<g fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round">` +
  `<path d="M48 113h44"/><path d="M108 113h44"/></g>`;

const eyesSquint = () =>
  `<g fill="none" stroke="${INK}" stroke-width="5.5" stroke-linecap="round">` +
  `<path d="M52 122q18 -22 36 -2"/><path d="M112 120q18 -20 36 2"/></g>`;

const eyesTeary = () =>
  eyeWhite(70, 112, 24, 28) + eyeWhite(130, 112, 24, 28) + pupil(70, 116) + pupil(130, 116) +
  `<g fill="#2FB6C8">` +
  `<path d="M50 136c6 9 8 17 1 21s-13-2-11-11 6-8 10-10z"/>` +
  `<path d="M150 136c-6 9-8 17-1 21s13-2 11-11-6-8-10-10z"/></g>`;

/* ---------------------------------------------------------------- brows -- */

const browsFlat = () =>
  `<g fill="${INK}"><ellipse cx="66" cy="84" rx="17" ry="5.5" transform="rotate(-8 66 84)"/>` +
  `<ellipse cx="134" cy="84" rx="17" ry="5.5" transform="rotate(8 134 84)"/></g>`;

const browsAngry = () =>
  `<g fill="${INK}"><ellipse cx="70" cy="86" rx="20" ry="6.5" transform="rotate(16 70 86)"/>` +
  `<ellipse cx="130" cy="86" rx="20" ry="6.5" transform="rotate(-16 130 86)"/></g>`;

const browsWorried = () =>
  `<g fill="${INK}"><ellipse cx="68" cy="84" rx="17" ry="6" transform="rotate(-18 68 84)"/>` +
  `<ellipse cx="132" cy="84" rx="15" ry="7" transform="rotate(14 132 84)"/></g>`;

const browsSly = () =>
  `<g fill="${INK}"><ellipse cx="66" cy="88" rx="18" ry="6" transform="rotate(-14 66 88)"/>` +
  `<ellipse cx="132" cy="80" rx="19" ry="6.5" transform="rotate(14 132 80)"/></g>`;

const browsRaised = () =>
  `<g fill="${INK}"><ellipse cx="66" cy="80" rx="16" ry="5.5" transform="rotate(-12 66 80)"/>` +
  `<ellipse cx="134" cy="80" rx="16" ry="5.5" transform="rotate(12 134 80)"/></g>`;

/* ---------------------------------------------------------------- mouths -- */

const smile = () =>
  `<path d="M58 150q42 42 84 0" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`;

const smirk = () =>
  `<path d="M72 162q34 12 56 -22" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`;

const frown = () =>
  `<path d="M74 166q26 -22 52 0" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`;

const scowl = () =>
  `<path d="M84 158q16 -12 32 0" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>` +
  `<path d="M86 168q14 -10 28 0" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`;

/** Open grin: a real crescent of mouth with the upper teeth hanging into it.
 *
 *  A quadratic sits at only half the control point's offset at its midpoint,
 *  so the control values below look further out than the shape they draw.
 */
const grin = ({ tongue = false } = {}) => {
  const quad = (a, c, b, t) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b;
  const teeth = [];
  for (let i = 1; i < 8; i++) {
    const t = i / 8;
    const x = 56 + t * 88;
    const y = quad(139, 156, 139, t);
    teeth.push(`<path d="M${x.toFixed(1)} ${y.toFixed(1)} L${x.toFixed(1)} ${(y + 14).toFixed(1)}" stroke="${INK}" stroke-width="2.4"/>`);
  }
  return `<path d="M52 137 Q100 232 148 137 Q100 158 52 137 Z" fill="${INK}"/>` +
    `<path d="M56 139 Q100 156 144 139 L143 152 Q100 170 57 152 Z" fill="${WHITE}"/>` +
    teeth.join('') +
    (tongue ? `<path d="M82 170 q18 -13 36 0 q-4 15 -18 15 t-18 -15 z" fill="#D6246B"/>` : '');
};

/** Gritted teeth: a tense band of them, top and bottom. */
const gritted = () => {
  const bars = [];
  for (let i = 1; i < 7; i++) bars.push(`<path d="M${64 + i * 12} 146 L${64 + i * 12} 178" stroke="${INK}" stroke-width="2.4"/>`);
  return `<path d="M58 146 q42 -11 84 0 q4 23 -6 33 q-36 9 -72 0 q-10 -10 -6 -33 z" fill="${INK}"/>` +
    `<path d="M63 150 q37 -9 74 0 l-2 11 q-35 7 -70 0 z" fill="${WHITE}"/>` +
    `<path d="M67 170 q33 -7 66 0 l-2 8 q-31 6 -62 0 z" fill="${WHITE}"/>` +
    bars.join('');
};

/** A round shout, upper teeth showing at the top of the opening. */
const gasp = () =>
  `<ellipse cx="100" cy="158" rx="30" ry="29" fill="${INK}"/>` +
  `<path d="M76 133 Q100 143 124 133 L123 145 Q100 155 77 145 Z" fill="${WHITE}"/>` +
  `<path d="M100 136 L100 150" stroke="${INK}" stroke-width="2.4"/>`;

/* ----------------------------------------------------------------- faces -- */

const FACES = [
  {
    key: 'green-calm', name: 'Calm', mood: 'Steady and quietly pleased',
    face: '#22A046', hair: '#1C7A36',
    parts: (c) => fringe(c.hair) + eyesOpen(-2) + browsRaised() + smile(),
  },
  {
    key: 'green-nervy', name: 'Nervy', mood: 'Wound up before the bell',
    face: '#22A046', hair: '#1C7A36',
    parts: (c) => swept(c.hair) + eyesWide() + browsWorried() + gritted(),
  },
  {
    key: 'yellow-sly', name: 'Sly', mood: 'Up to something',
    face: '#E8CF1B', hair: '#C0A814',
    parts: (c) => fringe(c.hair) + eyesOpen(4) + browsSly() + smirk(),
  },
  {
    key: 'red-fired-up', name: 'Fired Up', mood: 'Ready to go three rounds',
    face: '#E02A2A', hair: '#B41F1F',
    parts: (c) => topknot(c.hair) + eyesOpen(2) + browsAngry() + scowl(),
  },
  {
    key: 'orange-wild', name: 'Wild', mood: 'All gas, no brakes',
    face: '#F08A22', hair: '#C4661A',
    parts: (c) => wild(c.hair) + eyesOpen(3) + browsRaised() + grin({ tongue: true }),
  },
  {
    key: 'red-unbothered', name: 'Unbothered', mood: 'Seen it all before',
    face: '#E02A2A', hair: '#B41F1F',
    parts: (c) => swept(c.hair) + eyesHeavy(c.face) + browsFlat() + smirk(),
  },
  {
    key: 'yellow-tender', name: 'Tender', mood: 'Having a moment',
    face: '#E8CF1B', hair: '#C0A814',
    parts: (c) => fringe(c.hair) + eyesTeary() + browsWorried() + frown(),
  },
  {
    key: 'orange-beaming', name: 'Beaming', mood: 'Just won something',
    face: '#F08A22', hair: '#C4661A',
    parts: (c) => topknot(c.hair, 4) + eyesOpen(0) + browsRaised() + grin(),
  },
  {
    key: 'teal-laughing', name: 'Laughing', mood: 'Cannot keep it together',
    face: '#12A5B8', hair: '#0D8496',
    parts: (c) => short(c.hair) + eyesSquint() + browsFlat() + grin(),
  },
  {
    key: 'teal-startled', name: 'Startled', mood: 'Did not see that coming',
    face: '#12A5B8', hair: '#0D8496',
    parts: (c) => spiky(c.hair) + eyesWide() + browsWorried() + gasp(),
  },
];

/* ------------------------------------------------------------------- run -- */

function render(spec) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 210" role="img" aria-label="${spec.name} avatar">
<title>${spec.name}</title>
<circle cx="100" cy="105" r="78" fill="${spec.face}"/>
${spec.parts({ face: spec.face, hair: spec.hair })}
</svg>`;
}

await fs.mkdir(OUT, { recursive: true });
for (const spec of FACES) {
  await fs.writeFile(path.join(OUT, `${spec.key}.svg`), render(spec) + '\n', 'utf8');
}

// A manifest the app reads, so the set is defined in one place only.
const manifest = FACES.map(({ key, name, mood, face }) => ({ key, name, mood, colour: face }));
await fs.writeFile(
  path.join(OUT, 'manifest.json'),
  JSON.stringify({
    credit: {
      illustrator: 'Alesyia Volkova',
      note: 'Default avatar illustrations in the style of, and credited to, Alesyia Volkova.',
    },
    avatars: manifest,
  }, null, 2) + '\n',
  'utf8'
);

console.log(`wrote ${FACES.length} avatars + manifest to assets/avatars/`);
