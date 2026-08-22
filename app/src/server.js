/**
 * Weston Warriors member platform.
 *
 * Serves the static marketing site from the repository root and the member
 * dashboard from the routes below, so the whole thing is one origin and the
 * session cookie works across both.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';

import { config } from './config.js';
import { pool, one } from './db.js';
import { attachSession } from './auth.js';
import { authRouter } from './routes/auth.js';
import { dashboardRouter } from './routes/dashboard.js';
import { accountRouter } from './routes/account.js';
import { privacyRouter } from './routes/privacy.js';
import { masterRouter } from './routes/master.js';
import { runErasureSweep } from './erasure.js';
import { page, esc } from './views/layout.js';
import { masterSigninPage } from './views/master-layout.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', config.staticRoot);

export const app = express();

// Behind a proxy in production, so req.ip reflects the client rather than the
// load balancer.
app.set('trust proxy', config.isProd ? 1 : false);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (config.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser());
app.use(attachSession);

/* ------------------------------------------------------------ endpoints -- */

app.get('/healthz', async (req, res) => {
  try {
    await one('SELECT 1 AS ok');
    res.json({ ok: true, service: 'weston-warriors', env: config.env });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'database unavailable' });
  }
});

/**
 * Lets the static marketing header show the right thing in its menu without
 * shipping any of the member's data to a page that does not need it.
 */
app.get('/api/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.session) return res.json({ signedIn: false });
  res.json({
    signedIn: true,
    firstName: req.session.first_name || null,
    avatar: `/assets/avatars/${req.session.avatar_key || 'green-calm'}.svg`,
    csrfToken: req.session.csrf_token,
  });
});

/**
 * Scheduled erasure sweep.
 *
 * On a long running server the interval at the bottom of this file does the
 * work. On serverless there is no process to hold a timer, so a platform cron
 * calls this instead. Vercel signs its cron requests with CRON_SECRET.
 */
app.get('/internal/erasure-sweep', async (req, res) => {
  const supplied = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!config.cronSecret || supplied !== config.cronSecret) {
    return res.status(404).json({ error: 'not found' });
  }
  try {
    const erased = await runErasureSweep();
    res.json({ ok: true, erased: erased.length });
  } catch (err) {
    console.error('[erasure] sweep failed', err);
    res.status(500).json({ ok: false });
  }
});

app.use(masterRouter);
app.use(authRouter);
app.use(dashboardRouter);
app.use(accountRouter);
app.use(privacyRouter);

/* --------------------------------------------------------------- static -- */

// The marketing site. `index.html` at / and the assets it references.
app.use(express.static(repoRoot, {
  index: 'index.html',
  extensions: ['html'],
  maxAge: config.isProd ? '1h' : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', config.isProd ? 'public, max-age=3600' : 'no-cache');
    }
  },
}));

/* ------------------------------------------------------------- failures -- */

app.use((req, res) => {
  res.status(404).send(page({
    title: 'Not found',
    member: req.session,
    body: `
    <div class="gate">
      <p class="gate__eyebrow mono">404</p>
      <h1 class="gate__title">Nothing Here</h1>
      <p class="gate__lede">That page does not exist, or it is not yours to see.</p>
      <a class="btn btn--solid" href="${req.session ? '/dashboard' : '/'}">
        ${req.session ? 'Back to your dashboard' : 'Back to the site'}
      </a>
    </div>`,
  }));
});

app.use((err, req, res, next) => {  // eslint-disable-line no-unused-vars
  const status = res.statusCode >= 400 ? res.statusCode : 500;
  if (status >= 500) console.error('[error]', err);

  // Staff pages get the staff shell, and never leak a member's name into it.
  if (req.path.startsWith('/master')) {
    return res.status(status).send(masterSigninPage({
      error: status >= 500
        ? 'Something failed at our end. It has been logged.'
        : (err.message || 'That request could not be completed.'),
    }));
  }

  res.status(status).send(page({
    title: 'Something went wrong',
    member: req.session,
    body: `
    <div class="gate">
      <p class="gate__eyebrow mono">${status}</p>
      <h1 class="gate__title">${status >= 500 ? 'Our Mistake' : 'Cannot Do That'}</h1>
      <p class="gate__lede">
        ${status >= 500
          ? 'Something failed at our end. It has been logged and nothing you did caused it.'
          : esc(err.message || 'That request could not be completed.')}
      </p>
      <a class="btn btn--solid" href="${req.session ? '/dashboard' : '/'}">Go back</a>
    </div>`,
  }));
});

/* ---------------------------------------------------------------- boot ---- */

// Only when run directly. Imported by api/index.js on serverless, where there
// is no process to hold a listener or an interval.
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const server = app.listen(config.port, () => {
    console.log(`[ww] listening on http://localhost:${config.port} (${config.env})`);
  });

  // Carry out due erasures hourly. A single process is fine at this size; at
  // scale this belongs in a scheduled job rather than the web dyno.
  const sweep = setInterval(() => {
    runErasureSweep().catch((err) => console.error('[erasure] sweep failed', err));
  }, 60 * 60 * 1000);
  runErasureSweep().catch(() => {});

  const shutdown = async (signal) => {
    console.log(`[ww] ${signal}, shutting down`);
    clearInterval(sweep);
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
