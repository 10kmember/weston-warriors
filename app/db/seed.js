/**
 * Seed data: deliberately small.
 *
 * Two members, two invoices each, a handful of classes. Enough to see every
 * screen populated and to exercise the two states that matter (paid up, and in
 * arrears with a declined card) without burying you in rows you have to scroll
 * past to find the one you care about.
 *
 * Re-running truncates and rebuilds. It is deterministic.
 */

import { pool, query } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const DAY = 86400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const daysAhead = (n) => new Date(Date.now() + n * DAY);

/** The one password for every seeded account. Development only. */
const TEST_PASSWORD = 'WarriorsTest2026';

const PLANS = [
  {
    code: 'initiate', name: 'Initiate', price: 6500, sort: 1, capacity: 60,
    description: 'Open floor access and group technique sessions.',
    features: ['Open floor access during standard hours', 'Two group technique sessions weekly', 'Wraps and bag equipment provided'],
  },
  {
    code: 'contender', name: 'Contender', price: 12000, sort: 2, capacity: 95,
    description: 'Full access with supervised sparring.',
    features: ['Unrestricted access to every session', 'Supervised sparring, three nights weekly', 'Monthly load review and video analysis', 'Priority ring booking'],
  },
  {
    code: 'warrior', name: 'Warrior', price: 34000, sort: 3, capacity: 25,
    description: 'Competition support with a named corner team.',
    features: ['Everything in Contender', 'Named head coach and corner team', 'Competition licensing and matchmaking', 'Recovery and physiotherapy allocation'],
  },
];

const MEMBERS = [
  {
    email: 'demo@westonwarriors.example',
    first: 'Demo', last: 'Member',
    avatar: 'green-calm',
    plan: 'contender', status: 'active',
    phone: '07700 900123', dob: '1998-04-16',
    address: '17 St Georges Sq', city: 'Worle', postcode: 'BS22 6BX',
    kin: 'Sam Member', kinPhone: '07700 900456',
    medical: 'Old left shoulder dislocation, 2023.',
    consents: { marketing_email: true, marketing_sms: false, photography: true, health_data: true, third_party_sharing: false },
    // both invoices settled
    invoices: [
      { monthsAgo: 1, status: 'paid' },
      { monthsAgo: 0, status: 'paid' },
    ],
  },
  {
    email: 'overdue@westonwarriors.example',
    first: 'Ada', last: 'Overdue',
    avatar: 'red-fired-up',
    plan: 'initiate', status: 'past_due',
    phone: '07700 900987', dob: '1991-11-02',
    address: '4 Coker Rd', city: 'Weston-super-Mare', postcode: 'BS23 1AA',
    kin: 'Joan Overdue', kinPhone: '07700 900654',
    medical: '',
    consents: { marketing_email: false, marketing_sms: false, photography: false, health_data: false, third_party_sharing: false },
    // last month paid, this month failed and still open
    invoices: [
      { monthsAgo: 1, status: 'paid' },
      { monthsAgo: 0, status: 'open', failed: true },
    ],
  },
];

const CLASSES = [
  ['Fundamentals', 'Simon Flett', 'beginner', 18, 18, 0, 90],
  ['Technical Sparring', 'Dean Lewis', 'intermediate', 12, 19, 0, 90],
  ['Conditioning', 'Simon Flett', 'all', 24, 6, 30, 60],
  ['Pads and Combinations', 'Dean Lewis', 'all', 16, 18, 30, 60],
  ['Competition Squad', 'Dean Lewis', 'advanced', 10, 20, 0, 120],
  ['Saturday Open Floor', 'Simon Flett', 'all', 30, 10, 0, 120],
];

async function seed() {
  console.log('[seed] clearing');
  await query(`TRUNCATE bookings, class_sessions, audit_log, data_requests, consents,
                        payments, payment_methods, invoice_lines, invoices,
                        subscriptions, sessions, members, plans RESTART IDENTITY CASCADE`);

  /* plans */
  const planIds = {};
  for (const p of PLANS) {
    const [row] = await query(
      `INSERT INTO plans (code, name, description, price_pence, features, capacity, sort_order)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id`,
      [p.code, p.name, p.description, p.price, JSON.stringify(p.features), p.capacity, p.sort]
    );
    planIds[p.code] = row.id;
  }

  /* classes: three behind us, three ahead */
  const classIds = [];
  for (let i = 0; i < CLASSES.length; i++) {
    const [title, coach, level, capacity, hour, minute, mins] = CLASSES[i];
    const offset = i < 3 ? -(3 - i) * 2 : (i - 2) * 2;   // -6,-4,-2,+2,+4,+6 days
    const starts = new Date(Date.now() + offset * DAY);
    starts.setHours(hour, minute, 0, 0);
    const [row] = await query(
      `INSERT INTO class_sessions (title, coach, level, location, starts_at, ends_at, capacity)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, starts_at`,
      [title, coach, level, i % 2 ? 'Ring one' : 'Main floor',
       starts, new Date(starts.getTime() + mins * 60_000), capacity]
    );
    classIds.push({ ...row, past: offset < 0 });
  }

  /* members */
  const passwordHash = hashPassword(TEST_PASSWORD);
  let invoiceSeq = 1;

  for (const m of MEMBERS) {
    const joined = 120;

    const [member] = await query(
      `INSERT INTO members (email, password_hash, first_name, last_name, phone, date_of_birth,
                            address_line1, city, postcode, emergency_contact_name,
                            emergency_contact_phone, medical_notes, avatar_key,
                            email_verified_at, last_login_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [m.email, passwordHash, m.first, m.last, m.phone, m.dob,
       m.address, m.city, m.postcode, m.kin, m.kinPhone, m.medical, m.avatar,
       daysAgo(joined), daysAgo(2), daysAgo(joined)]
    );

    /* consent ledger, recorded at signup */
    for (const [purpose, granted] of Object.entries(m.consents)) {
      await query(
        `INSERT INTO consents (member_id, purpose, granted, policy_version, source, created_at)
         VALUES ($1,$2,$3,'1.0','signup',$4)`,
        [member.id, purpose, granted, daysAgo(joined)]
      );
    }

    /* subscription */
    const periodStart = daysAgo(8);
    const [sub] = await query(
      `INSERT INTO subscriptions (member_id, plan_id, status, started_at,
                                  current_period_start, current_period_end, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$4) RETURNING id`,
      [member.id, planIds[m.plan], m.status, daysAgo(joined),
       periodStart, new Date(periodStart.getTime() + 30 * DAY)]
    );

    /* payment method */
    const [method] = await query(
      `INSERT INTO payment_methods (member_id, type, brand, last4, exp_month, exp_year,
                                    provider_token, is_default, created_at)
       VALUES ($1,'card',$2,$3,$4,$5,$6,true,$7) RETURNING id`,
      [member.id, m.plan === 'contender' ? 'Visa' : 'Mastercard',
       m.plan === 'contender' ? '4242' : '5100', 9, 2029,
       `tok_${m.first.toLowerCase()}_seed`, daysAgo(joined)]
    );

    /* two invoices */
    const price = PLANS.find((p) => p.code === m.plan).price;
    for (const inv of m.invoices) {
      const issued = daysAgo(inv.monthsAgo * 30 + 8);
      const [invoice] = await query(
        `INSERT INTO invoices (member_id, subscription_id, number, status, subtotal_pence,
                               tax_pence, total_pence, period_start, period_end,
                               issued_at, due_at, paid_at, created_at)
         VALUES ($1,$2,$3,$4,$5,0,$5,$6,$7,$8,$9,$10,$8) RETURNING id`,
        [member.id, sub.id, `WW-2026-${String(invoiceSeq++).padStart(4, '0')}`,
         inv.status, price,
         issued, new Date(issued.getTime() + 30 * DAY),
         issued, new Date(issued.getTime() + 14 * DAY),
         inv.status === 'paid' ? new Date(issued.getTime() + 2 * DAY) : null]
      );

      await query(
        `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price_pence, amount_pence)
         VALUES ($1,$2,1,$3,$3)`,
        [invoice.id, `${PLANS.find((p) => p.code === m.plan).name} membership, monthly`, price]
      );

      if (inv.status === 'paid') {
        await query(
          `INSERT INTO payments (invoice_id, member_id, payment_method_id, amount_pence,
                                 status, method, reference, processed_at)
           VALUES ($1,$2,$3,$4,'succeeded','card',$5,$6)`,
          [invoice.id, member.id, method.id, price,
           `pay_${invoice.id.slice(0, 8)}`, new Date(issued.getTime() + 2 * DAY)]
        );
      } else if (inv.failed) {
        await query(
          `INSERT INTO payments (invoice_id, member_id, payment_method_id, amount_pence,
                                 status, method, reference, failure_reason, processed_at)
           VALUES ($1,$2,$3,$4,'failed','card',$5,'Card declined by issuer',$6)`,
          [invoice.id, member.id, method.id, price,
           `pay_${invoice.id.slice(0, 8)}`, new Date(issued.getTime() + 2 * DAY)]
        );
      }
    }

    /* one attended class behind, one booked ahead */
    const attended = classIds.find((c) => c.past);
    const upcoming = classIds.find((c) => !c.past);
    for (const [cls, status] of [[attended, 'attended'], [upcoming, 'booked']]) {
      await query(
        `INSERT INTO bookings (class_session_id, member_id, status, booked_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [cls.id, member.id, status, daysAgo(9)]
      );
    }

    /* a little account activity so the log is not empty */
    for (const [action, ago] of [['auth.signin', 9], ['profile.updated', 6], ['auth.signin', 2]]) {
      await query(
        `INSERT INTO audit_log (member_id, actor, action, created_at, ip)
         VALUES ($1,'member',$2,$3,'81.2.69.144')`,
        [member.id, action, daysAgo(ago)]
      );
    }
  }

  const [counts] = await query(`
    SELECT (SELECT count(*) FROM members)::int AS members,
           (SELECT count(*) FROM invoices)::int AS invoices,
           (SELECT count(*) FROM payments)::int AS payments,
           (SELECT count(*) FROM class_sessions)::int AS classes,
           (SELECT count(*) FROM bookings)::int AS bookings`);

  console.log('[seed] done:', counts);
  console.log('');
  console.log('  Sign in at /signin with:');
  console.log('');
  for (const m of MEMBERS) {
    console.log(`    email:    ${m.email}`);
    console.log(`    password: ${TEST_PASSWORD}`);
    console.log(`              ${m.plan} membership, ${m.status.replace('_', ' ')}`);
    console.log('');
  }
}

seed()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[seed] failed:', err);
    await pool.end();
    process.exit(1);
  });
