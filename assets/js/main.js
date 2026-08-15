/**
 * main.js — Weston Warriors entry point.
 *
 * Boots the chrome first (so the page is usable immediately), then attaches the
 * WebGL backdrop, the physics playground, and the audio engine. Every heavy
 * subsystem degrades on its own: no WebGL still leaves a complete site, no
 * Web Audio still leaves a working playground.
 */

import { createAudioEngine } from './audio.js';
import { initScene } from './scene.js';
import { initPlayground } from './playground.js';
import {
  initBoot, initScroll, initReveals, initCursor, initForm, initNav,
  initAudioToggle, prefersReducedMotion,
} from './ui.js';

const reduceMotion = prefersReducedMotion();

/* --------------------------------------------------------------- chrome -- */

const boot = initBoot();
const getProgress = initScroll();
initReveals();
initCursor();
initForm();
initNav();

/* ---------------------------------------------------------------- audio -- */

const audio = createAudioEngine();
initAudioToggle(audio);

/* ------------------------------------------------------------ playground -- */

initPlayground({
  canvas: document.getElementById('play'),
  audio,
  reduceMotion,
});

/* ------------------------------------------------------------- backdrop -- */

const glCanvas = document.getElementById('gl');
const readout = document.getElementById('hero-readout');

initScene({ canvas: glCanvas, getProgress, reduceMotion })
  .then((scene) => {
    if (!scene) {
      // No WebGL: drop the canvas and let the vignette carry the backdrop.
      glCanvas?.remove();
      if (readout) readout.textContent = 'RENDER · STATIC FALLBACK · NO WEBGL';
      return;
    }
    if (readout) {
      readout.textContent =
        `RENDER · PARTICLE FIELD · ${scene.count.toLocaleString('en-GB')} NODES`;
    }
  })
  .catch((err) => {
    console.warn('[ww] backdrop failed to start.', err);
    glCanvas?.remove();
  });

/* --------------------------------------------------------------- polish -- */

// Anchor jumps land under the fixed header; CSS scroll-margin handles the rest.
document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', (event) => {
    const id = link.getAttribute('href');
    if (!id || id === '#') return;
    const target = document.querySelector(id);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'start',
    });
    history.replaceState(null, '', id);
  });
});

// Once the boot curtain lifts, let the hero settle before anything else moves.
boot.done.then(() => document.body.classList.add('is-ready'));
