/**
 * Small hand-rolled validation. A schema library would be more powerful, but
 * the surface here is a handful of forms and the rules are worth reading in
 * full rather than inferring from a chain of combinators.
 */

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// UK postcode, loosely: enough to catch typos, not so strict it rejects a
// valid-but-unusual one.
export const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

export function str(value, max = 255) {
  return String(value ?? '').trim().slice(0, max);
}

export function isEmail(value) {
  const v = str(value, 320);
  return EMAIL_RE.test(v) && v.length <= 320;
}

/**
 * Password policy: length does more for entropy than character classes, so we
 * ask for 10 characters and reject the handful of things people actually type.
 */
const COMMON = new Set([
  'password', 'password1', 'passw0rd', '1234567890', 'qwertyuiop',
  'letmein123', 'iloveyou1', 'welcome123', 'admin12345', 'boxing123',
]);

export function passwordProblem(password) {
  const value = String(password ?? '');
  if (value.length < 10) return 'Password must be at least 10 characters.';
  if (value.length > 200) return 'Password must be under 200 characters.';
  if (COMMON.has(value.toLowerCase())) return 'That password is too common. Pick something else.';
  if (/^(.)\1+$/.test(value)) return 'That password is a single repeated character.';
  return null;
}

export function isDate(value) {
  if (!value) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

export function ageFrom(dateOfBirth) {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
}

/** Collects field errors so a form can be re-rendered with everything at once. */
export class Errors {
  constructor() { this.fields = {}; }
  add(field, message) {
    if (!this.fields[field]) this.fields[field] = message;
    return this;
  }
  get any() { return Object.keys(this.fields).length > 0; }
  get first() { return Object.values(this.fields)[0] || null; }
}
