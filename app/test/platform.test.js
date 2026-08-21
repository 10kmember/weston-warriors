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

test.after(async () => { await pool.end(); });
