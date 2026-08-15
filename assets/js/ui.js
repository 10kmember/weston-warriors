/**
 * ui.js — chrome and choreography.
 *
 * Scroll progress (shared with the WebGL scene), section tracking, reveal
 * transitions, metric counters, the boot sequence, the pointer ring, and the
 * enquiry form. All scroll work happens in a single rAF-throttled pass.
 */

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ boot -- */

export function initBoot() {
  const boot = document.getElementById('boot');
  const fill = document.getElementById('boot-fill');
  const status = document.getElementById('boot-status');
  if (!boot) return { done: Promise.resolve() };

  const steps = [
    'CALIBRATING ARENA…',
    'LOADING PARTICLE FIELD…',
    'TENSIONING ROPES…',
    'ARENA READY',
  ];

  let value = 0;
  let index = 0;
  const timer = window.setInterval(() => {
    value = Math.min(96, value + 6 + Math.random() * 16);
    if (fill) fill.style.width = `${value}%`;
    const next = Math.min(steps.length - 1, Math.floor((value / 100) * steps.length));
    if (next !== index && status) { index = next; status.textContent = steps[next]; }
  }, 180);

  const finish = () => {
    window.clearInterval(timer);
    if (fill) fill.style.width = '100%';
    if (status) status.textContent = steps[steps.length - 1];
    window.setTimeout(() => {
      boot.classList.add('is-done');
      document.body.classList.add('is-booted');
    }, 320);
  };

  const done = new Promise((resolve) => {
    const settle = () => { finish(); resolve(); };
    if (document.readyState === 'complete') window.setTimeout(settle, 500);
    else window.addEventListener('load', () => window.setTimeout(settle, 400), { once: true });
    // never hold the page hostage to a slow font or CDN
    window.setTimeout(settle, 4500);
  });

  return { done };
}

/* -------------------------------------------------------------- scrolling -- */

/**
 * Single scroll pass. Returns a getter for normalised page progress so the
 * WebGL scene can read it without registering its own scroll listener.
 */
export function initScroll() {
  const nav = document.getElementById('nav');
  const progressFill = document.getElementById('progress-fill');
  const railProgress = document.getElementById('rail-progress');
  const heroLines = Array.from(document.querySelectorAll('.hero__line'));
  const navLinks = new Map(
    Array.from(document.querySelectorAll('[data-nav]')).map((el) => [el.dataset.nav, el])
  );
  const sections = Array.from(document.querySelectorAll('[data-section]'));
  const reduce = prefersReducedMotion();

  let progress = 0;
  let ticking = false;

  function measure() {
    const doc = document.documentElement;
    const max = Math.max(1, doc.scrollHeight - window.innerHeight);
    const y = window.scrollY || doc.scrollTop || 0;
    progress = Math.min(1, Math.max(0, y / max));

    if (progressFill) progressFill.style.width = `${(progress * 100).toFixed(2)}%`;
    if (railProgress) railProgress.textContent = String(Math.round(progress * 100)).padStart(3, '0');
    nav?.classList.toggle('is-stuck', y > 40);

    if (!reduce && y < window.innerHeight * 1.4) {
      for (const line of heroLines) {
        const depth = parseFloat(line.dataset.depth || '0');
        line.style.transform = `translate3d(0, ${(-y * depth).toFixed(2)}px, 0)`;
      }
    }

    markActiveSection();
    ticking = false;
  }

  /**
   * The last section whose top has passed the reading line stays lit — including
   * past the final section, where an IntersectionObserver would simply go quiet
   * and leave whichever section fired last highlighted.
   */
  function markActiveSection() {
    if (!sections.length) return;
    const line = window.innerHeight * 0.42;
    let current = null;
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= line) current = section.dataset.section;
    }
    navLinks.forEach((el, id) => el.classList.toggle('is-active', id === current));
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(measure);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  measure();

  return () => progress;
}

/* ---------------------------------------------------------------- reveals -- */

export function initReveals() {
  const items = document.querySelectorAll('.reveal');
  if (!items.length) return;

  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      window.setTimeout(() => el.classList.add('is-visible'), i * 80);
      startCounters(el);
      observer.unobserve(el);
    });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });

  items.forEach((el) => observer.observe(el));
}

/* --------------------------------------------------------------- counters -- */

function startCounters(scope) {
  const targets = scope.querySelectorAll('[data-count]');
  if (!targets.length) return;
  const reduce = prefersReducedMotion();

  targets.forEach((el) => {
    if (el.dataset.counted) return;
    el.dataset.counted = '1';

    const end = parseFloat(el.dataset.count);
    if (!Number.isFinite(end)) return;
    const comma = el.dataset.format === 'comma';
    const render = (v) => {
      const rounded = Math.round(v);
      el.textContent = comma ? rounded.toLocaleString('en-GB') : String(rounded);
    };

    if (reduce) { render(end); return; }

    const duration = 1500;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);       // easeOutQuart
      render(end * eased);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/* ----------------------------------------------------------------- cursor -- */

export function initCursor() {
  const cursor = document.getElementById('cursor');
  if (!cursor) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (prefersReducedMotion()) return;

  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;
  let tx = x;
  let ty = y;
  let scale = 1;
  let targetScale = 1;
  let raf = 0;

  const loop = () => {
    x += (tx - x) * 0.22;
    y += (ty - y) * 0.22;
    scale += (targetScale - scale) * 0.18;
    // the scale lives in the same transform as the position: an inline
    // transform would otherwise beat any scale set from a CSS class
    cursor.style.transform =
      `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
    raf = requestAnimationFrame(loop);
  };

  window.addEventListener('pointermove', (event) => {
    tx = event.clientX;
    ty = event.clientY;
    cursor.classList.add('is-on');
    const hot = event.target instanceof Element &&
      event.target.closest('a, button, .card, .tenet, .roster__row, canvas, input, select, textarea');
    targetScale = hot ? 1.6 : 1;
    cursor.classList.toggle('is-hot', !!hot);
  }, { passive: true });

  document.addEventListener('pointerleave', () => cursor.classList.remove('is-on'));
  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}

/* -------------------------------------------------------------- nav menu -- */

export function initNav() {
  const nav = document.getElementById('nav');
  const button = document.getElementById('nav-toggle');
  const links = document.getElementById('nav-links');
  if (!nav || !button || !links) return;

  const setOpen = (open) => {
    nav.classList.toggle('is-open', open);
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };

  button.addEventListener('click', () => setOpen(!nav.classList.contains('is-open')));
  links.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && nav.classList.contains('is-open')) {
      setOpen(false);
      button.focus();
    }
  });
  // the panel only exists below the breakpoint; never leave it stuck open
  window.matchMedia('(min-width: 821px)').addEventListener('change', (e) => {
    if (e.matches) setOpen(false);
  });
}

/* ------------------------------------------------------------------- form -- */

export function initForm() {
  const form = document.getElementById('enquire-form');
  const status = document.getElementById('form-status');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const name = String(data.get('name') || '').trim();
    const email = String(data.get('email') || '').trim();

    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (status) status.textContent = 'NAME AND A VALID EMAIL ARE REQUIRED.';
      form.querySelector(!name ? '#f-name' : '#f-email')?.focus();
      return;
    }

    // No backend in this blueprint: wire this to your endpoint.
    if (status) {
      status.textContent = `RECEIVED, ${name.split(' ')[0].toUpperCase()} — A COACH REPLIES WITHIN TWO WORKING DAYS.`;
    }
    form.reset();
  });
}

/* ------------------------------------------------------------ audio button -- */

export function initAudioToggle(audio) {
  const button = document.getElementById('audio-toggle');
  if (!button || !audio) return;

  const label = button.querySelector('.audio-toggle__label');
  audio.onChange((muted) => {
    button.setAttribute('aria-pressed', String(!muted));
    button.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    if (label) label.textContent = muted ? 'SND' : 'ON';
  });

  button.addEventListener('click', () => audio.toggle());

  // If sound was left on from a previous visit, resume it at the first gesture.
  const wake = () => {
    if (!audio.isMuted()) audio.start();
    window.removeEventListener('pointerdown', wake);
    window.removeEventListener('keydown', wake);
  };
  window.addEventListener('pointerdown', wake, { once: false });
  window.addEventListener('keydown', wake, { once: false });
}

export { prefersReducedMotion };
