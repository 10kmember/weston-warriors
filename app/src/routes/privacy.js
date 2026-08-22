/**
 * Privacy, data rights and account security.
 *
 * The GDPR articles this implements, so the mapping is not folklore:
 *
 *   Art. 15  Access          — the account activity log and the export
 *   Art. 16  Rectification   — /dashboard/profile
 *   Art. 17  Erasure         — request, 30 day grace, then anonymisation
 *   Art. 18  Restriction     — request recorded for an admin to action
 *   Art. 20  Portability     — machine-readable JSON export
 *   Art. 21  Objection       — request recorded, marketing stops immediately
 *   Art. 7   Consent         — granular, withdrawable, evidenced by a ledger
 *
 * Erasure keeps the invoice trail. Article 17(3)(b) permits retention where
 * processing is necessary for compliance with a legal obligation, and UK tax
 * law requires six years of financial records.
 */

import express from 'express';
import { query, one, transaction } from '../db.js';
import { config } from '../config.js';
import {
  requireAuth, requireCsrf, audit, hashPassword, verifyPassword,
  revokeAllSessions, revokeSession, newToken,
} from '../auth.js';
import { passwordProblem, str } from '../validate.js';
import {
  page, esc, shortDate, longDateTime, statusPill, card, csrf, field, empty, money,
} from '../views/layout.js';

export const privacyRouter = express.Router();
privacyRouter.use('/dashboard', requireAuth);

const PURPOSES = [
  ['marketing_email', 'Club emails',
   'News, fight nights, timetable changes. Withdrawing this stops them the same day.'],
  ['marketing_sms', 'Text messages',
   'Short notice cancellations and reminders sent to your phone.'],
  ['photography', 'Photography and video',
   'Images of you from the gym floor used on the website and social channels.'],
  ['health_data', 'Medical notes',
   'Lets the club store the health information you choose to share so coaches can train you safely. Withdrawing this locks and clears the field.'],
  ['third_party_sharing', 'Sharing with partners',
   'Passing your details to affiliated clubs and competition organisers. Off unless you turn it on.'],
];

/* -------------------------------------------------------------- privacy -- */

privacyRouter.get('/dashboard/privacy', async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const [consents, requests, member, ledger, counts] = await Promise.all([
      query('SELECT purpose, granted, created_at, source FROM current_consents WHERE member_id = $1', [memberId]),
      query('SELECT * FROM data_requests WHERE member_id = $1 ORDER BY requested_at DESC LIMIT 10', [memberId]),
      one('SELECT * FROM members WHERE id = $1', [memberId]),
      query(
        `SELECT purpose, granted, created_at, source, policy_version
           FROM consents WHERE member_id = $1 ORDER BY created_at DESC LIMIT 12`,
        [memberId]
      ),
      one(
        `SELECT
           (SELECT count(*) FROM invoices  WHERE member_id = $1)::int AS invoices,
           (SELECT count(*) FROM payments  WHERE member_id = $1)::int AS payments,
           (SELECT count(*) FROM bookings  WHERE member_id = $1)::int AS bookings,
           (SELECT count(*) FROM consents  WHERE member_id = $1)::int AS consents,
           (SELECT count(*) FROM audit_log WHERE member_id = $1)::int AS events`,
        [memberId]
      ),
    ]);

    const state = Object.fromEntries(consents.map((c) => [c.purpose, c]));

    const consentRows = PURPOSES.map(([key, label, description]) => {
      const c = state[key];
      const on = !!c?.granted;
      return `
      <li class="consent">
        <div class="consent__text">
          <p class="consent__label">${esc(label)}</p>
          <p class="consent__desc">${esc(description)}</p>
          <p class="consent__meta mono">
            ${c ? `${on ? 'GRANTED' : 'WITHDRAWN'} ${esc(shortDate(c.created_at))} <s>·</s> VIA ${esc(c.source).toUpperCase()}`
                : 'NO DECISION RECORDED'}
          </p>
        </div>
        <form method="post" action="/dashboard/privacy/consents">
          ${csrf(req.session.csrf_token)}
          <input type="hidden" name="purpose" value="${esc(key)}" />
          <input type="hidden" name="granted" value="${on ? 'false' : 'true'}" />
          <button class="btn btn--sm ${on ? 'btn--ghost' : 'btn--solid'}" type="submit">
            ${on ? 'Withdraw' : 'Give consent'}
          </button>
        </form>
      </li>`;
    }).join('');

    const ledgerBody = ledger.length ? `
      <table class="table">
        <thead><tr><th>Purpose</th><th>Decision</th><th>When</th><th>Source</th><th>Policy</th></tr></thead>
        <tbody>${ledger.map((l) => `
          <tr>
            <td class="mono">${esc(l.purpose)}</td>
            <td>${l.granted ? '<span class="pill pill--ok">granted</span>' : '<span class="pill pill--muted">withdrawn</span>'}</td>
            <td>${esc(longDateTime(l.created_at))}</td>
            <td class="mono">${esc(l.source)}</td>
            <td class="mono">v${esc(l.policy_version)}</td>
          </tr>`).join('')}</tbody>
      </table>` : empty('NO CONSENT HISTORY.');

    const requestsBody = requests.length ? `
      <table class="table">
        <thead><tr><th>Type</th><th>Requested</th><th>Due</th><th>Status</th></tr></thead>
        <tbody>${requests.map((r) => `
          <tr>
            <td class="mono">${esc(r.type)}</td>
            <td>${esc(shortDate(r.requested_at))}</td>
            <td>${esc(shortDate(r.due_at))}</td>
            <td>${statusPill(r.status)}</td>
          </tr>`).join('')}</tbody>
      </table>` : empty('NO REQUESTS RAISED.');

    const erasurePending = !!member.erasure_requested_at && !member.erased_at;

    res.send(page({
      title: 'Privacy and data',
      member: req.session,
      active: '/dashboard/privacy',
      flash: req.query.consent ? { kind: 'ok', message: 'Preference saved and recorded against your account.' }
           : req.query.requested ? { kind: 'ok', message: 'Request logged. The club has 30 days to respond.' }
           : req.query.erasure === 'requested' ? { kind: 'bad', message: 'Erasure requested. You have 30 days to change your mind.' }
           : req.query.erasure === 'cancelled' ? { kind: 'ok', message: 'Erasure cancelled. Your account stays as it is.' }
           : null,
      body: `
      <header class="head">
        <p class="head__eyebrow mono">PRIVACY <s>//</s> YOUR DATA</p>
        <h1 class="head__title">Your Data</h1>
        <p class="head__lede">
          Everything the club holds about you, what it is used for, and the
          controls to change or remove it.
        </p>
      </header>

      <div class="tiles">
        <div class="tile"><p class="tile__k mono">INVOICES</p><p class="tile__v">${counts.invoices}</p></div>
        <div class="tile"><p class="tile__k mono">PAYMENTS</p><p class="tile__v">${counts.payments}</p></div>
        <div class="tile"><p class="tile__k mono">BOOKINGS</p><p class="tile__v">${counts.bookings}</p></div>
        <div class="tile"><p class="tile__k mono">LOGGED EVENTS</p><p class="tile__v">${counts.events}</p></div>
      </div>

      ${card('Permissions', `
        <p class="muted">
          Each of these is a separate decision and none of them are a condition
          of training here. Every change is stored with a timestamp so the club
          can show what you agreed to and when.
        </p>
        <ul class="consents__list">${consentRows}</ul>`)}

      ${card('Take your data with you', `
        <p class="muted">
          A complete copy of your record in JSON: profile, membership, invoices,
          payments, bookings, consent history and account activity. This is your
          right of access and portability under Articles 15 and 20.
        </p>
        <div class="actions">
          <a class="btn btn--solid btn--sm" href="/dashboard/privacy/export.json" download>Download JSON</a>
          <form method="post" action="/dashboard/privacy/request" class="inline">
            ${csrf(req.session.csrf_token)}
            <input type="hidden" name="type" value="restriction" />
            <button class="btn btn--sm btn--ghost" type="submit">Ask to restrict processing</button>
          </form>
          <form method="post" action="/dashboard/privacy/request" class="inline">
            ${csrf(req.session.csrf_token)}
            <input type="hidden" name="type" value="objection" />
            <button class="btn btn--sm btn--ghost" type="submit">Object to processing</button>
          </form>
        </div>`)}

      ${card('Consent history', ledgerBody)}
      ${card('Requests', requestsBody)}

      ${card('Close your account', `
        ${erasurePending ? `
          <p class="muted">
            Erasure was requested on ${esc(shortDate(member.erasure_requested_at))}
            and completes on ${esc(shortDate(member.erasure_due_at))}. Until then
            nothing has been deleted and you can stop it.
          </p>
          <form method="post" action="/dashboard/privacy/erasure/cancel" class="mt">
            ${csrf(req.session.csrf_token)}
            <button class="btn btn--sm btn--solid" type="submit">Cancel erasure</button>
          </form>
        ` : `
          <p class="muted">
            This removes your name, contact details, address, emergency contact
            and medical notes, and closes your membership. It cannot be undone
            once the 30 day grace period ends.
          </p>
          <p class="muted small">
            Your invoices and payments are kept for six years with your personal
            details stripped out, because tax law requires the club to hold
            financial records. Article 17(3)(b) allows exactly this.
          </p>
          <form method="post" action="/dashboard/privacy/erasure" class="mt erasure">
            ${csrf(req.session.csrf_token)}
            ${field('confirm_password', 'CONFIRM WITH YOUR PASSWORD', '', { type: 'password', required: true, autocomplete: 'current-password' })}
            <label class="check">
              <input type="checkbox" name="understood" required />
              <span>I understand my personal data will be erased after 30 days.</span>
            </label>
            <button class="btn btn--sm btn--danger" type="submit">Request erasure</button>
          </form>
        `}`, { tone: 'danger' })}`,
    }));
  } catch (err) {
    next(err);
  }
});

privacyRouter.post('/dashboard/privacy/consents', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const purpose = str(req.body.purpose, 40);
    const granted = str(req.body.granted, 8) === 'true';
    if (!PURPOSES.some(([k]) => k === purpose)) return res.redirect('/dashboard/privacy');

    await transaction(async (tx) => {
      // Append, never update: the ledger is the evidence.
      await tx.query(
        `INSERT INTO consents (member_id, purpose, granted, policy_version, source, ip)
         VALUES ($1, $2, $3, $4, 'dashboard', $5)`,
        [memberId, purpose, granted, config.policyVersion, req.ip || null]
      );

      // Withdrawing health consent must actually remove the health data.
      if (purpose === 'health_data' && !granted) {
        await tx.query(`UPDATE members SET medical_notes = '', updated_at = now() WHERE id = $1`, [memberId]);
      }
    });

    await audit(req, {
      memberId, action: granted ? 'consent.granted' : 'consent.withdrawn',
      entity: 'consent', entityId: purpose, metadata: { purpose, granted },
    });
    res.redirect('/dashboard/privacy?consent=1');
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------------- export -- */

privacyRouter.get('/dashboard/privacy/export.json', async (req, res, next) => {
  try {
    const memberId = req.session.member_id;

    const [member, subscriptions, invoices, lines, payments, methods, bookings, consents, requests, events, sessions] =
      await Promise.all([
        one(`SELECT id, email, first_name, last_name, phone, date_of_birth,
                    address_line1, address_line2, city, postcode,
                    emergency_contact_name, emergency_contact_phone, medical_notes,
                    status, created_at, updated_at, last_login_at,
                    email_verified_at, erasure_requested_at
               FROM members WHERE id = $1`, [memberId]),
        query(`SELECT s.id, s.status, s.started_at, s.current_period_start, s.current_period_end,
                      s.cancel_at_period_end, s.cancelled_at, p.code AS plan_code, p.name AS plan_name,
                      s.price_pence, s.billing_interval
                 FROM subscriptions s JOIN plans p ON p.id = s.plan_id
                WHERE s.member_id = $1 ORDER BY s.created_at`, [memberId]),
        query('SELECT * FROM invoices WHERE member_id = $1 ORDER BY issued_at', [memberId]),
        query(`SELECT l.* FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
                WHERE i.member_id = $1 ORDER BY l.invoice_id, l.sort_order`, [memberId]),
        query('SELECT * FROM payments WHERE member_id = $1 ORDER BY processed_at', [memberId]),
        query(`SELECT id, type, brand, last4, exp_month, exp_year, is_default, created_at
                 FROM payment_methods WHERE member_id = $1`, [memberId]),
        query(`SELECT b.id, b.status, b.booked_at, b.cancelled_at,
                      c.title, c.coach, c.starts_at, c.ends_at, c.location
                 FROM bookings b JOIN class_sessions c ON c.id = b.class_session_id
                WHERE b.member_id = $1 ORDER BY c.starts_at`, [memberId]),
        query('SELECT purpose, granted, policy_version, source, created_at FROM consents WHERE member_id = $1 ORDER BY created_at', [memberId]),
        query('SELECT type, status, detail, requested_at, due_at, completed_at FROM data_requests WHERE member_id = $1 ORDER BY requested_at', [memberId]),
        query('SELECT action, entity, entity_id, metadata, created_at FROM audit_log WHERE member_id = $1 ORDER BY created_at', [memberId]),
        query(`SELECT id, created_at, last_seen_at, expires_at, revoked_at, user_agent
                 FROM sessions WHERE member_id = $1 ORDER BY created_at`, [memberId]),
      ]);

    const linesByInvoice = new Map();
    for (const l of lines) {
      if (!linesByInvoice.has(l.invoice_id)) linesByInvoice.set(l.invoice_id, []);
      linesByInvoice.get(l.invoice_id).push({
        description: l.description, quantity: l.quantity,
        unit_price_pence: l.unit_price_pence, amount_pence: l.amount_pence,
      });
    }

    const payload = {
      export_format: 'weston-warriors/member-export',
      export_version: 1,
      generated_at: new Date().toISOString(),
      about: 'A complete copy of the personal data Weston Warriors ABC holds about you, provided under UK GDPR Articles 15 and 20.',
      controller: {
        name: 'Weston Warriors ABC',
        address: '22 Coker Rd, Worle, Weston-super-Mare, BS22 6BX',
      },
      member,
      subscriptions,
      invoices: invoices.map((i) => ({ ...i, lines: linesByInvoice.get(i.id) || [] })),
      payments,
      payment_methods: methods,
      bookings,
      consents,
      data_requests: requests,
      account_activity: events,
      sessions,
    };

    await query(
      `INSERT INTO data_requests (member_id, type, status, detail, completed_at)
       VALUES ($1, 'export', 'completed', 'Self-service download from the member dashboard', now())`,
      [memberId]
    );
    await audit(req, { memberId, action: 'data.exported', metadata: { records: invoices.length + payments.length } });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="weston-warriors-data-${stamp}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------- requests -- */

privacyRouter.post('/dashboard/privacy/request', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const type = str(req.body.type, 20);
    if (!['restriction', 'objection', 'rectification'].includes(type)) {
      return res.redirect('/dashboard/privacy');
    }

    await transaction(async (tx) => {
      await tx.query(
        `INSERT INTO data_requests (member_id, type, detail)
         VALUES ($1, $2, $3)`,
        [memberId, type, 'Raised from the member dashboard']
      );
      // An objection to direct marketing is absolute: stop immediately rather
      // than making the member wait on an admin review.
      if (type === 'objection') {
        for (const purpose of ['marketing_email', 'marketing_sms', 'third_party_sharing']) {
          await tx.query(
            `INSERT INTO consents (member_id, purpose, granted, policy_version, source, ip)
             VALUES ($1, $2, false, $3, 'dashboard', $4)`,
            [memberId, purpose, config.policyVersion, req.ip || null]
          );
        }
      }
    });

    await audit(req, { memberId, action: `data.request_${type}` });
    res.redirect('/dashboard/privacy?requested=1');
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------------- erasure -- */

privacyRouter.post('/dashboard/privacy/erasure', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const password = String(req.body.confirm_password || '');
    const understood = !!req.body.understood;

    const member = await one('SELECT password_hash FROM members WHERE id = $1', [memberId]);
    if (!understood || !verifyPassword(password, member.password_hash)) {
      return res.status(400).send(page({
        title: 'Privacy and data',
        member: req.session,
        active: '/dashboard/privacy',
        flash: { kind: 'bad', message: 'Password did not match, or the confirmation was not ticked. Nothing was changed.' },
        body: `<p class="mt"><a class="btn btn--sm btn--ghost" href="/dashboard/privacy">Back to privacy</a></p>`,
      }));
    }

    await transaction(async (tx) => {
      await tx.query(
        `UPDATE members
            SET erasure_requested_at = now(),
                erasure_due_at = now() + interval '30 days',
                updated_at = now()
          WHERE id = $1`,
        [memberId]
      );
      await tx.query(
        `INSERT INTO data_requests (member_id, type, status, detail)
         VALUES ($1, 'erasure', 'pending', 'Self-service erasure request, 30 day grace period')`,
        [memberId]
      );
      await tx.query(
        `UPDATE subscriptions SET cancel_at_period_end = true, updated_at = now()
          WHERE member_id = $1 AND status IN ('trialing','active','past_due','paused')`,
        [memberId]
      );
    });

    await audit(req, { memberId, action: 'data.erasure_requested' });
    res.redirect('/dashboard/privacy?erasure=requested');
  } catch (err) {
    next(err);
  }
});

privacyRouter.post('/dashboard/privacy/erasure/cancel', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    await transaction(async (tx) => {
      await tx.query(
        `UPDATE members SET erasure_requested_at = NULL, erasure_due_at = NULL, updated_at = now()
          WHERE id = $1`,
        [memberId]
      );
      await tx.query(
        `UPDATE data_requests SET status = 'cancelled', completed_at = now()
          WHERE member_id = $1 AND type = 'erasure' AND status = 'pending'`,
        [memberId]
      );
    });
    await audit(req, { memberId, action: 'data.erasure_cancelled' });
    res.redirect('/dashboard/privacy?erasure=cancelled');
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------- security -- */

privacyRouter.get('/dashboard/security', async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const [sessions, events, member] = await Promise.all([
      query(
        `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at
           FROM sessions
          WHERE member_id = $1 AND revoked_at IS NULL AND expires_at > now()
          ORDER BY last_seen_at DESC`,
        [memberId]
      ),
      query(
        `SELECT action, entity, created_at, ip FROM audit_log
          WHERE member_id = $1 ORDER BY created_at DESC LIMIT 25`,
        [memberId]
      ),
      one('SELECT last_login_at, created_at FROM members WHERE id = $1', [memberId]),
    ]);

    const sessionRows = sessions.map((s) => {
      const isCurrent = s.id === req.session.id;
      return `
      <li class="list__row">
        <div>
          <p class="list__title">${esc(shortUa(s.user_agent))} ${isCurrent ? '<span class="pill pill--ok">this device</span>' : ''}</p>
          <p class="list__meta mono">
            ${esc(s.ip || 'unknown ip')} <s>·</s> LAST SEEN ${esc(longDateTime(s.last_seen_at))}
            <s>·</s> EXPIRES ${esc(shortDate(s.expires_at))}
          </p>
        </div>
        ${isCurrent ? '' : `
        <form method="post" action="/dashboard/security/sessions/${esc(s.id)}/revoke">
          ${csrf(req.session.csrf_token)}
          <button class="btn btn--sm btn--danger" type="submit">Revoke</button>
        </form>`}
      </li>`;
    }).join('');

    const activityBody = events.length ? `
      <table class="table">
        <thead><tr><th>Event</th><th>When</th><th>From</th></tr></thead>
        <tbody>${events.map((e) => `
          <tr>
            <td class="mono">${esc(e.action)}</td>
            <td>${esc(longDateTime(e.created_at))}</td>
            <td class="mono muted">${esc(e.ip || '—')}</td>
          </tr>`).join('')}</tbody>
      </table>` : empty('NO ACTIVITY RECORDED.');

    res.send(page({
      title: 'Security',
      member: req.session,
      active: '/dashboard/security',
      flash: req.query.password === 'changed' ? { kind: 'ok', message: 'Password changed. Every other device has been signed out.' }
           : req.query.revoked ? { kind: 'ok', message: 'That session was signed out.' }
           : req.query.error === 'password' ? { kind: 'bad', message: 'Current password was wrong. Nothing was changed.' }
           : null,
      body: `
      <header class="head">
        <p class="head__eyebrow mono">SECURITY</p>
        <h1 class="head__title">Account Security</h1>
        <p class="head__lede">
          Member since ${esc(shortDate(member.created_at))}. Last signed in
          ${esc(longDateTime(member.last_login_at))}.
        </p>
      </header>

      ${card('Change password', `
        <form method="post" action="/dashboard/security/password" class="narrow" novalidate>
          ${csrf(req.session.csrf_token)}
          ${field('current_password', 'CURRENT PASSWORD', '', { type: 'password', required: true, autocomplete: 'current-password' })}
          ${field('new_password', 'NEW PASSWORD', '', { type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 10 characters.' })}
          ${field('confirm_password', 'CONFIRM NEW PASSWORD', '', { type: 'password', required: true, autocomplete: 'new-password' })}
          <button class="btn btn--sm btn--solid" type="submit">Change password</button>
        </form>`)}

      ${card('Where you are signed in', sessions.length ? `<ul class="list">${sessionRows}</ul>` : empty('NO ACTIVE SESSIONS.'), {
        action: `<form method="post" action="/dashboard/security/sessions/revoke-all">
          ${csrf(req.session.csrf_token)}
          <button class="btn btn--sm btn--ghost" type="submit">Sign out everywhere else</button>
        </form>`,
      })}

      ${card('Account activity', activityBody)}`,
    }));
  } catch (err) {
    next(err);
  }
});

function shortUa(ua) {
  if (!ua) return 'Unknown device';
  if (/iPhone|iPad/i.test(ua)) return 'iOS device';
  if (/Android/i.test(ua)) return 'Android device';
  if (/Edg\//i.test(ua)) return 'Edge on desktop';
  if (/Firefox/i.test(ua)) return 'Firefox on desktop';
  if (/Chrome/i.test(ua)) return 'Chrome on desktop';
  if (/Safari/i.test(ua)) return 'Safari on desktop';
  return 'Unknown device';
}

privacyRouter.post('/dashboard/security/password', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const current = String(req.body.current_password || '');
    const next_ = String(req.body.new_password || '');
    const confirm = String(req.body.confirm_password || '');

    const member = await one('SELECT password_hash FROM members WHERE id = $1', [memberId]);
    if (!verifyPassword(current, member.password_hash)) {
      await audit(req, { memberId, action: 'auth.password_change_failed' });
      return res.redirect('/dashboard/security?error=password');
    }

    const problem = passwordProblem(next_) || (next_ !== confirm ? 'Passwords do not match.' : null);
    if (problem) {
      return res.status(400).send(page({
        title: 'Security',
        member: req.session,
        active: '/dashboard/security',
        flash: { kind: 'bad', message: problem },
        body: `<p class="mt"><a class="btn btn--sm btn--ghost" href="/dashboard/security">Back to security</a></p>`,
      }));
    }

    await query('UPDATE members SET password_hash = $1, updated_at = now() WHERE id = $2',
      [hashPassword(next_), memberId]);
    // A password change should end every other session.
    await revokeAllSessions(memberId, req.session.id);
    await audit(req, { memberId, action: 'auth.password_changed' });

    res.redirect('/dashboard/security?password=changed');
  } catch (err) {
    next(err);
  }
});

privacyRouter.post('/dashboard/security/sessions/:id/revoke', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const owned = await one('SELECT id FROM sessions WHERE id = $1 AND member_id = $2', [req.params.id, memberId]);
    if (owned) {
      await revokeSession(owned.id);
      await audit(req, { memberId, action: 'auth.session_revoked', entityId: owned.id });
    }
    res.redirect('/dashboard/security?revoked=1');
  } catch (err) {
    next(err);
  }
});

privacyRouter.post('/dashboard/security/sessions/revoke-all', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    await revokeAllSessions(memberId, req.session.id);
    await audit(req, { memberId, action: 'auth.sessions_revoked_all' });
    res.redirect('/dashboard/security?revoked=1');
  } catch (err) {
    next(err);
  }
});
