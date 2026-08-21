/**
 * Seed data.
 *
 * Deterministic: a fixed PRNG seed means the same members, the same invoice
 * numbers and the same edge cases every run, so a bug found in seeded data can
 * be reproduced. Re-running truncates and rebuilds.
 *
 * The set is chosen to cover the states the dashboard has to render, not just
 * the happy one: a member in arrears, one mid-cancellation, one paused, one
 * with an erasure request pending, one with no subscription at all, and one
 * already erased.
 */

import { pool, query, transaction } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

/* ----------------------------------------------------- deterministic rng -- */

let seed = 20260821;
function rnd() {
  // mulberry32
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const DAY = 86400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const daysAhead = (n) => new Date(Date.now() + n * DAY);

/* ------------------------------------------------------------- the data -- */

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

const FIRST = ['Marisol', 'Idris', 'Thea', 'Callum', 'Nadia', 'Rhys', 'Priya', 'Jonah',
  'Aoife', 'Marcus', 'Leila', 'Owen', 'Bianca', 'Femi', 'Sasha', 'Duncan',
  'Anya', 'Kofi', 'Ruth', 'Milo', 'Erin', 'Tomas', 'Nia', 'Gideon'];
const LAST = ['Vega', 'Kane', 'Okonkwo', 'Reyes', 'Hartley', 'Morgan', 'Shah', 'Whitlock',
  'Byrne', 'Ellery', 'Haddad', 'Price', 'Rossi', 'Adeyemi', 'Novak', 'Frayne',
  'Petrova', 'Mensah', 'Colley', 'Barrow', 'Kelly', 'Varga', 'Bevan', 'Stokes'];
const STREETS = ['Coker Rd', 'Locking Rd', 'Milton Rd', 'Baker St', 'Ashcombe Rd',
  'Moorland Rd', 'Bristol Rd Lower', 'Queens Way', 'St Georges Sq', 'Elmsleigh Rd'];
const TOWNS = [['Weston-super-Mare', 'BS22'], ['Worle', 'BS22'], ['Weston-super-Mare', 'BS23'],
  ['Hutton', 'BS24'], ['Banwell', 'BS29'], ['Congresbury', 'BS49']];

const CLASS_TEMPLATES = [
  ['Fundamentals', 'Simon Flett', 'beginner', 18, 18, 90],
  ['Technical Sparring', 'Dean Lewis', 'intermediate', 12, 19, 90],
  ['Conditioning', 'Simon Flett', 'all', 24, 6, 60],
  ['Pads and Combinations', 'Dean Lewis', 'all', 16, 18, 60],
  ['Competition Squad', 'Dean Lewis', 'advanced', 10, 20, 120],
  ['Saturday Open Floor', 'Simon Flett', 'all', 30, 10, 120],
];

/* ------------------------------------------------------------------ run -- */

async function seedAll() {
  console.log('[seed] clearing existing data');
  await query(`TRUNCATE bookings, class_sessions, audit_log, data_requests, consents,
                        payments, payment_methods, invoice_lines, invoices,
                        subscriptions, sessions, members, plans RESTART IDENTITY CASCADE`);

  /* plans */
  const planIds = {};
  for (const p of PLANS) {
    const row = await query(
      `INSERT INTO plans (code, name, description, price_pence, features, capacity, sort_order)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id`,
      [p.code, p.name, p.description, p.price, JSON.stringify(p.features), p.capacity, p.sort]
    );
    planIds[p.code] = row[0].id;
  }
  console.log(`[seed] ${PLANS.length} plans`);

  /* classes: two weeks back, two weeks forward */
  const classIds = [];
  for (let d = -14; d <= 14; d++) {
    const date = new Date(Date.now() + d * DAY);
    const weekday = date.getDay();
    if (weekday === 0) continue;                        // closed Sundays for classes
    const perDay = weekday === 6 ? 2 : 3;
    for (let i = 0; i < perDay; i++) {
      const [title, coach, level, capacity, hour, minutes] = CLASS_TEMPLATES[(d + 14 + i) % CLASS_TEMPLATES.length];
      const starts = new Date(date);
      starts.setHours(hour, i === 1 ? 30 : 0, 0, 0);
      const ends = new Date(starts.getTime() + minutes * 60_000);
      const row = await query(
        `INSERT INTO class_sessions (title, coach, level, location, starts_at, ends_at, capacity)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, starts_at`,
        [title, coach, level, pick(['Main floor', 'Ring one', 'The pit']), starts, ends, capacity]
      );
      classIds.push(row[0]);
    }
  }
  console.log(`[seed] ${classIds.length} class sessions`);

  /* members */
  const password = hashPassword('WarriorsTest2026');
  let invoiceSeq = 1;
  const members = [];

  // A known account for testing, always first.
  const profiles = [
    { first: 'Demo', last: 'Member', email: 'demo@westonwarriors.example', plan: 'contender', state: 'active', months: 8 },
    { first: 'Ada', last: 'Overdue', email: 'overdue@westonwarriors.example', plan: 'initiate', state: 'past_due', months: 6 },
    { first: 'Ben', last: 'Leaving', email: 'leaving@westonwarriors.example', plan: 'contender', state: 'cancelling', months: 11 },
    { first: 'Cara', last: 'Paused', email: 'paused@westonwarriors.example', plan: 'warrior', state: 'paused', months: 14 },
    { first: 'Dev', last: 'Fresh', email: 'nosub@westonwarriors.example', plan: null, state: 'none', months: 0 },
    { first: 'Eve', last: 'Erasing', email: 'erasing@westonwarriors.example', plan: 'initiate', state: 'erasure_pending', months: 5 },
  ];

  for (let i = 0; i < 24; i++) {
    const scripted = profiles[i];
    const first = scripted?.first ?? FIRST[i % FIRST.length];
    const last = scripted?.last ?? LAST[(i * 7) % LAST.length];
    const email = scripted?.email
      ?? `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`;
    const [town, pcPrefix] = pick(TOWNS);
    const joinedDaysAgo = scripted ? (scripted.months * 30 + 10) : int(20, 900);

    const member = (await query(
      `INSERT INTO members (email, password_hash, first_name, last_name, phone, date_of_birth,
                            address_line1, city, postcode, emergency_contact_name,
                            emergency_contact_phone, medical_notes, status, role,
                            email_verified_at, last_login_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id, first_name, last_name, email`,
      [
        email, password, first, last,
        `07${int(100, 999)} ${int(100000, 999999)}`,
        new Date(int(1975, 2008), int(0, 11), int(1, 28)),
        `${int(1, 120)} ${pick(STREETS)}`,
        town,
        `${pcPrefix} ${int(1, 9)}${pick('ABDEFGHJLNPQRSTUWXYZ')}${pick('ABDEFGHJLNPQRSTUWXYZ')}`,
        `${pick(FIRST)} ${last}`,
        `07${int(100, 999)} ${int(100000, 999999)}`,
        i % 5 === 0 ? pick(['Asthma, inhaler in bag.', 'Old left shoulder dislocation.', 'Wears contact lenses.']) : '',
        'active', i === 1 ? 'coach' : 'member',
        daysAgo(joinedDaysAgo), daysAgo(int(0, 12)), daysAgo(joinedDaysAgo),
      ]
    ))[0];
    members.push({ ...member, scripted, joinedDaysAgo });

    /* consents: append-only ledger, some with a change of mind */
    const consentPurposes = [
      ['marketing_email', rnd() > 0.35],
      ['marketing_sms', rnd() > 0.7],
      ['photography', rnd() > 0.45],
      ['health_data', !!member.medical_notes || rnd() > 0.6],
      ['third_party_sharing', rnd() > 0.85],
    ];
    for (const [purpose, granted] of consentPurposes) {
      await query(
        `INSERT INTO consents (member_id, purpose, granted, policy_version, source, created_at)
         VALUES ($1,$2,$3,'1.0','signup',$4)`,
        [member.id, purpose, granted, daysAgo(joinedDaysAgo)]
      );
      // A quarter of members later changed their mind about marketing.
      if (purpose === 'marketing_email' && rnd() > 0.75) {
        await query(
          `INSERT INTO consents (member_id, purpose, granted, policy_version, source, created_at)
           VALUES ($1,$2,$3,'1.0','dashboard',$4)`,
          [member.id, purpose, !granted, daysAgo(int(1, Math.max(2, joinedDaysAgo - 5)))]
        );
      }
    }

    /* subscription */
    const state = scripted?.state ?? (rnd() > 0.12 ? 'active' : 'none');
    const planCode = scripted?.plan ?? pick(['initiate', 'initiate', 'contender', 'contender', 'warrior']);
    if (state !== 'none') {
      const status = state === 'past_due' ? 'past_due'
        : state === 'paused' ? 'paused'
        : 'active';
      const periodStart = daysAgo(int(1, 28));
      const sub = (await query(
        `INSERT INTO subscriptions (member_id, plan_id, status, started_at,
                                    current_period_start, current_period_end,
                                    cancel_at_period_end, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [member.id, planIds[planCode], status, daysAgo(joinedDaysAgo), periodStart,
         new Date(periodStart.getTime() + 30 * DAY), state === 'cancelling', daysAgo(joinedDaysAgo)]
      ))[0];

      /* payment method */
      const methodId = (await query(
        `INSERT INTO payment_methods (member_id, type, brand, last4, exp_month, exp_year,
                                      provider_token, is_default, created_at)
         VALUES ($1,'card',$2,$3,$4,$5,$6,true,$7) RETURNING id`,
        [member.id, pick(['Visa', 'Mastercard']), String(int(1000, 9999)),
         int(1, 12), int(2027, 2031), `tok_${Math.floor(rnd() * 1e16).toString(36)}`, daysAgo(joinedDaysAgo)]
      ))[0].id;

      /* invoice history */
      const monthsBilled = Math.max(1, Math.min(14, Math.floor(joinedDaysAgo / 30)));
      const price = PLANS.find((p) => p.code === planCode).price;
      for (let m = monthsBilled; m >= 0; m--) {
        const issued = daysAgo(m * 30 + 2);
        const isLatest = m === 0;
        const unpaid = (state === 'past_due' && m <= 1) || (isLatest && rnd() > 0.55);
        const status = unpaid ? 'open' : 'paid';
        const subtotal = price;
        const tax = 0;             // sport instruction is VAT exempt for this club
        const total = subtotal + tax;

        const invoice = (await query(
          `INSERT INTO invoices (member_id, subscription_id, number, status, subtotal_pence,
                                 tax_pence, total_pence, period_start, period_end,
                                 issued_at, due_at, paid_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$10) RETURNING id`,
          [member.id, sub.id, `WW-${issued.getFullYear()}-${String(invoiceSeq++).padStart(4, '0')}`,
           status, subtotal, tax, total,
           issued, new Date(issued.getTime() + 30 * DAY),
           issued, new Date(issued.getTime() + 14 * DAY),
           status === 'paid' ? new Date(issued.getTime() + int(0, 6) * DAY) : null]
        ))[0];

        await query(
          `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price_pence, amount_pence)
           VALUES ($1,$2,1,$3,$3)`,
          [invoice.id, `${PLANS.find((p) => p.code === planCode).name} membership, monthly`, price]
        );

        if (status === 'paid') {
          await query(
            `INSERT INTO payments (invoice_id, member_id, payment_method_id, amount_pence,
                                   status, method, reference, processed_at)
             VALUES ($1,$2,$3,$4,'succeeded','card',$5,$6)`,
            [invoice.id, member.id, methodId, total,
             `pay_${Math.floor(rnd() * 1e14).toString(36)}`, new Date(issued.getTime() + DAY)]
          );
        } else if (state === 'past_due' && m === 1) {
          // A real failed attempt, so the dashboard has a failure to show.
          await query(
            `INSERT INTO payments (invoice_id, member_id, payment_method_id, amount_pence,
                                   status, method, reference, failure_reason, processed_at)
             VALUES ($1,$2,$3,$4,'failed','card',$5,'Card declined by issuer',$6)`,
            [invoice.id, member.id, methodId, total,
             `pay_${Math.floor(rnd() * 1e14).toString(36)}`, new Date(issued.getTime() + 2 * DAY)]
          );
        }
      }
    }

    /* bookings across past and future classes */
    const attendCount = int(4, 22);
    const shuffled = [...classIds].sort(() => rnd() - 0.5).slice(0, attendCount);
    for (const cls of shuffled) {
      const past = new Date(cls.starts_at) < new Date();
      const status = past ? (rnd() > 0.12 ? 'attended' : 'no_show') : 'booked';
      await query(
        `INSERT INTO bookings (class_session_id, member_id, status, booked_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [cls.id, member.id, status, new Date(new Date(cls.starts_at).getTime() - int(1, 6) * DAY)]
      );
    }

    /* a little account activity */
    for (const action of ['auth.signin', 'profile.updated', 'auth.signin', 'class.booked']) {
      await query(
        `INSERT INTO audit_log (member_id, actor, action, created_at, ip)
         VALUES ($1,'member',$2,$3,$4)`,
        [member.id, action, daysAgo(int(1, 60)), `81.2.${int(0, 255)}.${int(1, 254)}`]
      );
    }

    /* scripted edge cases */
    if (scripted?.state === 'erasure_pending') {
      await query(
        `UPDATE members SET erasure_requested_at = $2, erasure_due_at = $3 WHERE id = $1`,
        [member.id, daysAgo(4), daysAhead(26)]
      );
      await query(
        `INSERT INTO data_requests (member_id, type, status, detail, requested_at, due_at)
         VALUES ($1,'erasure','pending','Self-service erasure request, 30 day grace period',$2,$3)`,
        [member.id, daysAgo(4), daysAhead(26)]
      );
    }
  }

  /* one member already erased, so the tombstone state is visible */
  const tombstone = (await query(
    `INSERT INTO members (email, password_hash, first_name, last_name, status, erased_at,
                          erasure_requested_at, erasure_due_at, created_at)
     VALUES ('erased-seed@invalid','erased','Erased','Member','erased', now(), $1, $2, $3)
     RETURNING id`,
    [daysAgo(45), daysAgo(15), daysAgo(400)]
  ))[0];
  const tombPlan = planIds.initiate;
  const tombSub = (await query(
    `INSERT INTO subscriptions (member_id, plan_id, status, started_at, current_period_start,
                                current_period_end, cancelled_at)
     VALUES ($1,$2,'cancelled',$3,$3,$4,$4) RETURNING id`,
    [tombstone.id, tombPlan, daysAgo(400), daysAgo(60)]
  ))[0];
  const tombInvoice = (await query(
    `INSERT INTO invoices (member_id, subscription_id, number, status, subtotal_pence,
                           total_pence, issued_at, due_at, paid_at)
     VALUES ($1,$2,$3,'paid',6500,6500,$4,$5,$4) RETURNING id`,
    [tombstone.id, tombSub.id, `WW-2025-${String(invoiceSeq++).padStart(4, '0')}`, daysAgo(90), daysAgo(76)]
  ))[0];
  await query(
    `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price_pence, amount_pence)
     VALUES ($1,'Initiate membership, monthly',1,6500,6500)`,
    [tombInvoice.id]
  );
  await query(
    `INSERT INTO audit_log (member_id, actor, action, entity, metadata, created_at)
     VALUES ($1,'system','data.erased','member','{"retained":"invoices and payments"}'::jsonb,$2)`,
    [tombstone.id, daysAgo(15)]
  );

  const counts = await query(`
    SELECT
      (SELECT count(*) FROM members)::int        AS members,
      (SELECT count(*) FROM subscriptions)::int  AS subscriptions,
      (SELECT count(*) FROM invoices)::int       AS invoices,
      (SELECT count(*) FROM payments)::int       AS payments,
      (SELECT count(*) FROM consents)::int       AS consents,
      (SELECT count(*) FROM class_sessions)::int AS classes,
      (SELECT count(*) FROM bookings)::int       AS bookings,
      (SELECT count(*) FROM audit_log)::int      AS audit_events`);

  console.log('[seed] done:', counts[0]);
  console.log('');
  console.log('  Sign in with any seeded account, password: WarriorsTest2026');
  console.log('');
  console.log('    demo@westonwarriors.example      active Contender, full history');
  console.log('    overdue@westonwarriors.example   past due, one failed card payment');
  console.log('    leaving@westonwarriors.example   cancelling at period end');
  console.log('    paused@westonwarriors.example    paused Warrior membership');
  console.log('    nosub@westonwarriors.example     registered, no membership yet');
  console.log('    erasing@westonwarriors.example   erasure requested, 26 days left');
  console.log('');
}

seedAll()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[seed] failed:', err);
    await pool.end();
    process.exit(1);
  });
