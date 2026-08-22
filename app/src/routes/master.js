/**
 * The master dashboard: everybody's account, seen from the coaches' side.
 *
 * Answers the four questions a club actually asks on a Monday morning:
 *   how many participants are we carrying,
 *   how many of them are square with us,
 *   who is short and by how much,
 *   and can I put last night's cash against the right invoice.
 *
 * Reconciliation is append-only. Recording a cash payment writes a payment row
 * attributed to the member of staff who took it; correcting a mistake writes a
 * reversal, it does not edit or delete the original. Cash handling is exactly
 * where an audit trail earns its keep.
 */

import express from 'express';
import { query, one, transaction } from '../db.js';
import {
  attachStaff, requireStaff, requireStaffGuest, requireStaffCsrf, requireAdmin,
  createStaffSession, setStaffCookie, clearStaffCookie, revokeStaffSession,
  verifyStaffPassword, burnPasswordTime, throttleStaffLogin,
  recordStaffFailure, clearStaffAttempts, staffAudit,
} from '../staff-auth.js';
import { str } from '../validate.js';
import { masterPage, masterSigninPage } from '../views/master-layout.js';
import {
  esc, money, shortDate, longDateTime, statusPill, card, csrf, field, empty,
} from '../views/layout.js';
import { registerPricingRoutes } from './master-pricing.js';

export const masterRouter = express.Router();

// Staff cookie is scoped to /master, so this only ever runs here.
masterRouter.use('/master', attachStaff);

/* ---------------------------------------------------------------- sign in -- */

masterRouter.get('/master/signin', requireStaffGuest, (req, res) => {
  res.send(masterSigninPage({ next: str(req.query.next, 200) }));
});

masterRouter.post('/master/signin', requireStaffGuest, throttleStaffLogin, async (req, res, next) => {
  try {
    const email = str(req.body.email, 320).toLowerCase();
    const password = String(req.body.password || '');
    const target = str(req.body.next, 200);

    const staff = await one(
      'SELECT id, password_hash, status, locked_until FROM staff_users WHERE lower(email) = $1',
      [email]
    );

    const reject = (message = 'Email or password is incorrect.') =>
      res.status(401).send(masterSigninPage({ email, next: target, error: message }));

    if (!staff) { burnPasswordTime(password); recordStaffFailure(req); return reject(); }
    if (staff.locked_until && new Date(staff.locked_until) > new Date()) {
      return res.status(429).send(masterSigninPage({
        email, next: target, error: 'This account is locked after repeated failures. Try again shortly.',
      }));
    }
    if (staff.status !== 'active') return reject();

    if (!verifyStaffPassword(password, staff.password_hash)) {
      recordStaffFailure(req);
      await query(
        `UPDATE staff_users
            SET failed_login_count = failed_login_count + 1,
                locked_until = CASE WHEN failed_login_count + 1 >= 5
                                    THEN now() + interval '15 minutes' ELSE locked_until END
          WHERE id = $1`,
        [staff.id]
      );
      return reject();
    }

    const session = await createStaffSession(staff.id, { ip: req.ip, userAgent: req.get('user-agent') });
    setStaffCookie(res, session.raw, session.expiresAt);
    clearStaffAttempts(req);
    await query(
      'UPDATE staff_users SET last_login_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1',
      [staff.id]
    );

    req.staff = { staff_id: staff.id };
    await staffAudit(req, { action: 'staff.signin' });

    const safe = target.startsWith('/master') ? target : '/master';
    res.redirect(safe);
  } catch (err) {
    next(err);
  }
});

masterRouter.post('/master/signout', async (req, res, next) => {
  try {
    if (req.staff) {
      await revokeStaffSession(req.staff.id);
      await staffAudit(req, { action: 'staff.signout' });
    }
    clearStaffCookie(res);
    res.redirect('/master/signin');
  } catch (err) {
    next(err);
  }
});

// Everything past here needs a staff session.
masterRouter.use('/master', requireStaff);

// Pricing lives in its own file but on this router, so it inherits the guard
// above rather than declaring a second one that could drift out of step.
registerPricingRoutes(masterRouter);

/* --------------------------------------------------------------- helpers -- */

/** Outstanding balance per member, from the invoice_balances view. */
const MEMBER_BALANCE = `
  SELECT member_id,
         SUM(outstanding_pence)::int                                  AS outstanding,
         SUM(CASE WHEN is_overdue THEN outstanding_pence ELSE 0 END)::int AS overdue,
         MAX(days_overdue)                                            AS worst_days
    FROM invoice_balances
   WHERE status IN ('open', 'draft') AND outstanding_pence > 0
   GROUP BY member_id`;

const FLASH = {
  recorded: { kind: 'ok', message: 'Payment recorded and the invoice updated.' },
  reversed: { kind: 'ok', message: 'Payment reversed. The original entry is kept, with a reversal beside it.' },
  voided: { kind: 'ok', message: 'Invoice voided.' },
  nothing: { kind: 'bad', message: 'Nothing to record: check the amount.' },
  memberpriced: { kind: 'ok', message: 'This membership is now on its own rate.' },
  badprice: { kind: 'bad', message: 'That is not a price. Use pounds and pence, for example 45.00.' },
  nosub: { kind: 'bad', message: 'That member has no live membership to reprice.' },
};

/* -------------------------------------------------------------- overview -- */

masterRouter.get('/master', async (req, res, next) => {
  try {
    const [counts, cash, shortfall, recent, attention] = await Promise.all([
      one(`
        SELECT
          count(*) FILTER (WHERE m.status = 'active')::int              AS participants,
          count(*) FILTER (WHERE m.status = 'active'
                            AND s.id IS NOT NULL)::int                  AS subscribed,
          count(*) FILTER (WHERE m.status = 'active'
                            AND b.outstanding IS NULL)::int             AS square,
          count(*) FILTER (WHERE m.status = 'active'
                            AND b.outstanding IS NOT NULL)::int         AS short,
          count(*) FILTER (WHERE m.created_at > now() - interval '30 days'
                            AND m.status = 'active')::int               AS joined_30d,
          COALESCE(SUM(b.outstanding), 0)::int                          AS owed
        FROM members m
        LEFT JOIN subscriptions s
               ON s.member_id = m.id
              AND s.status IN ('trialing','active','past_due','paused')
        LEFT JOIN (${MEMBER_BALANCE}) b ON b.member_id = m.id
        WHERE m.status <> 'erased'`),
      one(`
        SELECT
          COALESCE(SUM(amount_pence) FILTER (
            WHERE status = 'succeeded' AND processed_at > now() - interval '30 days'), 0)::int AS last_30,
          COALESCE(SUM(amount_pence) FILTER (
            WHERE status = 'succeeded' AND method <> 'card'
              AND processed_at > now() - interval '30 days'), 0)::int AS offline_30,
          count(*) FILTER (WHERE status = 'failed'
                            AND processed_at > now() - interval '30 days')::int AS failed_30
        FROM payments`),
      query(`
        SELECT m.id, m.first_name, m.last_name, m.email, m.avatar_key,
               b.outstanding, b.overdue, b.worst_days,
               p.name AS plan_name
          FROM members m
          JOIN (${MEMBER_BALANCE}) b ON b.member_id = m.id
          LEFT JOIN subscriptions s ON s.member_id = m.id
               AND s.status IN ('trialing','active','past_due','paused')
          LEFT JOIN plans p ON p.id = s.plan_id
         WHERE m.status <> 'erased'
         ORDER BY b.overdue DESC, b.outstanding DESC
         LIMIT 12`),
      query(`
        SELECT pay.id, pay.amount_pence, pay.method, pay.status, pay.processed_at,
               pay.reference, i.number, m.first_name, m.last_name, su.name AS staff_name
          FROM payments pay
          LEFT JOIN invoices i ON i.id = pay.invoice_id
          LEFT JOIN members m ON m.id = pay.member_id
          LEFT JOIN staff_users su ON su.id = pay.recorded_by
         ORDER BY pay.processed_at DESC
         LIMIT 8`),
      one(`
        SELECT
          (SELECT count(*) FROM data_requests
            WHERE status IN ('pending','in_progress'))::int      AS open_requests,
          (SELECT count(*) FROM members
            WHERE erasure_due_at IS NOT NULL AND erased_at IS NULL)::int AS erasures_due,
          (SELECT count(*) FROM subscriptions
            WHERE status = 'past_due')::int                      AS past_due_subs,
          (SELECT count(*) FROM subscriptions
            WHERE cancel_at_period_end)::int                     AS leaving`),
    ]);

    const paidRate = counts.participants
      ? Math.round((counts.square / counts.participants) * 100) : 0;

    const shortfallRows = shortfall.length ? `
      <table class="table">
        <thead><tr><th>Participant</th><th>Plan</th><th class="num">Owed</th><th class="num">Overdue</th><th>Worst</th><th></th></tr></thead>
        <tbody>${shortfall.map((r) => `
          <tr>
            <td>
              <span class="who2">
                <img src="/assets/avatars/${esc(r.avatar_key)}.svg" alt="" width="26" height="26" />
                <a href="/master/members/${esc(r.id)}">${esc(r.first_name)} ${esc(r.last_name)}</a>
              </span>
            </td>
            <td class="mono muted">${esc(r.plan_name || 'none')}</td>
            <td class="num">${esc(money(r.outstanding))}</td>
            <td class="num">${r.overdue > 0 ? `<span class="owed">${esc(money(r.overdue))}</span>` : '—'}</td>
            <td class="mono muted">${r.worst_days > 0 ? `${r.worst_days}d` : '—'}</td>
            <td class="num"><a class="btn btn--sm btn--ghost" href="/master/members/${esc(r.id)}">Open</a></td>
          </tr>`).join('')}</tbody>
      </table>` : empty('NOBODY IS IN ARREARS. GOOD MORNING.');

    const recentRows = recent.length ? `
      <table class="table">
        <thead><tr><th>When</th><th>Participant</th><th>Invoice</th><th>Method</th><th>Taken by</th><th>Status</th><th class="num">Amount</th></tr></thead>
        <tbody>${recent.map((p) => `
          <tr>
            <td class="mono muted">${esc(shortDate(p.processed_at))}</td>
            <td>${esc(p.first_name || '')} ${esc(p.last_name || '')}</td>
            <td class="mono">${esc(p.number || '—')}</td>
            <td class="mono">${esc(p.method.replace(/_/g, ' '))}</td>
            <td class="mono muted">${esc(p.staff_name || 'processor')}</td>
            <td>${statusPill(p.status)}</td>
            <td class="num">${esc(money(p.amount_pence))}</td>
          </tr>`).join('')}</tbody>
      </table>` : empty('NO PAYMENTS RECORDED YET.');

    const flags = [
      attention.open_requests && `${attention.open_requests} open data request${attention.open_requests > 1 ? 's' : ''} inside the 30 day window`,
      attention.erasures_due && `${attention.erasures_due} erasure${attention.erasures_due > 1 ? 's' : ''} scheduled`,
      attention.past_due_subs && `${attention.past_due_subs} membership${attention.past_due_subs > 1 ? 's' : ''} past due`,
      attention.leaving && `${attention.leaving} cancelling at period end`,
    ].filter(Boolean);

    res.send(masterPage({
      title: 'Overview',
      staff: req.staff,
      active: '/master',
      flash: FLASH[req.query.done] || null,
      body: `
      <header class="head">
        <p class="head__eyebrow mono">MASTER <s>//</s> THE WHOLE FLOOR</p>
        <h1 class="head__title">The Club, Today</h1>
      </header>

      <div class="tiles">
        <div class="tile">
          <p class="tile__k mono">PARTICIPANTS</p>
          <p class="tile__v">${counts.participants}</p>
          <p class="tile__sub mono">${counts.subscribed} ON A MEMBERSHIP <s>·</s> ${counts.joined_30d} JOINED IN 30 DAYS</p>
        </div>
        <div class="tile">
          <p class="tile__k mono">SQUARE WITH US</p>
          <p class="tile__v">${counts.square}</p>
          <p class="tile__sub mono">${paidRate}% OF PARTICIPANTS</p>
        </div>
        <div class="tile${counts.short ? ' tile--warn' : ''}">
          <p class="tile__k mono">IN SHORTFALL</p>
          <p class="tile__v">${counts.short}</p>
          <p class="tile__sub mono">${esc(money(counts.owed))} OUTSTANDING</p>
        </div>
        <div class="tile">
          <p class="tile__k mono">TAKEN, 30 DAYS</p>
          <p class="tile__v">${esc(money(cash.last_30))}</p>
          <p class="tile__sub mono">${esc(money(cash.offline_30))} OFF THE CARD RAILS <s>·</s> ${cash.failed_30} FAILED</p>
        </div>
      </div>

      ${flags.length ? `<div class="banner banner--warn"><strong>Needs a look.</strong> ${esc(flags.join('. '))}.</div>` : ''}

      ${card('Shortfall', shortfallRows, {
        action: '<a class="btn btn--sm btn--ghost" href="/master/reconciliation">Reconcile payments</a>',
      })}

      ${card('Recent payments', recentRows)}`,
    }));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------ participants -- */

masterRouter.get('/master/members', async (req, res, next) => {
  try {
    const q = str(req.query.q, 80);
    const filter = str(req.query.filter, 20);

    const rows = await query(`
      SELECT m.id, m.first_name, m.last_name, m.email, m.status, m.avatar_key,
             m.created_at, m.erasure_due_at,
             p.name AS plan_name, s.status AS sub_status,
             COALESCE(b.outstanding, 0) AS outstanding,
             COALESCE(b.overdue, 0)     AS overdue,
             (SELECT max(processed_at) FROM payments
               WHERE member_id = m.id AND status = 'succeeded') AS last_paid
        FROM members m
        LEFT JOIN subscriptions s ON s.member_id = m.id
             AND s.status IN ('trialing','active','past_due','paused')
        LEFT JOIN plans p ON p.id = s.plan_id
        LEFT JOIN (${MEMBER_BALANCE}) b ON b.member_id = m.id
       WHERE ($1 = '' OR m.first_name ILIKE '%' || $1 || '%'
                      OR m.last_name  ILIKE '%' || $1 || '%'
                      OR m.email      ILIKE '%' || $1 || '%')
         AND ($2 <> 'short' OR b.outstanding > 0)
         AND ($2 <> 'square' OR b.outstanding IS NULL)
         AND ($2 <> 'nosub' OR s.id IS NULL)
       ORDER BY b.overdue DESC NULLS LAST, m.last_name, m.first_name
       LIMIT 200`, [q, filter]);

    const tabs = [['', 'All'], ['short', 'In shortfall'], ['square', 'Square'], ['nosub', 'No membership']]
      .map(([key, label]) => `
        <a class="tab${filter === key ? ' is-on' : ''}"
           href="/master/members?filter=${key}${q ? `&q=${encodeURIComponent(q)}` : ''}">${esc(label)}</a>`).join('');

    res.send(masterPage({
      title: 'Participants',
      staff: req.staff,
      active: '/master/members',
      body: `
      <header class="head">
        <p class="head__eyebrow mono">MASTER <s>//</s> PARTICIPANTS</p>
        <h1 class="head__title">Participants</h1>
      </header>

      <form class="searchbar" method="get" action="/master/members">
        <input type="hidden" name="filter" value="${esc(filter)}" />
        <input class="f__input" type="search" name="q" value="${esc(q)}"
               placeholder="Search name or email" aria-label="Search participants" />
        <button class="btn btn--sm btn--solid" type="submit">Search</button>
      </form>

      <nav class="tabs">${tabs}</nav>

      ${card(`${rows.length} participant${rows.length === 1 ? '' : 's'}`, rows.length ? `
        <table class="table">
          <thead><tr>
            <th>Participant</th><th>Plan</th><th>Status</th>
            <th class="num">Owed</th><th>Last paid</th><th>Joined</th><th></th>
          </tr></thead>
          <tbody>${rows.map((r) => `
            <tr>
              <td>
                <span class="who2">
                  <img src="/assets/avatars/${esc(r.avatar_key)}.svg" alt="" width="26" height="26" />
                  <span>
                    <a href="/master/members/${esc(r.id)}">${esc(r.first_name)} ${esc(r.last_name)}</a>
                    <small class="mono muted">${esc(r.email)}</small>
                  </span>
                </span>
              </td>
              <td class="mono muted">${esc(r.plan_name || 'none')}</td>
              <td>${statusPill(r.sub_status || r.status)}</td>
              <td class="num">${r.outstanding > 0
                ? `<span class="owed">${esc(money(r.outstanding))}</span>`
                : '<span class="muted">—</span>'}</td>
              <td class="mono muted">${esc(r.last_paid ? shortDate(r.last_paid) : 'never')}</td>
              <td class="mono muted">${esc(shortDate(r.created_at))}</td>
              <td class="num"><a class="btn btn--sm btn--ghost" href="/master/members/${esc(r.id)}">Open</a></td>
            </tr>`).join('')}</tbody>
        </table>` : empty('NOBODY MATCHES THAT.'))}`,
    }));
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------- participant detail -- */

masterRouter.get('/master/members/:id', async (req, res, next) => {
  try {
    const member = await one('SELECT * FROM members WHERE id = $1', [req.params.id]);
    if (!member) return next();

    const [sub, invoices, payments, consents, requests, bookings] = await Promise.all([
      one(`SELECT s.*, p.name AS plan_name, p.code AS plan_code,
                  p.price_pence AS list_price_pence
             FROM subscriptions s JOIN plans p ON p.id = s.plan_id
            WHERE s.member_id = $1 ORDER BY s.created_at DESC LIMIT 1`, [member.id]),
      query(`SELECT * FROM invoice_balances WHERE member_id = $1
              ORDER BY issued_at DESC LIMIT 24`, [member.id]),
      query(`SELECT pay.*, su.name AS staff_name, i.number
               FROM payments pay
               LEFT JOIN staff_users su ON su.id = pay.recorded_by
               LEFT JOIN invoices i ON i.id = pay.invoice_id
              WHERE pay.member_id = $1 ORDER BY pay.processed_at DESC LIMIT 20`, [member.id]),
      query('SELECT purpose, granted, created_at FROM current_consents WHERE member_id = $1', [member.id]),
      query(`SELECT type, status, requested_at, due_at FROM data_requests
              WHERE member_id = $1 ORDER BY requested_at DESC LIMIT 5`, [member.id]),
      one(`SELECT count(*) FILTER (WHERE status='attended')::int AS attended,
                  count(*) FILTER (WHERE status='no_show')::int  AS no_shows
             FROM bookings WHERE member_id = $1`, [member.id]),
    ]);

    const owed = invoices
      .filter((i) => ['open', 'draft'].includes(i.status))
      .reduce((sum, i) => sum + i.outstanding_pence, 0);

    const invoiceRows = invoices.length ? `
      <table class="table">
        <thead><tr><th>Invoice</th><th>Issued</th><th>Due</th><th>Status</th>
          <th class="num">Total</th><th class="num">Paid</th><th class="num">Owed</th><th></th></tr></thead>
        <tbody>${invoices.map((i) => `
          <tr>
            <td class="mono">${esc(i.number)}</td>
            <td class="mono muted">${esc(shortDate(i.issued_at))}</td>
            <td class="mono muted">${esc(shortDate(i.due_at))}${i.is_overdue ? ` <span class="owed">${i.days_overdue}d</span>` : ''}</td>
            <td>${statusPill(i.status)}</td>
            <td class="num">${esc(money(i.total_pence))}</td>
            <td class="num">${esc(money(i.paid_pence))}</td>
            <td class="num">${i.outstanding_pence > 0
              ? `<span class="owed">${esc(money(i.outstanding_pence))}</span>` : '—'}</td>
            <td class="num">${i.outstanding_pence > 0 && i.status !== 'void'
              ? `<a class="btn btn--sm btn--solid" href="/master/reconciliation#inv-${esc(i.invoice_id)}">Record</a>`
              : ''}</td>
          </tr>`).join('')}</tbody>
      </table>` : empty('NO INVOICES.');

    const paymentRows = payments.length ? `
      <table class="table">
        <thead><tr><th>When</th><th>Invoice</th><th>Method</th><th>Reference</th><th>Taken by</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody>${payments.map((p) => `
          <tr>
            <td class="mono muted">${esc(longDateTime(p.processed_at))}</td>
            <td class="mono">${esc(p.number || '—')}</td>
            <td class="mono">${esc(p.method.replace(/_/g, ' '))}</td>
            <td class="mono muted">${esc(p.reference || '—')}${p.note ? `<br /><small>${esc(p.note)}</small>` : ''}</td>
            <td class="mono muted">${esc(p.staff_name || 'processor')}</td>
            <td>${statusPill(p.status)}</td>
            <td class="num">${esc(money(p.amount_pence))}</td>
            <td class="num">${p.status === 'succeeded' && req.staff.role === 'admin' ? `
              <form method="post" action="/master/payments/${esc(p.id)}/reverse" class="inline">
                ${csrf(req.staff.csrf_token)}
                <button class="btn btn--sm btn--danger" type="submit">Reverse</button>
              </form>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table>` : empty('NO PAYMENTS.');

    res.send(masterPage({
      title: `${member.first_name} ${member.last_name}`,
      staff: req.staff,
      active: '/master/members',
      flash: FLASH[req.query.done] || null,
      body: `
      <header class="head">
        <p class="head__eyebrow mono"><a href="/master/members">PARTICIPANTS</a> <s>//</s> RECORD</p>
        <h1 class="head__title">
          <img class="head__face" src="/assets/avatars/${esc(member.avatar_key)}.svg" alt="" width="52" height="55" />
          ${esc(member.first_name)} ${esc(member.last_name)}
        </h1>
      </header>

      ${member.erasure_due_at && !member.erased_at ? `
        <div class="banner banner--bad">
          <strong>Erasure scheduled.</strong> Personal data is deleted on
          ${esc(shortDate(member.erasure_due_at))}. Settle anything outstanding before then.
        </div>` : ''}

      <div class="tiles">
        <div class="tile">
          <p class="tile__k mono">MEMBERSHIP</p>
          <p class="tile__v">${esc(sub?.plan_name || 'None')}</p>
          <p class="tile__sub mono">${sub ? statusPill(sub.status) : 'NOT SUBSCRIBED'}</p>
        </div>
        <div class="tile${owed > 0 ? ' tile--warn' : ''}">
          <p class="tile__k mono">OUTSTANDING</p>
          <p class="tile__v">${esc(money(owed))}</p>
          <p class="tile__sub mono">${owed > 0 ? 'NEEDS CHASING' : 'SQUARE WITH US'}</p>
        </div>
        <div class="tile">
          <p class="tile__k mono">ATTENDED</p>
          <p class="tile__v">${bookings.attended}</p>
          <p class="tile__sub mono">${bookings.no_shows} NO SHOWS</p>
        </div>
        <div class="tile">
          <p class="tile__k mono">MEMBER SINCE</p>
          <p class="tile__v">${esc(String(new Date(member.created_at).getFullYear()))}</p>
          <p class="tile__sub mono">${esc(shortDate(member.created_at))}</p>
        </div>
      </div>

      ${sub ? card('Membership', `
        <dl class="kv mono">
          <div><dt>PLAN</dt><dd><a href="/master/plans#plan-${esc(sub.plan_id)}">${esc(sub.plan_name)}</a></dd></div>
          <div><dt>PAYING</dt><dd>${esc(money(sub.price_pence))} <span class="muted">PER ${esc(sub.billing_interval).toUpperCase()}</span></dd></div>
          <div><dt>LIST PRICE</dt><dd>${esc(money(sub.list_price_pence))}${sub.price_pence !== sub.list_price_pence
            ? ` <span class="owed">${sub.price_pence < sub.list_price_pence ? 'HELD BELOW LIST' : 'ABOVE LIST'}</span>` : ''}</dd></div>
          <div><dt>PERIOD ENDS</dt><dd>${esc(shortDate(sub.current_period_end))}</dd></div>
          <div><dt>RENEWS</dt><dd>${sub.cancel_at_period_end ? 'NO, ENDS AT PERIOD END' : 'YES'}</dd></div>
        </dl>
        ${req.staff.role === 'admin' ? `
        <form method="post" action="/master/members/${esc(member.id)}/price" class="raterow">
          ${csrf(req.staff.csrf_token)}
          <div class="f">
            <label class="f__label mono" for="f-rate">SET THIS MEMBERSHIP'S OWN RATE</label>
            <div class="price2__amt">
              <span class="mono">£</span>
              <input class="f__input" id="f-rate" name="price" type="text" inputmode="decimal"
                     value="${(sub.price_pence / 100).toFixed(2)}" />
            </div>
          </div>
          <div class="f">
            <label class="f__label mono" for="f-rate-why">WHY</label>
            <input class="f__input" id="f-rate-why" name="reason" type="text"
                   placeholder="Concession, second family member, hardship" />
          </div>
          <button class="btn btn--sm btn--solid" type="submit">Set rate</button>
        </form>
        <p class="muted small">
          A concession set here is theirs until somebody changes it. Raising the
          plan does not overwrite it unless the change is applied to everyone.
        </p>` : ''}`) : ''}

      ${card('Contact', `
        <dl class="kv mono">
          <div><dt>EMAIL</dt><dd>${esc(member.email)}</dd></div>
          <div><dt>PHONE</dt><dd>${esc(member.phone || '—')}</dd></div>
          <div><dt>ADDRESS</dt><dd>${esc([member.address_line1, member.city, member.postcode].filter(Boolean).join(', ') || '—')}</dd></div>
          <div><dt>IN AN EMERGENCY</dt><dd>${esc(member.emergency_contact_name || '—')} ${esc(member.emergency_contact_phone || '')}</dd></div>
          <div><dt>MEDICAL NOTES</dt><dd>${member.medical_notes ? esc(member.medical_notes) : '<span class="muted">none recorded</span>'}</dd></div>
        </dl>
        <p class="muted small">
          Staff can read this record but cannot edit a participant's own details
          from here. Corrections belong to the member, under Article 16, and they
          make them from their own profile.
        </p>`)}

      ${card('Invoices', invoiceRows)}
      ${card('Payments', paymentRows)}

      ${card('Permissions and requests', `
        <dl class="kv mono">
          ${consents.map((c) => `
            <div><dt>${esc(c.purpose.replace(/_/g, ' ').toUpperCase())}</dt>
                <dd>${c.granted ? '<span class="pill pill--ok">granted</span>' : '<span class="pill pill--muted">withdrawn</span>'}
                    <span class="muted">${esc(shortDate(c.created_at))}</span></dd></div>`).join('')}
        </dl>
        ${requests.length ? `
        <table class="table">
          <thead><tr><th>Request</th><th>Raised</th><th>Due</th><th>Status</th></tr></thead>
          <tbody>${requests.map((r) => `
            <tr><td class="mono">${esc(r.type)}</td>
                <td class="mono muted">${esc(shortDate(r.requested_at))}</td>
                <td class="mono muted">${esc(shortDate(r.due_at))}</td>
                <td>${statusPill(r.status)}</td></tr>`).join('')}</tbody>
        </table>` : ''}`)}`,
    }));
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------- reconciliation -- */

masterRouter.get('/master/reconciliation', async (req, res, next) => {
  try {
    const open = await query(`
      SELECT b.*, m.first_name, m.last_name, m.avatar_key, m.email
        FROM invoice_balances b
        JOIN members m ON m.id = b.member_id
       WHERE b.status IN ('open', 'draft')
         AND b.outstanding_pence > 0
         AND m.status <> 'erased'
       ORDER BY b.is_overdue DESC, b.due_at ASC
       LIMIT 100`);

    const totals = open.reduce((acc, i) => ({
      owed: acc.owed + i.outstanding_pence,
      overdue: acc.overdue + (i.is_overdue ? i.outstanding_pence : 0),
    }), { owed: 0, overdue: 0 });

    const rows = open.length ? open.map((i) => `
      <li class="recon" id="inv-${esc(i.invoice_id)}">
        <div class="recon__who">
          <span class="who2">
            <img src="/assets/avatars/${esc(i.avatar_key)}.svg" alt="" width="32" height="32" />
            <span>
              <a href="/master/members/${esc(i.member_id)}">${esc(i.first_name)} ${esc(i.last_name)}</a>
              <small class="mono muted">${esc(i.number)} <s>·</s> DUE ${esc(shortDate(i.due_at))}${i.is_overdue ? ` <span class="owed">${i.days_overdue}d LATE</span>` : ''}</small>
            </span>
          </span>
        </div>

        <div class="recon__sums mono">
          <span>TOTAL ${esc(money(i.total_pence))}</span>
          <span>PAID ${esc(money(i.paid_pence))}</span>
          <span class="owed">OWED ${esc(money(i.outstanding_pence))}</span>
        </div>

        <form class="recon__form" method="post" action="/master/invoices/${esc(i.invoice_id)}/payments">
          ${csrf(req.staff.csrf_token)}
          <label class="sr-only" for="amt-${esc(i.invoice_id)}">Amount received</label>
          <input class="f__input" id="amt-${esc(i.invoice_id)}" name="amount" type="text" inputmode="decimal"
                 value="${(i.outstanding_pence / 100).toFixed(2)}" aria-label="Amount received" />
          <label class="sr-only" for="mth-${esc(i.invoice_id)}">Method</label>
          <select class="f__input" id="mth-${esc(i.invoice_id)}" name="method" aria-label="Method">
            <option value="cash">Cash</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="card_terminal">Card terminal</option>
          </select>
          <label class="sr-only" for="ref-${esc(i.invoice_id)}">Reference</label>
          <input class="f__input" id="ref-${esc(i.invoice_id)}" name="reference" type="text"
                 placeholder="Slip or reference" aria-label="Reference" />
          <button class="btn btn--sm btn--solid" type="submit">Record</button>
        </form>
      </li>`).join('') : '';

    res.send(masterPage({
      title: 'Reconciliation',
      staff: req.staff,
      active: '/master/reconciliation',
      flash: FLASH[req.query.done] || null,
      body: `
      <header class="head">
        <p class="head__eyebrow mono">MASTER <s>//</s> RECONCILIATION</p>
        <h1 class="head__title">Money Taken<br />Off the Rails</h1>
        <p class="head__lede">
          Cash at the door, a bank transfer, a card terminal receipt. Put it
          against the invoice it belongs to. Every entry is stamped with your
          name, and a mistake is corrected with a reversal rather than a delete.
        </p>
      </header>

      <div class="tiles tiles--two">
        <div class="tile">
          <p class="tile__k mono">OPEN INVOICES</p>
          <p class="tile__v">${open.length}</p>
          <p class="tile__sub mono">${esc(money(totals.owed))} OUTSTANDING</p>
        </div>
        <div class="tile${totals.overdue ? ' tile--warn' : ''}">
          <p class="tile__k mono">PAST THE DUE DATE</p>
          <p class="tile__v">${esc(money(totals.overdue))}</p>
        </div>
      </div>

      ${card('Awaiting payment', rows
        ? `<ul class="reconlist">${rows}</ul>`
        : empty('EVERY INVOICE IS SETTLED.'))}`,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * Parse "12.50", "£12.50", "1,250.00" into pence. Returns null for anything
 * that is not money, so a typo cannot become a payment.
 *
 * Exported for the tests: this is the one pure function in reconciliation and
 * getting it wrong means taking the wrong amount off somebody.
 */
export function toPence(input) {
  const cleaned = String(input || '').replace(/[£\s,]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

const OFFLINE_METHODS = new Set(['cash', 'bank_transfer', 'card_terminal']);

masterRouter.post('/master/invoices/:id/payments', requireStaffCsrf, async (req, res, next) => {
  try {
    const amount = toPence(req.body.amount);
    const method = OFFLINE_METHODS.has(str(req.body.method, 20)) ? str(req.body.method, 20) : 'cash';
    const reference = str(req.body.reference, 80);
    const back = str(req.get('referer') || '', 300).includes('/members/')
      ? `/master/members` : '/master/reconciliation';

    if (!amount || amount <= 0) return res.redirect('/master/reconciliation?done=nothing');

    const result = await transaction(async (tx) => {
      // Lock the invoice: two coaches must not both record the same cash.
      const invoice = await tx.one(
        'SELECT * FROM invoices WHERE id = $1 FOR UPDATE',
        [req.params.id]
      );
      if (!invoice || invoice.status === 'void') return null;

      const sums = await tx.one(
        `SELECT COALESCE(SUM(amount_pence), 0)::int AS paid
           FROM payments WHERE invoice_id = $1 AND status = 'succeeded'`,
        [invoice.id]
      );

      await tx.query(
        `INSERT INTO payments (invoice_id, member_id, amount_pence, status, method,
                               reference, note, recorded_by, processed_at)
         VALUES ($1, $2, $3, 'succeeded', $4, $5, $6, $7, now())`,
        [invoice.id, invoice.member_id, amount, method, reference,
         'Recorded by staff at the club', req.staff.staff_id]
      );

      const paid = sums.paid + amount;
      if (paid >= invoice.total_pence) {
        await tx.query(
          `UPDATE invoices SET status = 'paid', paid_at = now() WHERE id = $1`,
          [invoice.id]
        );
        // Clearing the arrears puts the membership back in good standing.
        await tx.query(
          `UPDATE subscriptions SET status = 'active', updated_at = now()
            WHERE member_id = $1 AND status = 'past_due'`,
          [invoice.member_id]
        );
      }
      return { invoice, paid };
    });

    if (!result) return res.redirect('/master/reconciliation?done=nothing');

    await staffAudit(req, {
      action: 'billing.payment_recorded',
      memberId: result.invoice.member_id,
      entity: 'invoice', entityId: result.invoice.id,
      metadata: { amount_pence: amount, method, reference, invoice: result.invoice.number },
    });

    res.redirect(back === '/master/members'
      ? `/master/members/${result.invoice.member_id}?done=recorded`
      : '/master/reconciliation?done=recorded');
  } catch (err) {
    next(err);
  }
});

/**
 * Reverse a payment. Admins only, and it writes a second row rather than
 * touching the first: the ledger stays append-only.
 */
masterRouter.post('/master/payments/:id/reverse', requireStaffCsrf, requireAdmin, async (req, res, next) => {
  try {
    const memberId = await transaction(async (tx) => {
      const payment = await tx.one(
        `SELECT * FROM payments WHERE id = $1 AND status = 'succeeded' FOR UPDATE`,
        [req.params.id]
      );
      if (!payment) return null;

      await tx.query(`UPDATE payments SET status = 'refunded' WHERE id = $1`, [payment.id]);
      await tx.query(
        `INSERT INTO payments (invoice_id, member_id, amount_pence, status, method,
                               reference, note, recorded_by, processed_at)
         VALUES ($1, $2, $3, 'refunded', $4, $5, $6, $7, now())`,
        [payment.invoice_id, payment.member_id, -payment.amount_pence, payment.method,
         payment.reference, `Reversal of ${payment.id}`, req.staff.staff_id]
      );

      if (payment.invoice_id) {
        // The invoice is owed again.
        await tx.query(
          `UPDATE invoices SET status = 'open', paid_at = NULL WHERE id = $1`,
          [payment.invoice_id]
        );
      }
      return payment.member_id;
    });

    if (!memberId) return res.redirect('/master?done=nothing');

    await staffAudit(req, {
      action: 'billing.payment_reversed',
      memberId, entity: 'payment', entityId: req.params.id,
    });
    res.redirect(`/master/members/${memberId}?done=reversed`);
  } catch (err) {
    next(err);
  }
});
