/**
 * Staff authentication.
 *
 * Deliberately a parallel system to the member one rather than a role check on
 * top of it: separate table, separate sessions, separate cookie, separate sign
 * in page. A member's cookie is not a weaker staff cookie, it is a different
 * kind of thing, and no amount of tampering with a member row produces staff
 * access.
 *
 * The mechanics (scrypt, HMAC'd tokens, CSRF bound to the session) are the same
 * as members because they were right there too.
 */

import crypto from 'node:crypto';
import { config } from './config.js';
import { query, one } from './db.js';
import { hashPassword, verifyPassword, newToken, burnPasswordTime } from './auth.js';

export const STAFF_COOKIE = 'ww_staff';
const TTL_DAYS = 7;             // shorter than a member's 30: this is the till

export { hashPassword as hashStaffPassword };

function hashToken(raw) {
  // A distinct pepper, so a member token can never hash to a staff token even
  // if the raw values somehow collided.
  return crypto.createHmac('sha256', `${config.sessionSecret}:staff`).update(raw).digest('hex');
}

export async function createStaffSession(staffId, { ip, userAgent }) {
  const raw = newToken();
  const csrf = newToken(24);
  const expiresAt = new Date(Date.now() + TTL_DAYS * 86400_000);

  await query(
    `INSERT INTO staff_sessions (staff_id, token_hash, csrf_token, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [staffId, hashToken(raw), csrf, ip || null, userAgent || '', expiresAt]
  );
  return { raw, csrf, expiresAt };
}

export async function loadStaffSession(raw) {
  if (!raw) return null;
  return one(
    `SELECT s.id, s.staff_id, s.csrf_token,
            u.email, u.name, u.role, u.status
       FROM staff_sessions s
       JOIN staff_users u ON u.id = s.staff_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.status = 'active'`,
    [hashToken(raw)]
  );
}

export async function revokeStaffSession(id) {
  await query('UPDATE staff_sessions SET revoked_at = now() WHERE id = $1', [id]);
}

export function setStaffCookie(res, raw, expiresAt) {
  res.cookie(STAFF_COOKIE, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    // Scoped to /master: the browser will not send it to member pages at all.
    path: '/master',
    expires: expiresAt,
  });
}

export function clearStaffCookie(res) {
  res.clearCookie(STAFF_COOKIE, { path: '/master' });
}

/* ------------------------------------------------------------ middleware -- */

export async function attachStaff(req, res, next) {
  try {
    const raw = req.cookies?.[STAFF_COOKIE];
    const session = await loadStaffSession(raw);
    if (session) {
      req.staff = session;
      query('UPDATE staff_sessions SET last_seen_at = now() WHERE id = $1', [session.id]).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireStaff(req, res, next) {
  if (!req.staff) {
    const target = encodeURIComponent(req.originalUrl);
    return res.redirect(`/master/signin?next=${target}`);
  }
  next();
}

export function requireStaffGuest(req, res, next) {
  if (req.staff) return res.redirect('/master');
  next();
}

export function requireStaffCsrf(req, res, next) {
  const supplied = req.body?._csrf || req.get('x-csrf-token');
  const expected = req.staff?.csrf_token;
  if (!expected || !supplied || supplied.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    res.status(403);
    return next(new Error('Your staff session expired or the form was stale. Sign in again.'));
  }
  next();
}

/** Admin-only actions, such as reversing a payment somebody else recorded. */
export function requireAdmin(req, res, next) {
  if (req.staff?.role !== 'admin') {
    res.status(403);
    return next(new Error('That action needs an admin account.'));
  }
  next();
}

/* -------------------------------------------------------------- attempts -- */

const attempts = new Map();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 6;         // tighter than the member door

export function throttleStaffLogin(req, res, next) {
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

export function recordStaffFailure(req) {
  const entry = attempts.get(req.ip || 'unknown');
  if (entry) entry.count += 1;
}

export function clearStaffAttempts(req) {
  attempts.delete(req.ip || 'unknown');
}

/* ----------------------------------------------------------------- audit -- */

export async function staffAudit(req, { action, memberId = null, entity = '', entityId = '', metadata = {} }) {
  try {
    await query(
      `INSERT INTO audit_log (member_id, staff_id, actor, action, entity, entity_id, metadata, ip, user_agent)
       VALUES ($1, $2, 'staff', $3, $4, $5, $6, $7, $8)`,
      [memberId, req.staff?.staff_id || null, action, entity, String(entityId || ''),
       metadata, req.ip || null, req.get('user-agent') || '']
    );
  } catch (err) {
    console.error('[audit] staff action not recorded', action, err.message);
  }
}

export { verifyPassword as verifyStaffPassword, burnPasswordTime };
