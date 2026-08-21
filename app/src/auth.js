/**
 * Passwords, sessions, CSRF.
 *
 * Passwords use scrypt from node:crypto rather than bcrypt or argon2. scrypt is
 * memory-hard, it is in the standard library, and it needs no native build step,
 * which keeps `npm install` from being the most fragile part of a deployment.
 *
 * Session tokens are 32 random bytes. The raw token goes in an httpOnly cookie
 * and only a SHA-256 of it (peppered with SESSION_SECRET) is stored, so a
 * database leak does not hand over live sessions.
 */

import crypto from 'node:crypto';
import { config } from './config.js';
import { query, one } from './db.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ------------------------------------------------------------- passwords -- */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
      maxmem: 256 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * Constant-ish work even when the account does not exist, so timing does not
 * reveal which emails are registered.
 */
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
export function burnPasswordTime(password) {
  verifyPassword(password, DUMMY_HASH);
}

/* -------------------------------------------------------------- sessions -- */

export function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(raw) {
  return crypto.createHmac('sha256', config.sessionSecret).update(raw).digest('hex');
}

export async function createSession(memberId, { ip, userAgent }) {
  const raw = newToken();
  const csrf = newToken(24);
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 86400_000);

  await query(
    `INSERT INTO sessions (member_id, token_hash, csrf_token, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [memberId, hashToken(raw), csrf, ip || null, userAgent || '', expiresAt]
  );

  return { raw, csrf, expiresAt };
}

export async function loadSession(raw) {
  if (!raw) return null;
  return one(
    `SELECT s.id, s.member_id, s.csrf_token, s.expires_at,
            m.email, m.first_name, m.last_name, m.status, m.role,
            m.erasure_requested_at, m.erasure_due_at
       FROM sessions s
       JOIN members m ON m.id = s.member_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND m.status <> 'erased'`,
    [hashToken(raw)]
  );
}

export async function touchSession(sessionId) {
  await query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [sessionId]);
}

export async function revokeSession(sessionId) {
  await query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export async function revokeAllSessions(memberId, exceptSessionId = null) {
  await query(
    `UPDATE sessions SET revoked_at = now()
      WHERE member_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`,
    [memberId, exceptSessionId]
  );
}

export function setSessionCookie(res, raw, expiresAt) {
  res.cookie(config.sessionCookie, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(config.sessionCookie, { path: '/' });
}

/* ------------------------------------------------------------ middleware -- */

/** Attaches req.session and req.member when a valid cookie is present. */
export async function attachSession(req, res, next) {
  try {
    const raw = req.cookies?.[config.sessionCookie];
    const session = await loadSession(raw);
    if (session) {
      req.session = session;
      req.member = session;
      res.locals.member = session;
      touchSession(session.id).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req, res, next) {
  if (!req.session) {
    const target = encodeURIComponent(req.originalUrl);
    return res.redirect(`/signin?next=${target}`);
  }
  next();
}

export function requireGuest(req, res, next) {
  if (req.session) return res.redirect('/dashboard');
  next();
}

/* ------------------------------------------------------------------ CSRF -- */

/**
 * Double-submit against the session's own token. Any state-changing request
 * must present the token that was issued with the session.
 */
export function requireCsrf(req, res, next) {
  const supplied = req.body?._csrf || req.get('x-csrf-token');
  const expected = req.session?.csrf_token;
  if (!expected || !supplied || supplied.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    res.status(403);
    return next(new Error('Your session expired or the form was stale. Please try again.'));
  }
  next();
}

/* ------------------------------------------------------- login throttling -- */

const attempts = new Map();   // ip -> { count, resetAt }
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

export function throttleLogin(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const entry = attempts.get(key);

  if (entry && entry.resetAt > now && entry.count >= MAX_ATTEMPTS) {
    res.status(429);
    return next(new Error('Too many sign in attempts. Try again in a few minutes.'));
  }
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 0, resetAt: now + WINDOW_MS });
  }
  next();
}

export function recordFailedLogin(req) {
  const key = req.ip || 'unknown';
  const entry = attempts.get(key);
  if (entry) entry.count += 1;
}

export function clearLoginAttempts(req) {
  attempts.delete(req.ip || 'unknown');
}

/* --------------------------------------------------------------- audit ---- */

export async function audit(req, { memberId, action, entity = '', entityId = '', metadata = {}, actor = 'member' }) {
  try {
    await query(
      `INSERT INTO audit_log (member_id, actor, action, entity, entity_id, metadata, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [memberId || null, actor, action, entity, String(entityId || ''), metadata,
       req?.ip || null, req?.get?.('user-agent') || '']
    );
  } catch (err) {
    // An audit write must never take down the request it is describing.
    console.error('[audit] failed to record', action, err.message);
  }
}
