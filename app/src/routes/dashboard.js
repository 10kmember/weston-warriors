/**
 * Overview and class booking.
 */

import express from 'express';
import { query, one, transaction } from '../db.js';
import { requireAuth, requireCsrf, audit } from '../auth.js';
import {
  page, esc, money, shortDate, longDateTime, timeOnly, statusPill, card, csrf, empty,
} from '../views/layout.js';

export const dashboardRouter = express.Router();
// Scoped to the prefix: an unscoped router.use() would guard every request that
// passes through this router, including the static marketing site at /.
dashboardRouter.use('/dashboard', requireAuth);

/* ------------------------------------------------------------ overview --- */

dashboardRouter.get('/dashboard', async (req, res, next) => {
  try {
    const memberId = req.session.member_id;

    const [subscription, nextInvoice, recentInvoices, upcoming, attendance, openRequests] =
      await Promise.all([
        one(
          `SELECT s.*, p.name AS plan_name, p.code AS plan_code,
                  s.price_pence, s.billing_interval
             FROM subscriptions s
             JOIN plans p ON p.id = s.plan_id
            WHERE s.member_id = $1
              AND s.status IN ('trialing','active','past_due','paused')
            ORDER BY s.created_at DESC LIMIT 1`,
          [memberId]
        ),
        one(
          `SELECT * FROM invoices
            WHERE member_id = $1 AND status IN ('open','draft')
            ORDER BY due_at ASC NULLS LAST LIMIT 1`,
          [memberId]
        ),
        query(
          `SELECT id, number, status, total_pence, issued_at, due_at, paid_at
             FROM invoices WHERE member_id = $1
            ORDER BY issued_at DESC LIMIT 5`,
          [memberId]
        ),
        query(
          `SELECT c.id, c.title, c.coach, c.starts_at, c.ends_at, c.location, b.status
             FROM bookings b
             JOIN class_sessions c ON c.id = b.class_session_id
            WHERE b.member_id = $1 AND b.status = 'booked' AND c.starts_at > now()
            ORDER BY c.starts_at ASC LIMIT 4`,
          [memberId]
        ),
        one(
          `SELECT
             count(*) FILTER (WHERE b.status = 'attended')  AS attended,
             count(*) FILTER (WHERE b.status = 'no_show')   AS no_shows,
             count(*) FILTER (WHERE b.status = 'attended'
                              AND c.starts_at > now() - interval '30 days') AS last_30
             FROM bookings b JOIN class_sessions c ON c.id = b.class_session_id
            WHERE b.member_id = $1`,
          [memberId]
        ),
        query(
          `SELECT type, status, requested_at, due_at FROM data_requests
            WHERE member_id = $1 AND status IN ('pending','in_progress')
            ORDER BY requested_at DESC`,
          [memberId]
        ),
      ]);

    const welcome = req.query.welcome === '1';

    const tiles = `
    <div class="tiles">
      <div class="tile">
        <p class="tile__k mono">MEMBERSHIP</p>
        <p class="tile__v">${subscription ? esc(subscription.plan_name) : 'None'}</p>
        <p class="tile__sub mono">${subscription ? statusPill(subscription.status) : 'NOT SUBSCRIBED'}</p>
      </div>
      <div class="tile">
        <p class="tile__k mono">NEXT PAYMENT</p>
        <p class="tile__v">${nextInvoice ? money(nextInvoice.total_pence) : '—'}</p>
        <p class="tile__sub mono">${nextInvoice ? `DUE ${esc(shortDate(nextInvoice.due_at))}` : 'NOTHING OUTSTANDING'}</p>
      </div>
      <div class="tile">
        <p class="tile__k mono">SESSIONS ATTENDED</p>
        <p class="tile__v">${Number(attendance?.attended || 0)}</p>
        <p class="tile__sub mono">${Number(attendance?.last_30 || 0)} IN THE LAST 30 DAYS</p>
      </div>
      <div class="tile">
        <p class="tile__k mono">BOOKED AHEAD</p>
        <p class="tile__v">${upcoming.length}</p>
        <p class="tile__sub mono">${upcoming.length ? `NEXT ${esc(shortDate(upcoming[0].starts_at))}` : 'NOTHING BOOKED'}</p>
      </div>
    </div>`;

    const upcomingBody = upcoming.length ? `
      <ul class="list">
        ${upcoming.map((c) => `
        <li class="list__row">
          <div>
            <p class="list__title">${esc(c.title)}</p>
            <p class="list__meta mono">${esc(shortDate(c.starts_at))} · ${esc(timeOnly(c.starts_at))}–${esc(timeOnly(c.ends_at))} · ${esc(c.coach)}</p>
          </div>
          <span class="list__side mono">${esc(c.location)}</span>
        </li>`).join('')}
      </ul>` : empty('NOTHING BOOKED. THE TIMETABLE IS UNDER CLASSES.');

    const invoiceBody = recentInvoices.length ? `
      <table class="table">
        <thead><tr><th>Invoice</th><th>Issued</th><th>Status</th><th class="num">Total</th></tr></thead>
        <tbody>
          ${recentInvoices.map((i) => `
          <tr>
            <td><a href="/dashboard/billing/invoices/${esc(i.id)}">${esc(i.number)}</a></td>
            <td>${esc(shortDate(i.issued_at))}</td>
            <td>${statusPill(i.status)}</td>
            <td class="num">${esc(money(i.total_pence))}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : empty('NO INVOICES YET.');

    const requestsNote = openRequests.length ? `
      <div class="banner banner--warn">
        You have ${openRequests.length} open data request${openRequests.length > 1 ? 's' : ''}.
        The club must respond by ${esc(shortDate(openRequests[0].due_at))}.
        <a href="/dashboard/privacy">View</a>
      </div>` : '';

    res.send(page({
      title: 'Overview',
      member: req.session,
      active: '/dashboard',
      flash: welcome ? { kind: 'ok', message: 'Account created. Welcome to the club.' } : null,
      body: `
      <header class="head">
        <p class="head__eyebrow mono">MEMBER AREA</p>
        <h1 class="head__title">Good to see you, ${esc(req.session.first_name || 'fighter')}</h1>
      </header>
      ${requestsNote}
      ${tiles}
      <div class="cols">
        ${card('Next on the timetable', upcomingBody, {
          action: '<a class="btn btn--sm btn--ghost" href="/dashboard/classes">Book a class</a>',
        })}
        ${card('Recent invoices', invoiceBody, {
          action: '<a class="btn btn--sm btn--ghost" href="/dashboard/billing">All billing</a>',
        })}
      </div>`,
    }));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------- classes --- */

dashboardRouter.get('/dashboard/classes', async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const classes = await query(
      `SELECT c.*,
              count(b.id) FILTER (WHERE b.status IN ('booked','attended')) AS taken,
              bool_or(b.member_id = $1 AND b.status = 'booked') AS mine
         FROM class_sessions c
         LEFT JOIN bookings b ON b.class_session_id = c.id
        WHERE c.starts_at > now() AND c.starts_at < now() + interval '14 days'
        GROUP BY c.id
        ORDER BY c.starts_at ASC`,
      [memberId]
    );

    const history = await query(
      `SELECT c.title, c.starts_at, b.status
         FROM bookings b JOIN class_sessions c ON c.id = b.class_session_id
        WHERE b.member_id = $1 AND c.starts_at <= now()
        ORDER BY c.starts_at DESC LIMIT 8`,
      [memberId]
    );

    const byDay = new Map();
    for (const c of classes) {
      const key = shortDate(c.starts_at);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(c);
    }

    const timetable = byDay.size ? [...byDay.entries()].map(([day, items]) => `
      <div class="day">
        <p class="day__label mono">${esc(day)}</p>
        <ul class="list">
          ${items.map((c) => {
            const full = Number(c.taken) >= c.capacity;
            const mine = c.mine === true;
            return `
            <li class="list__row">
              <div>
                <p class="list__title">${esc(c.title)}</p>
                <p class="list__meta mono">
                  ${esc(timeOnly(c.starts_at))}–${esc(timeOnly(c.ends_at))} ·
                  ${esc(c.coach)} · ${esc(c.level)} ·
                  ${Number(c.taken)}/${c.capacity} PLACES
                </p>
              </div>
              <form method="post" action="/dashboard/classes/${esc(c.id)}/${mine ? 'cancel' : 'book'}">
                ${csrf(req.session.csrf_token)}
                <button class="btn btn--sm ${mine ? 'btn--ghost' : 'btn--solid'}"
                        type="submit" ${!mine && full ? 'disabled' : ''}>
                  ${mine ? 'Cancel' : full ? 'Full' : 'Book'}
                </button>
              </form>
            </li>`;
          }).join('')}
        </ul>
      </div>`).join('') : empty('NO CLASSES SCHEDULED IN THE NEXT TWO WEEKS.');

    const historyBody = history.length ? `
      <table class="table">
        <thead><tr><th>Class</th><th>Date</th><th>Result</th></tr></thead>
        <tbody>${history.map((h) => `
          <tr><td>${esc(h.title)}</td><td>${esc(shortDate(h.starts_at))}</td><td>${statusPill(h.status)}</td></tr>
        `).join('')}</tbody>
      </table>` : empty('NO ATTENDANCE RECORDED YET.');

    res.send(page({
      title: 'Classes',
      member: req.session,
      active: '/dashboard/classes',
      flash: req.query.booked ? { kind: 'ok', message: 'Booked. Turn up ten minutes early and wrapped.' }
           : req.query.cancelled ? { kind: 'ok', message: 'Booking cancelled.' }
           : req.query.full ? { kind: 'bad', message: 'That class filled up before your booking landed.' }
           : null,
      body: `
      <header class="head">
        <p class="head__eyebrow mono">04 <s>//</s> TIMETABLE</p>
        <h1 class="head__title">Classes</h1>
        <p class="head__lede">The next fortnight. Cancel at least two hours before if you cannot make it, so somebody else can take the place.</p>
      </header>
      ${timetable}
      ${card('Your attendance', historyBody)}`,
    }));
  } catch (err) {
    next(err);
  }
});

dashboardRouter.post('/dashboard/classes/:id/book', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const classId = req.params.id;

    const outcome = await transaction(async (tx) => {
      // Lock the class row so two people cannot take the last place at once.
      const cls = await tx.one(
        'SELECT id, capacity FROM class_sessions WHERE id = $1 AND starts_at > now() FOR UPDATE',
        [classId]
      );
      if (!cls) return 'missing';

      const count = await tx.one(
        `SELECT count(*)::int AS taken FROM bookings
          WHERE class_session_id = $1 AND status IN ('booked','attended')`,
        [classId]
      );
      if (count.taken >= cls.capacity) return 'full';

      await tx.query(
        `INSERT INTO bookings (class_session_id, member_id, status)
         VALUES ($1, $2, 'booked')
         ON CONFLICT (class_session_id, member_id)
         DO UPDATE SET status = 'booked', booked_at = now(), cancelled_at = NULL`,
        [classId, memberId]
      );
      return 'booked';
    });

    if (outcome === 'booked') {
      await audit(req, { memberId, action: 'class.booked', entity: 'class_session', entityId: classId });
      return res.redirect('/dashboard/classes?booked=1');
    }
    if (outcome === 'full') return res.redirect('/dashboard/classes?full=1');
    res.redirect('/dashboard/classes');
  } catch (err) {
    next(err);
  }
});

dashboardRouter.post('/dashboard/classes/:id/cancel', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    await query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now()
        WHERE class_session_id = $1 AND member_id = $2 AND status = 'booked'`,
      [req.params.id, memberId]
    );
    await audit(req, { memberId, action: 'class.cancelled', entity: 'class_session', entityId: req.params.id });
    res.redirect('/dashboard/classes?cancelled=1');
  } catch (err) {
    next(err);
  }
});
