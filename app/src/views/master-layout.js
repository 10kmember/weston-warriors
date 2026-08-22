/**
 * The staff shell.
 *
 * Visually related to the member dashboard but never mistakable for it: a
 * bronze rule across the top, a STAFF marker beside the logo, and its own
 * navigation. Somebody glancing at a screen should know instantly whether they
 * are looking at their own account or at everybody's.
 */

import { esc, shortDate } from './layout.js';

const NAV = [
  ['/master', 'Overview', 'M3 12h7V3H3v9Zm0 9h7v-7H3v7Zm11 0h7V12h-7v9Zm0-18v7h7V3h-7Z'],
  ['/master/members', 'Participants', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a5 5 0 0 0-4-4.9'],
  ['/master/reconciliation', 'Reconciliation', 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h4'],
];

export function masterPage({ title, body, staff, active = '', flash = null }) {
  const nav = NAV.map(([href, label, d]) => `
    <a class="side__link${href === active ? ' is-active' : ''}" href="${href}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>
      <span>${esc(label)}</span>
    </a>`).join('');

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} · Master · Weston Warriors</title>
<meta name="robots" content="noindex, nofollow" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Amatic+SC:wght@400;700&family=Nunito:ital,wght@0,300;0,400;0,600;0,700;0,800;1,400&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/assets/css/main.css" />
<link rel="stylesheet" href="/assets/css/dashboard.css" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%230A0A0A'/%3E%3Cg fill='none' stroke='%238C5A2B' stroke-width='2.2' stroke-linejoin='round' stroke-linecap='round'%3E%3Cpath d='M3 9l3 14 3-9 3 9 3-14'/%3E%3Cpath d='M17 9l3 14 3-9 3 9 3-14'/%3E%3C/g%3E%3C/svg%3E" />
</head>
<body class="app app--staff">
<a class="skip-link" href="#main">Skip to content</a>
<div class="staffbar" aria-hidden="true"></div>

<header class="topbar">
  <a class="topbar__brand" href="/master">
    <svg viewBox="0 0 44 24" width="38" height="21" aria-hidden="true">
      <path d="M2 3l4.5 18 4.5-12 4.5 12 4.5-18" />
      <path d="M24 3l4.5 18 4.5-12 4.5 12 4.5-18" />
    </svg>
    <span>Weston<br />Warriors</span>
  </a>

  <div class="topbar__right">
    <span class="staffpill mono">MASTER <s>·</s> STAFF</span>
    <div class="who">
      <span class="who__name mono">${esc(staff.name || staff.email)} <s>·</s> ${esc(staff.role).toUpperCase()}</span>
    </div>
  </div>
</header>

<button class="side__toggle mono" id="side-toggle" type="button" aria-expanded="false" aria-controls="side">MENU</button>

<div class="shell">
  <nav class="side" id="side" aria-label="Master dashboard">
    ${nav}
    <form class="side__out" method="post" action="/master/signout">
      <input type="hidden" name="_csrf" value="${esc(staff.csrf_token)}" />
      <button class="side__link side__link--out" type="submit">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/></svg>
        <span>Sign out</span>
      </button>
    </form>
  </nav>

  <main class="main main--wide" id="main">
    ${flash ? `<div class="banner banner--${esc(flash.kind)}">${esc(flash.message)}</div>` : ''}
    ${body}
  </main>
</div>

<script>
  (function () {
    var t = document.getElementById('side-toggle');
    var s = document.getElementById('side');
    if (!t || !s) return;
    t.addEventListener('click', function () {
      var open = s.classList.toggle('is-open');
      t.setAttribute('aria-expanded', String(open));
    });
  })();
</script>
</body>
</html>`;
}

/** The staff sign in page: a different page from the member one, on purpose. */
export function masterSigninPage({ email = '', error = '', next = '' }) {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Staff sign in · Weston Warriors</title>
<meta name="robots" content="noindex, nofollow" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Amatic+SC:wght@400;700&family=Nunito:ital,wght@0,300;0,400;0,600;0,700;0,800;1,400&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/assets/css/main.css" />
<link rel="stylesheet" href="/assets/css/dashboard.css" />
</head>
<body class="app app--bare app--staff">
<div class="staffbar" aria-hidden="true"></div>
<div class="gate gate--staff">
  <p class="gate__eyebrow mono">STAFF ONLY <s>//</s> MASTER DASHBOARD</p>
  <h1 class="gate__title">Staff Sign In</h1>
  <p class="gate__lede">
    This is the coaches' door. Members sign in at
    <a href="/signin">the member entrance</a> instead.
  </p>

  ${error ? `<div class="banner banner--bad">${esc(error)}</div>` : ''}

  <form method="post" action="/master/signin" class="gate__form" novalidate>
    <input type="hidden" name="next" value="${esc(next)}" />
    <div class="f">
      <label class="f__label mono" for="f-email">STAFF EMAIL</label>
      <input class="f__input" id="f-email" name="email" type="email"
             value="${esc(email)}" required autocomplete="username" />
    </div>
    <div class="f">
      <label class="f__label mono" for="f-password">PASSWORD</label>
      <input class="f__input" id="f-password" name="password" type="password"
             required autocomplete="current-password" />
    </div>
    <button class="btn btn--solid btn--full" type="submit">Sign In</button>
  </form>

  <p class="gate__alt mono">
    LOST YOUR PASSWORD? ASK AN ADMIN TO RESET IT ON THE FLOOR.
  </p>
</div>
</body>
</html>`;
}
