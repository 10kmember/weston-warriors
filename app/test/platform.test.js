/**
 * Unit tests for the parts where being wrong is expensive: password hashing,
 * validation, HTML escaping, money formatting and the erasure sweep.
 *
 * Run with `npm test`. The erasure tests need the database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword, verifyPassword } from '../src/auth.js';
import { passwordProblem, isEmail, ageFrom, POSTCODE_RE } from '../src/validate.js';
import { esc, money } from '../src/views/layout.js';
import { query, one, pool } from '../src/db.js';
import { eraseMember, runErasureSweep } from '../src/erasure.js';

/* ------------------------------------------------------------- passwords -- */

test('password hashing round trips', () => {
  const hash = hashPassword('a-long-enough-passphrase');
  assert.ok(verifyPassword('a-long-enough-passphrase', hash));
  assert.ok(!verifyPassword('a-long-enough-passphras', hash));
  assert.ok(!verifyPassword('', hash));
});

test('the same password hashes differently each time', () => {
  assert.notEqual(hashPassword('same-password-here'), hashPassword('same-password-here'));
});

test('verify does not throw on a malformed stored hash', () => {
  for (const bad of ['', 'nonsense', 'scrypt$broken', null, undefined]) {
    assert.equal(verifyPassword('whatever', bad), false);
  }
});

/* ------------------------------------------------------------ validation -- */

test('password policy', () => {
  assert.ok(passwordProblem('short'));            // too short
  assert.ok(passwordProblem('password1'));        // too common
  assert.ok(passwordProblem('aaaaaaaaaaaa'));     // one repeated character
  assert.equal(passwordProblem('a-long-enough-passphrase'), null);
});

test('email validation', () => {
  assert.ok(isEmail('member@example.com'));
  assert.ok(!isEmail('member@example'));
  assert.ok(!isEmail('not an email'));
  assert.ok(!isEmail(''));
});

test('age calculation', () => {
  const twenty = new Date();
  twenty.setFullYear(twenty.getFullYear() - 20);
  assert.equal(ageFrom(twenty.toISOString().slice(0, 10)), 20);
  assert.equal(ageFrom(''), null);
});

test('uk postcodes', () => {
  for (const good of ['BS22 6BX', 'bs226bx', 'W1A 1AA', 'M1 1AE']) {
    assert.ok(POSTCODE_RE.test(good), good);
  }
  for (const bad of ['NOT A POSTCODE', '12345', 'BS']) {
    assert.ok(!POSTCODE_RE.test(bad), bad);
  }
});

/* --------------------------------------------------------------- output -- */

test('escaping closes every injection route in an attribute or body', () => {
  assert.equal(esc('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc('" onload="evil()'), '&quot; onload=&quot;evil()');
  assert.equal(esc("' onload='evil()"), '&#39; onload=&#39;evil()');
  assert.equal(esc(null), '');
});

test('money formats pence as pounds with separators', () => {
  assert.equal(money(0), '£0.00');
  assert.equal(money(6500), '£65.00');
  assert.equal(money(123456789), '£1,234,567.89');
});

/* -------------------------------------------------------------- erasure -- */

test('erasure clears personal data but keeps the financial trail', async (t) => {
  const email = `erasure-test-${Date.now()}@example.com`;

  const member = await one(
    `INSERT INTO members (email, password_hash, first_name, last_name, phone,
                          address_line1, city, postcode, emergency_contact_name,
                          medical_notes)
     VALUES ($1, 'x', 'Test', 'Subject', '07000 000000', '1 Test St', 'Worle',
             'BS22 6BX', 'Someone', 'Asthma') RETURNING id`,
    [email]
  );

  const invoice = await one(
    `INSERT INTO invoices (member_id, number, status, subtotal_pence, total_pence)
     VALUES ($1, $2, 'paid', 6500, 6500) RETURNING id`,
    [member.id, `TEST-${Date.now()}`]
  );

  await eraseMember(member.id);

  const after = await one('SELECT * FROM members WHERE id = $1', [member.id]);
  assert.equal(after.first_name, 'Erased');
  assert.equal(after.phone, '');
  assert.equal(after.medical_notes, '');
  assert.equal(after.address_line1, '');
  assert.equal(after.emergency_contact_name, '');
  assert.equal(after.status, 'erased');
  assert.notEqual(after.email, email, 'email must not survive erasure');
  assert.ok(after.erased_at);

  const keptInvoice = await one('SELECT * FROM invoices WHERE id = $1', [invoice.id]);
  assert.ok(keptInvoice, 'invoice must be retained for tax record keeping');
  assert.equal(keptInvoice.total_pence, 6500);

  const trail = await one(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE member_id = $1 AND action = 'data.erased'`,
    [member.id]
  );
  assert.equal(trail.n, 1, 'the erasure itself must be recorded');

  // cleanup
  await query('DELETE FROM invoices WHERE id = $1', [invoice.id]);
  await query('DELETE FROM members WHERE id = $1', [member.id]);
});

test('the sweep only takes members whose grace period has passed', async () => {
  const soon = await one(
    `INSERT INTO members (email, password_hash, first_name, erasure_requested_at, erasure_due_at)
     VALUES ($1, 'x', 'Future', now(), now() + interval '10 days') RETURNING id`,
    [`sweep-future-${Date.now()}@example.com`]
  );
  const due = await one(
    `INSERT INTO members (email, password_hash, first_name, erasure_requested_at, erasure_due_at)
     VALUES ($1, 'x', 'Due', now() - interval '31 days', now() - interval '1 day') RETURNING id`,
    [`sweep-due-${Date.now()}@example.com`]
  );

  const erased = await runErasureSweep();

  assert.ok(erased.includes(due.id), 'a member past their date must be erased');
  assert.ok(!erased.includes(soon.id), 'a member still in grace must be untouched');

  const stillThere = await one('SELECT first_name, status FROM members WHERE id = $1', [soon.id]);
  assert.equal(stillThere.first_name, 'Future');
  assert.equal(stillThere.status, 'active');

  await query('DELETE FROM members WHERE id = ANY($1)', [[soon.id, due.id]]);
});


/* -------------------------------------------------------------- avatars -- */

test('the avatar set is closed: only shipped keys are accepted', async () => {
  const { AVATARS, isAvatarKey, DEFAULT_AVATAR, avatarSrc } = await import('../src/avatars.js');

  assert.equal(AVATARS.length, 10);
  assert.ok(isAvatarKey(DEFAULT_AVATAR));
  for (const a of AVATARS) assert.ok(isAvatarKey(a.key), a.key);

  // anything a hand-edited form could send
  for (const bad of ['', null, undefined, '../../etc/passwd', 'green-calm.svg',
                     '<script>', 'http://evil/x.svg', 'GREEN-CALM']) {
    assert.equal(isAvatarKey(bad), false, String(bad));
  }

  // and the src for a bad key falls back rather than reflecting it
  assert.equal(avatarSrc('../../etc/passwd'), `/assets/avatars/${DEFAULT_AVATAR}.svg`);
});

test('every avatar in the manifest has a file on disk', async () => {
  const { AVATARS } = await import('../src/avatars.js');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  for (const a of AVATARS) {
    const file = path.resolve('..', 'assets', 'avatars', `${a.key}.svg`);
    const svg = await fs.readFile(file, 'utf8');
    assert.match(svg, /^<svg /, a.key);
    assert.ok(svg.includes('<circle'), `${a.key} should draw a face`);
  }
});

/* ---------------------------------------------------- master dashboard -- */

test('money parsing refuses anything that is not money', async () => {
  const { toPence } = await import('../src/routes/master.js');

  assert.equal(toPence('65'), 6500);
  assert.equal(toPence('65.00'), 6500);
  assert.equal(toPence('12.50'), 1250);
  assert.equal(toPence('£12.50'), 1250);
  assert.equal(toPence('1,250.00'), 125000);
  assert.equal(toPence(' 65.00 '), 6500);
  assert.equal(toPence('0.01'), 1);

  for (const bad of ['', 'abc', '12.345', '-5', '1e3', '12..5', null, undefined, '65p']) {
    assert.equal(toPence(bad), null, String(bad));
  }
});

test('admin and member sessions are separate systems', async () => {
  const { loadAdminSession, createAdminSession } = await import('../src/admin-auth.js');
  const { loadSession, createSession } = await import('../src/auth.js');

  const admin = await one(
    `INSERT INTO admins (email, password_hash, name)
     VALUES ($1, 'x', 'Test Admin') RETURNING id`,
    [`admin-test-${Date.now()}@example.com`]
  );
  const member = await one(
    `INSERT INTO members (email, password_hash, first_name)
     VALUES ($1, 'x', 'Test') RETURNING id`,
    [`member-test-${Date.now()}@example.com`]
  );

  const adminSession = await createAdminSession(admin.id, { ip: null, userAgent: '' });
  const memberSession = await createSession(member.id, { ip: null, userAgent: '' });

  // each token works only in its own system
  assert.ok(await loadAdminSession(adminSession.raw), 'admin token should open an admin session');
  assert.equal(await loadSession(adminSession.raw), null, 'an admin token must not be a member session');
  assert.ok(await loadSession(memberSession.raw), 'member token should open a member session');
  assert.equal(await loadAdminSession(memberSession.raw), null, 'a member token must not be an admin session');

  await query('DELETE FROM admins WHERE id = $1', [admin.id]);
  await query('DELETE FROM members WHERE id = $1', [member.id]);
});

/* -------------------------------------------------------------- pricing -- */

test('a plan code is safe to put in a url and unique-able', async () => {
  const { slug } = await import('../src/routes/master-pricing.js');

  assert.equal(slug('Juniors'), 'juniors');
  assert.equal(slug('Over 50s Fitness'), 'over-50s-fitness');
  assert.equal(slug('  Pay As You Go  '), 'pay-as-you-go');
  assert.equal(slug('Women\u2019s Only!'), 'women-s-only');
  assert.equal(slug('../../etc/passwd'), 'etc-passwd');
  assert.equal(slug('<script>'), 'script');
  assert.equal(slug('!!!'), '');
});

test('plan features come in as lines and go out as a bounded list', async () => {
  const { featureList } = await import('../src/routes/master-pricing.js');

  assert.deepEqual(featureList('One\nTwo\n\n  Three  '), ['One', 'Two', 'Three']);
  assert.deepEqual(featureList(''), []);
  assert.deepEqual(featureList(null), []);
  assert.equal(featureList(Array.from({ length: 40 }, (_, i) => `f${i}`).join('\n')).length, 12);
});

test('the plan rollup counts what members pay, not the list price', async () => {
  const stamp = Date.now();
  const plan = await one(
    `INSERT INTO plans (code, name, price_pence, billing_interval)
     VALUES ($1, 'Rollup Test', 10000, 'month') RETURNING id`,
    [`rollup-test-${stamp}`]
  );
  const member = await one(
    `INSERT INTO members (email, password_hash, first_name)
     VALUES ($1, 'x', 'Rollup') RETURNING id`,
    [`rollup-${stamp}@example.com`]
  );

  // signed up at a concession: half the list price
  await query(
    `INSERT INTO subscriptions (member_id, plan_id, price_pence, billing_interval,
                                status, current_period_start, current_period_end)
     VALUES ($1, $2, 5000, 'month', 'active', now(), now() + interval '1 month')`,
    [member.id, plan.id]
  );

  let row = await one('SELECT * FROM plan_rollup WHERE plan_id = $1', [plan.id]);
  assert.equal(row.list_price_pence, 10000, 'the plan still lists at £100');
  assert.equal(row.subscribers, 1);
  assert.equal(row.off_list_price, 1, 'and the member is flagged as off the list price');
  assert.equal(row.monthly_pence, 5000, 'but the month is worth what they actually pay');

  // a cancelled membership is worth nothing and is not a subscriber
  await query(`UPDATE subscriptions SET status = 'cancelled' WHERE plan_id = $1`, [plan.id]);
  row = await one('SELECT * FROM plan_rollup WHERE plan_id = $1', [plan.id]);
  assert.equal(row.subscribers, 0);
  assert.equal(row.monthly_pence, 0);

  // an annual membership is counted at a twelfth per month
  await query(
    `UPDATE subscriptions SET status = 'active', billing_interval = 'year', price_pence = 60000
      WHERE plan_id = $1`,
    [plan.id]
  );
  row = await one('SELECT * FROM plan_rollup WHERE plan_id = $1', [plan.id]);
  assert.equal(row.monthly_pence, 5000, '£600 a year is £50 a month');

  await query('DELETE FROM subscriptions WHERE plan_id = $1', [plan.id]);
  await query('DELETE FROM members WHERE id = $1', [member.id]);
  await query('DELETE FROM plans WHERE id = $1', [plan.id]);
});

// Closes the pool once every test above has run.
test.after(async () => { await pool.end(); });
