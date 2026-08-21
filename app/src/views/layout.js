/**
 * Server-rendered HTML.
 *
 * No template engine: pages are functions returning strings, and everything
 * interpolated goes through `esc` unless it is explicitly marked as trusted
 * markup by the caller. That keeps the escaping decision visible at every call
 * site instead of hidden in a template's default.
 */

/** HTML-escape. Use on every value that came from a user or the database. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** £ from pence. */
export function money(pence, currency = 'GBP') {
  const symbol = currency === 'GBP' ? '£' : '';
  const value = (Number(pence || 0) / 100).toFixed(2);
  return `${symbol}${value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

export function shortDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

export function longDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function timeOnly(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function statusPill(status) {
  const tone = {
    active: 'ok', paid: 'ok', succeeded: 'ok', attended: 'ok', booked: 'ok', trialing: 'ok',
    open: 'warn', past_due: 'bad', pending: 'warn', paused: 'warn', no_show: 'bad',
    cancelled: 'muted', void: 'muted', failed: 'bad', uncollectible: 'bad',
    refunded: 'muted', draft: 'muted', suspended: 'bad', completed: 'ok',
    in_progress: 'warn', rejected: 'bad', erased: 'muted',
  }[status] || 'muted';
  return `<span class="pill pill--${tone}">${esc(String(status).replace(/_/g, ' '))}</span>`;
}

const NAV = [
  ['/dashboard', 'Overview', 'M3 12h7V3H3v9Zm0 9h7v-7H3v7Zm11 0h7V12h-7v9Zm0-18v7h7V3h-7Z'],
  ['/dashboard/classes', 'Classes', 'M4 5h16M4 12h16M4 19h16'],
  ['/dashboard/subscription', 'Membership', 'M3 7h18v10H3zM3 11h18'],
  ['/dashboard/billing', 'Billing', 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h4'],
  ['/dashboard/profile', 'Profile', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0'],
  ['/dashboard/privacy', 'Privacy & data', 'M12 3l7 3v6c0 4.5-3 8.3-7 9-4-0.7-7-4.5-7-9V6l7-3Z'],
  ['/dashboard/security', 'Security', 'M6 10V8a6 6 0 1 1 12 0v2M5 10h14v10H5z'],
];

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body      trusted markup
 * @param {object} [opts.member]  the signed-in member, if any
 * @param {string} [opts.active]  path of the active nav item
 * @param {object} [opts.flash]   { kind: 'ok'|'bad', message }
 */
export function page({ title, body, member, active = '', flash = null, wide = false }) {
  const nav = member ? NAV.map(([href, label, d]) => `
    <a class="side__link${href === active ? ' is-active' : ''}" href="${href}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>
      <span>${esc(label)}</span>
    </a>`).join('') : '';

  const initials = member
    ? esc(((member.first_name || member.email || '?')[0] + (member.last_name || '')[0] || '').toUpperCase())
    : '';

  const erasureBanner = member?.erasure_requested_at ? `
    <div class="banner banner--bad">
      <strong>Erasure requested.</strong>
      Your account and personal data are scheduled for deletion on
      ${esc(shortDate(member.erasure_due_at))}. You can still cancel this from
      <a href="/dashboard/privacy">Privacy &amp; data</a>.
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} · Weston Warriors</title>
<meta name="robots" content="noindex, nofollow" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Amatic+SC:wght@400;700&family=Nunito:ital,wght@0,300;0,400;0,600;0,700;0,800;1,400&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/assets/css/main.css" />
<link rel="stylesheet" href="/assets/css/dashboard.css" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%230A0A0A'/%3E%3Cg fill='none' stroke='%23FF5500' stroke-width='2.2' stroke-linejoin='round' stroke-linecap='round'%3E%3Cpath d='M3 9l3 14 3-9 3 9 3-14'/%3E%3Cpath d='M17 9l3 14 3-9 3 9 3-14'/%3E%3C/g%3E%3C/svg%3E" />
</head>
<body class="app${member ? '' : ' app--bare'}">
<a class="skip-link" href="#main">Skip to content</a>

<header class="topbar">
  <a class="topbar__brand" href="${member ? '/dashboard' : '/'}">
    <svg viewBox="0 0 44 24" width="38" height="21" aria-hidden="true">
      <path d="M2 3l4.5 18 4.5-12 4.5 12 4.5-18" />
      <path d="M24 3l4.5 18 4.5-12 4.5 12 4.5-18" />
    </svg>
    <span>Weston<br />Warriors</span>
  </a>

  ${member ? `
  <div class="topbar__right">
    <a class="topbar__site mono" href="/">Main site</a>
    <div class="who">
      <span class="who__avatar" aria-hidden="true">${initials}</span>
      <span class="who__name mono">${esc(member.first_name || member.email)}</span>
    </div>
  </div>` : `
  <div class="topbar__right">
    <a class="topbar__site mono" href="/">Main site</a>
  </div>`}
</header>

${member ? `<button class="side__toggle mono" id="side-toggle" type="button" aria-expanded="false" aria-controls="side">MENU</button>` : ''}

<div class="shell${member ? '' : ' shell--bare'}">
  ${member ? `<nav class="side" id="side" aria-label="Dashboard">
    ${nav}
    <form class="side__out" method="post" action="/signout">
      <input type="hidden" name="_csrf" value="${esc(member.csrf_token)}" />
      <button class="side__link side__link--out" type="submit">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/></svg>
        <span>Sign out</span>
      </button>
    </form>
  </nav>` : ''}

  <main class="main${wide ? ' main--wide' : ''}" id="main">
    ${erasureBanner}
    ${flash ? `<div class="banner banner--${esc(flash.kind)}">${esc(flash.message)}</div>` : ''}
    ${body}
  </main>
</div>

<script>
  // The sidebar collapses on small screens; this is the only script the
  // dashboard needs, so it stays inline rather than costing a request.
  (function () {
    var t = document.getElementById('side-toggle');
    var s = document.getElementById('side');
    if (!t || !s) return;
    t.addEventListener('click', function () {
      var open = s.classList.toggle('is-open');
      t.setAttribute('aria-expanded', String(open));
    });
    s.addEventListener('click', function (e) {
      if (e.target.closest('a')) s.classList.remove('is-open');
    });
  })();
</script>
</body>
</html>`;
}

/* --------------------------------------------------------- small pieces -- */

export function card(title, body, { action = '', tone = '' } = {}) {
  return `<section class="card2${tone ? ` card2--${tone}` : ''}">
    <header class="card2__head">
      <h2 class="card2__title">${esc(title)}</h2>
      ${action}
    </header>
    ${body}
  </section>`;
}

export function field(name, label, value = '', opts = {}) {
  const {
    type = 'text', required = false, error = '', hint = '',
    autocomplete = '', placeholder = '', max = '',
  } = opts;
  return `<div class="f${error ? ' f--bad' : ''}">
    <label class="f__label mono" for="f-${esc(name)}">${esc(label)}</label>
    <input class="f__input" id="f-${esc(name)}" name="${esc(name)}" type="${esc(type)}"
      value="${esc(value)}"
      ${required ? 'required' : ''}
      ${autocomplete ? `autocomplete="${esc(autocomplete)}"` : ''}
      ${placeholder ? `placeholder="${esc(placeholder)}"` : ''}
      ${max ? `max="${esc(max)}"` : ''} />
    ${hint ? `<p class="f__hint">${esc(hint)}</p>` : ''}
    ${error ? `<p class="f__err">${esc(error)}</p>` : ''}
  </div>`;
}

export function textarea(name, label, value = '', opts = {}) {
  const { rows = 3, hint = '', error = '' } = opts;
  return `<div class="f${error ? ' f--bad' : ''}">
    <label class="f__label mono" for="f-${esc(name)}">${esc(label)}</label>
    <textarea class="f__input" id="f-${esc(name)}" name="${esc(name)}" rows="${rows}">${esc(value)}</textarea>
    ${hint ? `<p class="f__hint">${esc(hint)}</p>` : ''}
    ${error ? `<p class="f__err">${esc(error)}</p>` : ''}
  </div>`;
}

export function csrf(token) {
  return `<input type="hidden" name="_csrf" value="${esc(token)}" />`;
}

export function empty(message) {
  return `<p class="empty mono">${esc(message)}</p>`;
}
