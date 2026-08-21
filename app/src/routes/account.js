/**
 * Membership, billing and profile.
 *
 * Billing here is a ledger, not a payment integration. Plan changes and
 * cancellations write real rows and real invoices; taking money is left to a
 * processor, and the seam is marked where it would go.
 */

import express from 'express';
import { query, one, transaction } from '../db.js';
import { requireAuth, requireCsrf, audit } from '../auth.js';
import { str, Errors, POSTCODE_RE } from '../validate.js';
import { AVATARS, AVATAR_CREDIT, isAvatarKey, avatarSrc } from '../avatars.js';
import {
  page, esc, money, shortDate, longDateTime, statusPill, card, csrf, field, textarea, empty,
} from '../views/layout.js';

export const accountRouter = express.Router();
accountRouter.use('/dashboard', requireAuth);

const liveSubscription = (memberId) => one(
  `SELECT s.*, p.name AS plan_name, p.code AS plan_code, p.price_pence,
          p.billing_interval, p.features
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.member_id = $1 AND s.status IN ('trialing','active','past_due','paused')
    ORDER BY s.created_at DESC LIMIT 1`,
  [memberId]
);

/* -------------------------------------------------------- subscription --- */

accountRouter.get('/dashboard/subscription', async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const [subscription, plans, history] = await Promise.all([
      liveSubscription(memberId),
      query('SELECT * FROM plans WHERE is_active ORDER BY sort_order, price_pence'),
      query(
        `SELECT s.status, s.started_at, s.cancelled_at, p.name AS plan_name
           FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.member_id = $1 ORDER BY s.created_at DESC`,
        [memberId]
      ),
    ]);

    const current = subscription ? `
      <div class="sub">
        <div class="sub__main">
          <p class="sub__k mono">CURRENT PLAN</p>
          <h3 class="sub__plan">${esc(subscription.plan_name)}</h3>
          <p class="sub__price">${esc(money(subscription.price_pence))}<span class="mono">/${esc(subscription.billing_interval).toUpperCase()}</span></p>
          <p class="sub__status">${statusPill(subscription.status)}</p>
        </div>
        <dl class="sub__meta mono">
          <div><dt>STARTED</dt><dd>${esc(shortDate(subscription.started_at))}</dd></div>
          <div><dt>PERIOD ENDS</dt><dd>${esc(shortDate(subscription.current_period_end))}</dd></div>
          <div><dt>RENEWS</dt><dd>${subscription.cancel_at_period_end ? 'NO, ENDS AT PERIOD END' : 'YES, AUTOMATICALLY'}</dd></div>
        </dl>
      </div>

      ${subscription.cancel_at_period_end ? `
      <div class="banner banner--warn">
        This membership ends on ${esc(shortDate(subscription.current_period_end))} and will not renew.
        <form method="post" action="/dashboard/subscription/resume" class="inline">
          ${csrf(req.session.csrf_token)}
          <button class="linkbtn" type="submit">Keep my membership</button>
        </form>
      </div>` : ''}
    ` : `
      <div class="banner banner--warn">
        You do not have an active membership. Pick a plan below to start one.
      </div>`;

    const planCards = plans.map((p) => {
      const isCurrent = subscription && subscription.plan_id === p.id;
      const features = Array.isArray(p.features) ? p.features : [];
      return `
      <article class="plan${isCurrent ? ' plan--current' : ''}">
        <p class="plan__tag mono">${esc(p.code).toUpperCase()}${isCurrent ? ' <s>·</s> CURRENT' : ''}</p>
        <h3 class="plan__name">${esc(p.name)}</h3>
        <p class="plan__price">${esc(money(p.price_pence))}<span class="mono">/${esc(p.billing_interval).toUpperCase()}</span></p>
        <ul class="plan__list">${features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        ${isCurrent ? '<p class="plan__note mono">YOU ARE ON THIS PLAN</p>' : `
        <form method="post" action="/dashboard/subscription/change">
          ${csrf(req.session.csrf_token)}
          <input type="hidden" name="plan_id" value="${esc(p.id)}" />
          <button class="btn btn--sm btn--full ${subscription ? 'btn--ghost' : 'btn--solid'}" type="submit">
            ${subscription ? (p.price_pence > subscription.price_pence ? 'Upgrade' : 'Switch') : 'Start'}
          </button>
        </form>`}
      </article>`;
    }).join('');

    const historyBody = history.length ? `
      <table class="table">
        <thead><tr><th>Plan</th><th>Started</th><th>Status</th><th>Ended</th></tr></thead>
        <tbody>${history.map((h) => `
          <tr>
            <td>${esc(h.plan_name)}</td>
            <td>${esc(shortDate(h.started_at))}</td>
            <td>${statusPill(h.status)}</td>
            <td>${esc(h.cancelled_at ? shortDate(h.cancelled_at) : '—')}</td>
          </tr>`).join('')}</tbody>
      </table>` : empty('NO MEMBERSHIP HISTORY.');

    res.send(page({
      title: 'Membership',
      member: req.session,
      active: '/dashboard/subscription',
      flash: req.query.changed ? { kind: 'ok', message: 'Plan changed. The next invoice reflects the new rate.' }
           : req.query.cancelled ? { kind: 'ok', message: 'Cancellation scheduled for the end of the current period.' }
           : req.query.resumed ? { kind: 'ok', message: 'Good. Your membership will renew as normal.' }
           : null,
      body: `
      <header class="head">
        <p class="head__eyebrow mono">MEMBERSHIP</p>
        <h1 class="head__title">Your Membership</h1>
      </header>
      ${current}
      ${card('Plans', `<div class="plans">${planCards}</div>`)}
      ${card('History', historyBody)}
      ${subscription && !subscription.cancel_at_period_end ? card('Cancel', `
        <p class="muted">
          Cancelling stops the renewal. You keep access until
          ${esc(shortDate(subscription.current_period_end))}, and nothing further is charged.
          Your invoices stay in your account because the club has to keep
          financial records for six years.
        </p>
        <form method="post" action="/dashboard/subscription/cancel" class="mt">
          ${csrf(req.session.csrf_token)}
          <button class="btn btn--sm btn--danger" type="submit">Cancel at period end</button>
        </form>`, { tone: 'danger' }) : ''}`,
    }));
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/dashboard/subscription/change', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const planId = str(req.body.plan_id, 64);
    const plan = await one('SELECT * FROM plans WHERE id = $1 AND is_active', [planId]);
    if (!plan) return res.redirect('/dashboard/subscription');

    await transaction(async (tx) => {
      const existing = await tx.one(
        `SELECT * FROM subscriptions
          WHERE member_id = $1 AND status IN ('trialing','active','past_due','paused')
          FOR UPDATE`,
        [memberId]
      );

      if (existing) {
        await tx.query(
          `UPDATE subscriptions
              SET plan_id = $1, cancel_at_period_end = false, updated_at = now()
            WHERE id = $2`,
          [plan.id, existing.id]
        );
      } else {
        await tx.query(
          `INSERT INTO subscriptions (member_id, plan_id, status, started_at,
                                      current_period_start, current_period_end)
           VALUES ($1, $2, 'active', now(), now(), now() + interval '1 month')`,
          [memberId, plan.id]
        );
      }
    });

    await audit(req, {
      memberId, action: 'subscription.changed', entity: 'plan', entityId: plan.id,
      metadata: { plan: plan.code, price_pence: plan.price_pence },
    });
    res.redirect('/dashboard/subscription?changed=1');
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/dashboard/subscription/cancel', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    await query(
      `UPDATE subscriptions SET cancel_at_period_end = true, updated_at = now()
        WHERE member_id = $1 AND status IN ('trialing','active','past_due','paused')`,
      [memberId]
    );
    await audit(req, { memberId, action: 'subscription.cancel_scheduled' });
    res.redirect('/dashboard/subscription?cancelled=1');
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/dashboard/subscription/resume', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    await query(
      `UPDATE subscriptions SET cancel_at_period_end = false, updated_at = now()
        WHERE member_id = $1 AND status IN ('trialing','active','past_due','paused')`,
      [memberId]
    );
    await audit(req, { memberId, action: 'subscription.resumed' });
    res.redirect('/dashboard/subscription?resumed=1');
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------- billing --- */

accountRouter.get('/dashboard/billing', async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const [invoices, methods, payments, totals] = await Promise.all([
      query(
        `SELECT id, number, status, total_pence, issued_at, due_at, paid_at
           FROM invoices WHERE member_id = $1 ORDER BY issued_at DESC LIMIT 50`,
        [memberId]
      ),
      query('SELECT * FROM payment_methods WHERE member_id = $1 ORDER BY is_default DESC, created_at', [memberId]),
      query(
        `SELECT p.*, i.number FROM payments p
           LEFT JOIN invoices i ON i.id = p.invoice_id
          WHERE p.member_id = $1 ORDER BY p.processed_at DESC LIMIT 10`,
        [memberId]
      ),
      one(
        `SELECT
           coalesce(sum(total_pence) FILTER (WHERE status = 'paid'), 0)::int AS paid,
           coalesce(sum(total_pence) FILTER (WHERE status = 'open'), 0)::int AS outstanding
         FROM invoices WHERE member_id = $1`,
        [memberId]
      ),
    ]);

    const methodsBody = methods.length ? `
      <ul class="list">
        ${methods.map((m) => `
        <li class="list__row">
          <div>
            <p class="list__title">
              ${m.type === 'card'
                ? `${esc(m.brand)} ending ${esc(m.last4)}`
                : `Direct debit ${esc(m.account_name)} ····${esc(m.last4)}`}
              ${m.is_default ? '<span class="pill pill--ok">default</span>' : ''}
            </p>
            <p class="list__meta mono">
              ${m.type === 'card' ? `EXPIRES ${String(m.exp_month).padStart(2, '0')}/${esc(m.exp_year)}` : 'BACS'}
              <s>·</s> TOKEN ${esc(m.provider_token.slice(0, 12))}…
            </p>
          </div>
          <div class="rowactions">
            ${m.is_default ? '' : `
            <form method="post" action="/dashboard/billing/methods/${esc(m.id)}/default">
              ${csrf(req.session.csrf_token)}
              <button class="btn btn--sm btn--ghost" type="submit">Make default</button>
            </form>`}
            <form method="post" action="/dashboard/billing/methods/${esc(m.id)}/remove">
              ${csrf(req.session.csrf_token)}
              <button class="btn btn--sm btn--danger" type="submit">Remove</button>
            </form>
          </div>
        </li>`).join('')}
      </ul>` : empty('NO PAYMENT METHOD ON FILE.');

    const invoiceBody = invoices.length ? `
      <table class="table">
        <thead><tr><th>Invoice</th><th>Issued</th><th>Due</th><th>Status</th><th class="num">Total</th></tr></thead>
        <tbody>${invoices.map((i) => `
          <tr>
            <td><a href="/dashboard/billing/invoices/${esc(i.id)}">${esc(i.number)}</a></td>
            <td>${esc(shortDate(i.issued_at))}</td>
            <td>${esc(shortDate(i.due_at))}</td>
            <td>${statusPill(i.status)}</td>
            <td class="num">${esc(money(i.total_pence))}</td>
          </tr>`).join('')}</tbody>
      </table>` : empty('NO INVOICES YET.');

    const paymentsBody = payments.length ? `
      <table class="table">
        <thead><tr><th>Date</th><th>Invoice</th><th>Method</th><th>Status</th><th class="num">Amount</th></tr></thead>
        <tbody>${payments.map((p) => `
          <tr>
            <td>${esc(shortDate(p.processed_at))}</td>
            <td>${p.number ? esc(p.number) : '—'}</td>
            <td class="mono">${esc(p.method)}</td>
            <td>${statusPill(p.status)}${p.failure_reason ? `<span class="muted"> ${esc(p.failure_reason)}</span>` : ''}</td>
            <td class="num">${esc(money(p.amount_pence))}</td>
          </tr>`).join('')}</tbody>
      </table>` : empty('NO PAYMENTS RECORDED.');

    res.send(page({
      title: 'Billing',
      member: req.session,
      active: '/dashboard/billing',
      flash: req.query.method === 'added' ? { kind: 'ok', message: 'Payment method saved.' }
           : req.query.method === 'removed' ? { kind: 'ok', message: 'Payment method removed.' }
           : req.query.method === 'default' ? { kind: 'ok', message: 'Default payment method updated.' }
           : null,
      body: `
      <header class="head">
        <p class="head__eyebrow mono">BILLING</p>
        <h1 class="head__title">Billing</h1>
      </header>

      <div class="tiles tiles--two">
        <div class="tile">
          <p class="tile__k mono">PAID TO DATE</p>
          <p class="tile__v">${esc(money(totals.paid))}</p>
        </div>
        <div class="tile${totals.outstanding > 0 ? ' tile--warn' : ''}">
          <p class="tile__k mono">OUTSTANDING</p>
          <p class="tile__v">${esc(money(totals.outstanding))}</p>
        </div>
      </div>

      ${card('Payment methods', `
        ${methodsBody}
        <details class="addmethod">
          <summary class="mono">ADD A PAYMENT METHOD</summary>
          <p class="muted small">
            A real deployment hands card details straight to the payment
            processor and stores only the token it returns. This form fakes that
            exchange: no card number is entered, transmitted or stored here.
          </p>
          <form method="post" action="/dashboard/billing/methods" class="grid2 mt">
            ${csrf(req.session.csrf_token)}
            <div class="f">
              <label class="f__label mono" for="f-brand">CARD TYPE</label>
              <select class="f__input" id="f-brand" name="brand">
                <option>Visa</option><option>Mastercard</option><option>Amex</option>
              </select>
            </div>
            ${field('last4', 'LAST 4 DIGITS', '', { placeholder: '4242' })}
            ${field('exp_month', 'EXPIRY MONTH', '', { type: 'number', placeholder: '09' })}
            ${field('exp_year', 'EXPIRY YEAR', '', { type: 'number', placeholder: '2029' })}
            <div class="span2"><button class="btn btn--sm btn--solid" type="submit">Save method</button></div>
          </form>
        </details>`)}

      ${card('Invoices', invoiceBody)}
      ${card('Payments', paymentsBody)}`,
    }));
  } catch (err) {
    next(err);
  }
});

accountRouter.get('/dashboard/billing/invoices/:id', async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    // Scoped by member_id: an id from another account simply does not exist here.
    const invoice = await one(
      'SELECT * FROM invoices WHERE id = $1 AND member_id = $2',
      [req.params.id, memberId]
    );
    if (!invoice) return next();

    const [lines, payments, member] = await Promise.all([
      query('SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order', [invoice.id]),
      query('SELECT * FROM payments WHERE invoice_id = $1 ORDER BY processed_at', [invoice.id]),
      one(`SELECT first_name, last_name, address_line1, address_line2, city, postcode, email
             FROM members WHERE id = $1`, [memberId]),
    ]);

    res.send(page({
      title: `Invoice ${invoice.number}`,
      member: req.session,
      active: '/dashboard/billing',
      body: `
      <header class="head">
        <p class="head__eyebrow mono"><a href="/dashboard/billing">BILLING</a> <s>//</s> INVOICE</p>
        <h1 class="head__title">${esc(invoice.number)}</h1>
      </header>

      <article class="invoice">
        <div class="invoice__top">
          <div>
            <p class="mono muted">BILLED TO</p>
            <p>${esc(member.first_name)} ${esc(member.last_name)}</p>
            <p class="muted small">${esc(member.address_line1)}${member.address_line2 ? `, ${esc(member.address_line2)}` : ''}</p>
            <p class="muted small">${esc(member.city)} ${esc(member.postcode)}</p>
            <p class="muted small">${esc(member.email)}</p>
          </div>
          <dl class="invoice__meta mono">
            <div><dt>STATUS</dt><dd>${statusPill(invoice.status)}</dd></div>
            <div><dt>ISSUED</dt><dd>${esc(shortDate(invoice.issued_at))}</dd></div>
            <div><dt>DUE</dt><dd>${esc(shortDate(invoice.due_at))}</dd></div>
            ${invoice.paid_at ? `<div><dt>PAID</dt><dd>${esc(shortDate(invoice.paid_at))}</dd></div>` : ''}
            ${invoice.period_start ? `<div><dt>PERIOD</dt><dd>${esc(shortDate(invoice.period_start))} — ${esc(shortDate(invoice.period_end))}</dd></div>` : ''}
          </dl>
        </div>

        <table class="table">
          <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
          <tbody>${lines.map((l) => `
            <tr>
              <td>${esc(l.description)}</td>
              <td class="num">${l.quantity}</td>
              <td class="num">${esc(money(l.unit_price_pence))}</td>
              <td class="num">${esc(money(l.amount_pence))}</td>
            </tr>`).join('')}</tbody>
          <tfoot>
            <tr><td colspan="3" class="num">Subtotal</td><td class="num">${esc(money(invoice.subtotal_pence))}</td></tr>
            <tr><td colspan="3" class="num">VAT</td><td class="num">${esc(money(invoice.tax_pence))}</td></tr>
            <tr class="total"><td colspan="3" class="num">Total</td><td class="num">${esc(money(invoice.total_pence))}</td></tr>
          </tfoot>
        </table>

        ${payments.length ? `
        <h3 class="invoice__h">Payments</h3>
        <table class="table">
          <tbody>${payments.map((p) => `
            <tr>
              <td>${esc(longDateTime(p.processed_at))}</td>
              <td class="mono">${esc(p.method)} ${esc(p.reference)}</td>
              <td>${statusPill(p.status)}</td>
              <td class="num">${esc(money(p.amount_pence))}</td>
            </tr>`).join('')}</tbody>
        </table>` : ''}
      </article>

      <p class="muted small mt">
        Invoices are kept for six years to satisfy HMRC record keeping, which is
        why they survive an account erasure with your personal details removed.
      </p>`,
    }));
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/dashboard/billing/methods', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const brand = str(req.body.brand, 20) || 'Visa';
    // Only the display fragment is accepted; there is nowhere to put a PAN.
    const last4 = str(req.body.last4, 4).replace(/\D/g, '').slice(-4) || '0000';
    const expMonth = Math.min(12, Math.max(1, parseInt(req.body.exp_month, 10) || 1));
    const expYear = Math.min(2099, Math.max(new Date().getFullYear(), parseInt(req.body.exp_year, 10) || new Date().getFullYear()));

    await transaction(async (tx) => {
      const existing = await tx.one('SELECT count(*)::int AS n FROM payment_methods WHERE member_id = $1', [memberId]);
      const makeDefault = existing.n === 0;
      if (makeDefault) {
        await tx.query('UPDATE payment_methods SET is_default = false WHERE member_id = $1', [memberId]);
      }
      await tx.query(
        `INSERT INTO payment_methods (member_id, type, brand, last4, exp_month, exp_year, provider_token, is_default)
         VALUES ($1, 'card', $2, $3, $4, $5, $6, $7)`,
        [memberId, brand, last4, expMonth, expYear, `tok_${Math.random().toString(36).slice(2, 18)}`, makeDefault]
      );
    });

    await audit(req, { memberId, action: 'billing.method_added', metadata: { brand, last4 } });
    res.redirect('/dashboard/billing?method=added');
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/dashboard/billing/methods/:id/default', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    await transaction(async (tx) => {
      const owned = await tx.one('SELECT id FROM payment_methods WHERE id = $1 AND member_id = $2', [req.params.id, memberId]);
      if (!owned) return;
      await tx.query('UPDATE payment_methods SET is_default = false WHERE member_id = $1', [memberId]);
      await tx.query('UPDATE payment_methods SET is_default = true WHERE id = $1', [owned.id]);
    });
    await audit(req, { memberId, action: 'billing.method_default', entityId: req.params.id });
    res.redirect('/dashboard/billing?method=default');
  } catch (err) {
    next(err);
  }
});

accountRouter.post('/dashboard/billing/methods/:id/remove', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    await query('DELETE FROM payment_methods WHERE id = $1 AND member_id = $2', [req.params.id, memberId]);
    await audit(req, { memberId, action: 'billing.method_removed', entityId: req.params.id });
    res.redirect('/dashboard/billing?method=removed');
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------- profile --- */

accountRouter.get('/dashboard/profile', async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const [member, healthConsent] = await Promise.all([
      one('SELECT * FROM members WHERE id = $1', [memberId]),
      one(`SELECT granted FROM current_consents WHERE member_id = $1 AND purpose = 'health_data'`, [memberId]),
    ]);
    res.send(profilePage(req, member, { saved: req.query.saved === '1', healthConsent: healthConsent?.granted }));
  } catch (err) {
    next(err);
  }
});

function profilePage(req, member, { errors = new Errors(), saved = false, healthConsent = false } = {}) {
  const e = (k) => errors.fields[k] || '';
  const dob = member.date_of_birth ? new Date(member.date_of_birth).toISOString().slice(0, 10) : '';
  return page({
    title: 'Profile',
    member: req.session,
    active: '/dashboard/profile',
    flash: saved ? { kind: 'ok', message: 'Profile updated.' } : (errors.any ? { kind: 'bad', message: 'Check the highlighted fields.' } : null),
    body: `
    <header class="head">
      <p class="head__eyebrow mono">PROFILE</p>
      <h1 class="head__title">Your Details</h1>
      <p class="head__lede">
        Correcting your own record is a right, not a favour. Changes take effect
        immediately and are written to your account activity log.
      </p>
    </header>

    <form method="post" action="/dashboard/profile" novalidate>
      ${csrf(req.session.csrf_token)}

      ${card('Your face', `
        <p class="muted">
          Pick the one that suits you. There is no upload: everybody chooses from
          the same ten, so nothing you own leaves your device and no photograph
          of you is ever stored here.
        </p>
        <ul class="picker">
          ${AVATARS.map((a) => `
          <li>
            <input class="picker__input" type="radio" name="avatar_key" id="av-${esc(a.key)}"
                   value="${esc(a.key)}" ${a.key === (member.avatar_key || 'green-calm') ? 'checked' : ''} />
            <label class="picker__opt" for="av-${esc(a.key)}">
              <img src="${esc(avatarSrc(a.key))}" alt="" width="72" height="76" loading="lazy" />
              <span class="picker__name">${esc(a.name)}</span>
              <span class="picker__mood mono">${esc(a.mood)}</span>
            </label>
          </li>`).join('')}
        </ul>
        <p class="picker__credit mono">
          ILLUSTRATIONS <s>//</s> ${esc(AVATAR_CREDIT.illustrator).toUpperCase()}
        </p>`)}

      ${card('Identity', `
        <div class="grid2">
          ${field('first_name', 'FIRST NAME', member.first_name, { required: true, error: e('first_name') })}
          ${field('last_name', 'LAST NAME', member.last_name, { required: true, error: e('last_name') })}
        </div>
        <div class="grid2">
          ${field('phone', 'PHONE', member.phone, { type: 'tel', error: e('phone') })}
          ${field('date_of_birth', 'DATE OF BIRTH', dob, { type: 'date', error: e('date_of_birth') })}
        </div>
        <p class="muted small">
          Your email is ${esc(member.email)}. Changing it needs a coach to verify
          you on the floor, because it is the key to this account.
        </p>`)}

      ${card('Address', `
        ${field('address_line1', 'ADDRESS LINE 1', member.address_line1, { autocomplete: 'address-line1' })}
        ${field('address_line2', 'ADDRESS LINE 2', member.address_line2, { autocomplete: 'address-line2' })}
        <div class="grid2">
          ${field('city', 'TOWN OR CITY', member.city, { autocomplete: 'address-level2' })}
          ${field('postcode', 'POSTCODE', member.postcode, { autocomplete: 'postal-code', error: e('postcode') })}
        </div>`)}

      ${card('In an emergency', `
        <div class="grid2">
          ${field('emergency_contact_name', 'CONTACT NAME', member.emergency_contact_name)}
          ${field('emergency_contact_phone', 'CONTACT PHONE', member.emergency_contact_phone, { type: 'tel' })}
        </div>`)}

      ${card('Medical notes', `
        <p class="muted small">
          Anything a coach should know before you spar: asthma, past concussion,
          medication, injuries. This is health data under Article 9 and is only
          stored while you consent to it.
          ${healthConsent
            ? 'You have given that consent.'
            : 'You have <strong>not</strong> given that consent, so this field is locked. Turn it on under Privacy and data.'}
        </p>
        ${healthConsent
          ? textarea('medical_notes', 'NOTES', member.medical_notes, { rows: 4 })
          : `<p class="locked mono">LOCKED <s>·</s> <a href="/dashboard/privacy">MANAGE CONSENT</a></p>`}`,
        { tone: 'special' })}

      <div class="actions">
        <button class="btn btn--solid" type="submit">Save changes</button>
      </div>
    </form>`,
  });
}

accountRouter.post('/dashboard/profile', requireCsrf, async (req, res, next) => {
  try {
    const memberId = req.session.member_id;
    const errors = new Errors();

    const values = {
      first_name: str(req.body.first_name, 80),
      last_name: str(req.body.last_name, 80),
      phone: str(req.body.phone, 40),
      date_of_birth: str(req.body.date_of_birth, 20) || null,
      address_line1: str(req.body.address_line1, 160),
      address_line2: str(req.body.address_line2, 160),
      city: str(req.body.city, 80),
      postcode: str(req.body.postcode, 12),
      emergency_contact_name: str(req.body.emergency_contact_name, 120),
      emergency_contact_phone: str(req.body.emergency_contact_phone, 40),
    };

    if (!values.first_name) errors.add('first_name', 'Required.');
    if (!values.last_name) errors.add('last_name', 'Required.');
    if (values.postcode && !POSTCODE_RE.test(values.postcode)) {
      errors.add('postcode', 'That does not look like a UK postcode.');
    }

    const healthConsent = await one(
      `SELECT granted FROM current_consents WHERE member_id = $1 AND purpose = 'health_data'`,
      [memberId]
    );

    if (errors.any) {
      const member = { ...(await one('SELECT * FROM members WHERE id = $1', [memberId])), ...values };
      return res.status(400).send(profilePage(req, member, { errors, healthConsent: healthConsent?.granted }));
    }

    // Medical notes are only writable while consent stands.
    const notes = healthConsent?.granted ? str(req.body.medical_notes, 2000) : null;

    // The avatar must be one of ours. Anything else is ignored rather than
    // rejected: it can only come from a hand-edited form.
    const submittedAvatar = str(req.body.avatar_key, 40);
    const avatarKey = isAvatarKey(submittedAvatar) ? submittedAvatar : null;

    await query(
      `UPDATE members SET
         first_name = $1, last_name = $2, phone = $3, date_of_birth = $4,
         address_line1 = $5, address_line2 = $6, city = $7, postcode = $8,
         emergency_contact_name = $9, emergency_contact_phone = $10,
         medical_notes = COALESCE($11, medical_notes),
         avatar_key = COALESCE($12, avatar_key),
         updated_at = now()
       WHERE id = $13`,
      [values.first_name, values.last_name, values.phone, values.date_of_birth,
       values.address_line1, values.address_line2, values.city, values.postcode,
       values.emergency_contact_name, values.emergency_contact_phone, notes,
       avatarKey, memberId]
    );

    await audit(req, {
      memberId, action: 'profile.updated', entity: 'member', entityId: memberId,
      metadata: { fields: Object.keys(values) },
    });
    res.redirect('/dashboard/profile?saved=1');
  } catch (err) {
    next(err);
  }
});
