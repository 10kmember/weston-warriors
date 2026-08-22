/**
 * Admin authentication.
 *
 * Deliberately a parallel system to the member one rather than a role check on
 * top of it: separate table, separate sessions, separate cookie, separate sign
 * in page. A member's cookie is not a weaker admin cookie, it is a different
 * kind of thing, and no amount of tampering with a member row produces admin
 * access.
 *
 * The mechanics (scrypt, HMAC'd tokens, CSRF bound to the session) are the same
 * as members because they were right there too.
 */

import crypto from 'node:crypto';
import { config } from './config.js';
import { query, one } from './db.js';
import { hashPassword, verifyPassword, newToken, burnPasswordTime } from './auth.js';

export const ADMIN_COOKIE = 'ww_admin';
const TTL_DAYS = 7;             // shorter than a member's 30: this is the till

export { hashPassword as hashAdminPassword };

function hashToken(raw) {
  // A distinct pepper, so a member token can never hash to an admin token even
  // if the raw values somehow collided.
  return crypto.createHmac('sha256', `${config.sessionSecret}:admin`).update(raw).digest('hex');
}

export async function createAdminSession(adminId, { ip, userAgent }) {
  const raw = newToken();
  const csrf = newToken(24);
  const expiresAt = new Date(Date.now() + TTL_DAYS * 86400_000);

  await query(
    `INSERT INTO admin_sessions (admin_id, token_hash, csrf_token, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [adminId, hashToken(raw), csrf, ip || null, userAgent || '', expiresAt]
  );
  return { raw, csrf, expiresAt };
}

export async function loadAdminSession(raw) {
  if (!raw) return null;
  return one(
    `SELECT s.id, s.admin_id, s.csrf_token,
            u.email, u.name, u.status
       FROM admin_sessions s
       JOIN admins u ON u.id = s.admin_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.status = 'active'`,
    [hashToken(raw)]
  );
}

export async function revokeAdminSession(id) {
  await query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1', [id]);
}

export function setAdminCookie(res, raw, expiresAt) {
  res.cookie(ADMIN_COOKIE, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    // Scoped to /master: the browser will not send it to member pages at all.
    path: '/master',
    expires: expiresAt,
  });
}

export function clearAdminCookie(res) {
  res.clearCookie(ADMIN_COOKIE, { path: '/master' });
}

/* ------------------------------------------------------------ middleware -- */

export async function attachAdmin(req, res, next) {
  try {
    const raw = req.cookies?.[ADMIN_COOKIE];
    const session = await loadAdminSession(raw);
    if (session) {
      req.admin = session;
      query('UPDATE admin_sessions SET last_seen_at = now() WHERE id = $1', [session.id]).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req, res, next) {
  if (!req.admin) {
    const target = encodeURIComponent(req.originalUrl);
    return res.redirect(`/master/signin?next=${target}`);
  }
  next();
}

export function requireAdminGuest(req, res, next) {
  if (req.admin) return res.redirect('/master');
  next();
}

export function requireAdminCsrf(req, res, next) {
  const supplied = req.body?._csrf || req.get('x-csrf-token');
  const expected = req.admin?.csrf_token;
  if (!expected || !supplied || supplied.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    res.status(403);
    return next(new Error('Your admin session expired or the form was stale. Sign in again.'));
  }
  next();
}

/* -------------------------------------------------------------- attempts -- */

const attempts = new Map();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 6;         // tighter than the member door

export function throttleAdminLogin(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const entry = attempts.get(key);
  if (entry && entry.resetAt > now && entry.count >= MAX_ATTEMPTS) {
    res.status(429);
    return next(new Error('Too many attempts. Try again in a few minutes.'));
  }
  if (!entry || entry.resetAt <= now) attempts.set(key, { count: 0, resetAt: now + WINDOW_MS });
  next();
}

export function recordAdminFailure(req) {
  const entry = attempts.get(req.ip || 'unknown');
  if (entry) entry.count += 1;
}

export function clearAdminAttempts(req) {
  attempts.delete(req.ip || 'unknown');
}

/* ----------------------------------------------------------------- audit -- */

export async function adminAudit(req, { action, memberId = null, entity = '', entityId = '', metadata = {} }) {
  try {
    await query(
      `INSERT INTO audit_log (member_id, admin_id, actor, action, entity, entity_id, metadata, ip, user_agent)
       VALUES ($1, $2, 'admin', $3, $4, $5, $6, $7, $8)`,
      [memberId, req.admin?.admin_id || null, action, entity, String(entityId || ''),
       metadata, req.ip || null, req.get('user-agent') || '']
    );
  } catch (err) {
    console.error('[audit] admin action not recorded', action, err.message);
  }
}

export { verifyPassword as verifyAdminPassword, burnPasswordTime };
