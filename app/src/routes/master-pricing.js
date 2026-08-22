/**
 * Pricing, from the club's side.
 *
 * The rule that makes the rest of this file make sense: a plan holds the price
 * we sell at today, a subscription holds the price a member was signed up at.
 * Changing a plan therefore repriced nobody by accident. Whoever makes the
 * change says, in the same form, whether it applies to new members only or to
 * everybody, and the answer is written down with their name on it.
 *
 * These routes are registered onto the master router *after* its admin guard,
 * so they inherit it rather than declaring their own.
 */

import { query, one, transaction } from '../db.js';
import { requireAdminCsrf, requireAdmin, adminAudit } from '../admin-auth.js';
import { str } from '../validate.js';
import { masterPage } from '../views/master-layout.js';
import { esc, money, shortDate, card, csrf, empty } from '../views/layout.js';
import { toPence } from './master.js';

const LIVE = `('trialing', 'active', 'past_due')`;
const BILLABLE = `('trialing', 'active', 'past_due', 'paused')`;

/** A code we can put in a URL and a column: lowercase, digits, dashes. */
export function slug(input) {
  return str(input, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Features arrive as one per line and are stored as a JSON array. */
export function featureList(input) {
  return str(input, 2000).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12);
}

export function registerPricingRoutes(router) {
  /* ------------------------------------------------------------- the page -- */

  router.get('/master/plans', async (req, res, next) => {
    try {
      const [plans, legacy, history] = await Promise.all([
        query('SELECT * FROM plan_rollup ORDER BY is_active DESC, sort_order, list_price_pence'),
        query(`
          SELECT s.id, s.plan_id, s.price_pence, s.billing_interval, s.status,
                 p.price_pence AS list_price_pence,
                 m.id AS member_id, m.first_name, m.last_name, m.avatar_key
            FROM subscriptions s
            JOIN plans p   ON p.id = s.plan_id
            JOIN members m ON m.id = s.member_id
           WHERE s.status IN ${LIVE}
             AND s.price_pence <> p.price_pence
             AND m.status <> 'erased'
           ORDER BY p.sort_order, s.price_pence`),
        query(`
          SELECT c.*, st.name AS admin_name, p.name AS plan_name
            FROM plan_price_changes c
            JOIN plans p ON p.id = c.plan_id
            LEFT JOIN admins st ON st.id = c.admin_id
           ORDER BY c.created_at DESC
           LIMIT 40`),
      ]);

      const full = await query('SELECT * FROM plans ORDER BY sort_order, price_pence');
      const byId = new Map(full.map((p) => [p.id, p]));
      const legacyByPlan = new Map();
      for (const l of legacy) {
        if (!legacyByPlan.has(l.plan_id)) legacyByPlan.set(l.plan_id, []);
        legacyByPlan.get(l.plan_id).push(l);
      }
      const historyByPlan = new Map();
      for (const h of history) {
        if (!historyByPlan.has(h.plan_id)) historyByPlan.set(h.plan_id, []);
        historyByPlan.get(h.plan_id).push(h);
      }

      const totals = plans.reduce((a, p) => ({
        monthly: a.monthly + p.monthly_pence,
        members: a.members + p.subscribers,
        active: a.active + (p.is_active ? 1 : 0),
      }), { monthly: 0, members: 0, active: 0 });

      const priceInputs = (p, prefix) => `
        <div class="price2">
          <div class="f">
            <label class="f__label mono" for="${prefix}-price">PRICE</label>
            <div class="price2__amt">
              <span class="mono">£</span>
              <input class="f__input" id="${prefix}-price" name="price" type="text"
                     inputmode="decimal" value="${p ? (p.price_pence / 100).toFixed(2) : ''}"
                     placeholder="45.00" required />
            </div>
          </div>
          <div class="f">
            <label class="f__label mono" for="${prefix}-interval">BILLED EVERY</label>
            <select class="f__input" id="${prefix}-interval" name="billing_interval">
              <option value="month"${p?.billing_interval === 'month' ? ' selected' : ''}>Month</option>
              <option value="year"${p?.billing_interval === 'year' ? ' selected' : ''}>Year</option>
            </select>
          </div>
        </div>`;

      const planCards = plans.map((r) => {
        const p = byId.get(r.plan_id);
        const held = legacyByPlan.get(r.plan_id) || [];
        const past = historyByPlan.get(r.plan_id) || [];

        const heldRows = held.map((h) => `
          <li class="held">
            <span class="who2">
              <img src="/assets/avatars/${esc(h.avatar_key)}.svg" alt="" width="28" height="28" />
              <span>
                <a href="/master/members/${esc(h.member_id)}">${esc(h.first_name)} ${esc(h.last_name)}</a>
                <small class="mono muted">PAYING ${esc(money(h.price_pence))} <s>·</s> LIST ${esc(money(h.list_price_pence))}</small>
              </span>
            </span>
            <form method="post" action="/master/members/${esc(h.member_id)}/price" class="inline">
              ${csrf(req.admin.csrf_token)}
              <input type="hidden" name="price" value="${(h.list_price_pence / 100).toFixed(2)}" />
              <input type="hidden" name="reason" value="Moved to the current list price" />
              <input type="hidden" name="back" value="/master/plans" />
              <button class="btn btn--sm" type="submit">Move to list</button>
            </form>
          </li>`).join('');

        const pastRows = past.map((h) => `
          <li class="mono">
            <span class="muted">${esc(shortDate(h.created_at))}</span>
            ${esc(money(h.old_price_pence))} <s>&rarr;</s> <strong>${esc(money(h.new_price_pence))}</strong>
            <span class="muted">${h.applied_to === 'everyone'
              ? `EVERYONE <s>·</s> ${h.subscribers_repriced} REPRICED`
              : 'NEW MEMBERS ONLY'}</span>
            <span class="muted">${esc(h.admin_name || 'unknown')}</span>
            ${h.note ? `<span class="muted">${esc(h.note)}</span>` : ''}
          </li>`).join('');

        return `
        <section class="planrow${r.is_active ? '' : ' planrow--off'}" id="plan-${esc(r.plan_id)}">
          <header class="planrow__head">
            <div>
              <p class="mono muted">${esc(r.code)}${r.is_active ? '' : ' <s>·</s> ARCHIVED'}</p>
              <h3 class="planrow__name">${esc(r.name)}</h3>
            </div>
            <p class="planrow__price">${esc(money(r.list_price_pence))}<span class="mono">/${esc(r.billing_interval).toUpperCase()}</span></p>
          </header>

          <dl class="planrow__stats mono">
            <div><dt>ON THIS PLAN</dt><dd>${r.subscribers}</dd></div>
            <div><dt>WORTH PER MONTH</dt><dd>${esc(money(r.monthly_pence))}</dd></div>
            <div><dt>OFF LIST PRICE</dt><dd${r.off_list_price ? ' class="owed"' : ''}>${r.off_list_price}</dd></div>
          </dl>

          ${held.length ? `
          <details class="drop">
            <summary class="mono">${held.length} HELD ON ANOTHER RATE</summary>
            <ul class="heldlist">${heldRows}</ul>
          </details>` : ''}

          ${past.length ? `
          <details class="drop">
            <summary class="mono">PRICE HISTORY</summary>
            <ul class="histlist">${pastRows}</ul>
          </details>` : ''}

          <details class="drop drop--edit">
            <summary class="mono">EDIT THIS PLAN</summary>
            <form method="post" action="/master/plans/${esc(r.plan_id)}" class="planform">
              ${csrf(req.admin.csrf_token)}
              <div class="f">
                <label class="f__label mono" for="n-${esc(r.plan_id)}">NAME</label>
                <input class="f__input" id="n-${esc(r.plan_id)}" name="name" type="text"
                       value="${esc(p.name)}" required />
              </div>
              <div class="f">
                <label class="f__label mono" for="d-${esc(r.plan_id)}">DESCRIPTION</label>
                <input class="f__input" id="d-${esc(r.plan_id)}" name="description" type="text"
                       value="${esc(p.description)}" />
              </div>
              ${priceInputs(p, esc(r.plan_id))}
              <div class="f">
                <label class="f__label mono" for="ft-${esc(r.plan_id)}">WHAT IT INCLUDES, ONE PER LINE</label>
                <textarea class="f__input" id="ft-${esc(r.plan_id)}" name="features" rows="4">${esc((p.features || []).join('\n'))}</textarea>
              </div>
              <div class="f">
                <label class="f__label mono" for="cap-${esc(r.plan_id)}">PLACES, BLANK FOR UNLIMITED</label>
                <input class="f__input" id="cap-${esc(r.plan_id)}" name="capacity" type="text"
                       inputmode="numeric" value="${p.capacity ?? ''}" />
              </div>

              <fieldset class="apply">
                <legend class="f__label mono">A PRICE CHANGE APPLIES TO</legend>
                <label class="apply__opt">
                  <input type="radio" name="applied_to" value="new_members" checked />
                  <span>
                    <strong>New members only</strong>
                    <small>Everybody already on this plan keeps what they pay now. Nothing on anyone's bill moves.</small>
                  </span>
                </label>
                <label class="apply__opt">
                  <input type="radio" name="applied_to" value="everyone" />
                  <span>
                    <strong>Everyone on this plan</strong>
                    <small>${r.subscribers === 0
                      ? 'Nobody is on this plan yet, so this has the same effect as the option above.'
                      : r.subscribers === 1
                        ? 'The one member on this plan moves to the new price at their next renewal. Invoices already issued are untouched.'
                        : `All ${r.subscribers} current members move to the new price at their next renewal. Invoices already issued are untouched.`}</small>
                  </span>
                </label>
              </fieldset>

              <div class="f">
                <label class="f__label mono" for="note-${esc(r.plan_id)}">WHY, FOR THE RECORD</label>
                <input class="f__input" id="note-${esc(r.plan_id)}" name="note" type="text"
                       placeholder="Hall hire went up in April" />
              </div>

              <label class="check">
                <input type="checkbox" name="is_active" value="1"${p.is_active ? ' checked' : ''} />
                <span>Offer this plan to new members</span>
              </label>

              <div class="planform__go">
                <button class="btn btn--solid" type="submit">Save plan</button>
              </div>
            </form>
          </details>
        </section>`;
      }).join('');

      const creator = card('Add a plan', `
        <form method="post" action="/master/plans" class="planform">
          ${csrf(req.admin.csrf_token)}
          <div class="f">
            <label class="f__label mono" for="new-name">NAME</label>
            <input class="f__input" id="new-name" name="name" type="text" placeholder="Juniors" required />
          </div>
          <div class="f">
            <label class="f__label mono" for="new-description">DESCRIPTION</label>
            <input class="f__input" id="new-description" name="description" type="text"
                   placeholder="Under 16s, Tuesday and Thursday" />
          </div>
          ${priceInputs(null, 'new')}
          <div class="f">
            <label class="f__label mono" for="new-features">WHAT IT INCLUDES, ONE PER LINE</label>
            <textarea class="f__input" id="new-features" name="features" rows="4"></textarea>
          </div>
          <div class="planform__go">
            <button class="btn btn--solid" type="submit">Create plan</button>
          </div>
        </form>`);

      res.send(masterPage({
        title: 'Pricing',
        admin: req.admin,
        active: '/master/plans',
        flash: pricingFlash(req.query),
        body: `
        <header class="head">
          <p class="head__eyebrow mono">MASTER <s>//</s> PRICING</p>
          <h1 class="head__title">What It Costs<br />To Train Here</h1>
          <p class="head__lede">
            A plan holds the price we sell at today. A membership holds the price
            that member was signed up at. So putting a plan up does not move
            anybody until you say it should, and anybody you have kept on an old
            rate stays visible instead of living in somebody's memory.
          </p>
        </header>

        <div class="tiles">
          <div class="tile">
            <p class="tile__k mono">PLANS ON OFFER</p>
            <p class="tile__v">${totals.active}</p>
            <p class="tile__sub mono">${plans.length} IN TOTAL</p>
          </div>
          <div class="tile">
            <p class="tile__k mono">PAYING MEMBERS</p>
            <p class="tile__v">${totals.members}</p>
          </div>
          <div class="tile">
            <p class="tile__k mono">BOOKED PER MONTH</p>
            <p class="tile__v">${esc(money(totals.monthly))}</p>
            <p class="tile__sub mono">AT THE PRICES MEMBERS ARE ACTUALLY ON</p>
          </div>
          <div class="tile${legacy.length ? ' tile--warn' : ''}">
            <p class="tile__k mono">HELD ON AN OLD RATE</p>
            <p class="tile__v">${legacy.length}</p>
          </div>
        </div>

        ${card('Plans', planCards || empty('NO PLANS YET.'))}
        ${creator}`,
      }));
    } catch (err) {
      next(err);
    }
  });

  /* ------------------------------------------------------------ edit plan -- */

  router.post('/master/plans/:id', requireAdminCsrf, requireAdmin, async (req, res, next) => {
    try {
      const price = toPence(req.body.price);
      if (price === null) return res.redirect('/master/plans?done=badprice');

      const name = str(req.body.name, 60);
      if (!name) return res.redirect('/master/plans?done=badplan');

      const interval = req.body.billing_interval === 'year' ? 'year' : 'month';
      const applied = req.body.applied_to === 'everyone' ? 'everyone' : 'new_members';
      const note = str(req.body.note, 200);
      const capRaw = str(req.body.capacity, 6);
      const capacity = /^\d+$/.test(capRaw) ? Math.min(parseInt(capRaw, 10), 100000) : null;

      const result = await transaction(async (tx) => {
        const plan = await tx.one('SELECT * FROM plans WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!plan) return null;

        const wasPrice = plan.price_pence;
        const moved = wasPrice !== price || plan.billing_interval !== interval;

        await tx.query(
          `UPDATE plans
              SET name = $1, description = $2, price_pence = $3, billing_interval = $4,
                  features = $5::jsonb, capacity = $6, is_active = $7
            WHERE id = $8`,
          [name, str(req.body.description, 300), price, interval,
           JSON.stringify(featureList(req.body.features)), capacity,
           req.body.is_active === '1', plan.id]
        );

        // Only "everyone" touches a membership that already exists. This lands
        // at the next renewal: invoices already issued keep their own totals,
        // which is what makes them a record rather than a rendering.
        let repriced = [];
        if (moved && applied === 'everyone') {
          repriced = await tx.query(
            `UPDATE subscriptions
                SET price_pence = $1, billing_interval = $2, updated_at = now()
              WHERE plan_id = $3 AND status IN ${BILLABLE}
              RETURNING id, member_id`,
            [price, interval, plan.id]
          );
        }

        if (moved) {
          await tx.query(
            `INSERT INTO plan_price_changes (plan_id, admin_id, old_price_pence,
                                             new_price_pence, applied_to,
                                             subscribers_repriced, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [plan.id, req.admin.admin_id, wasPrice, price, applied, repriced.length, note]
          );
        }

        return { plan, wasPrice, moved, repriced: repriced.length };
      });

      if (!result) return res.redirect('/master/plans?done=badplan');

      await adminAudit(req, {
        action: result.moved ? 'plan.repriced' : 'plan.updated',
        entity: 'plan', entityId: result.plan.id,
        metadata: {
          plan: result.plan.code, name,
          old_price_pence: result.wasPrice, new_price_pence: price,
          billing_interval: interval, applied_to: applied,
          subscribers_repriced: result.repriced, note,
        },
      });

      const done = !result.moved ? 'plansaved'
        : result.repriced ? `repriced&n=${result.repriced}`
        : 'pricenew';
      res.redirect(`/master/plans?done=${done}#plan-${result.plan.id}`);
    } catch (err) {
      next(err);
    }
  });

  /* ---------------------------------------------------------- create plan -- */

  router.post('/master/plans', requireAdminCsrf, requireAdmin, async (req, res, next) => {
    try {
      const name = str(req.body.name, 60);
      const price = toPence(req.body.price);
      if (!name || price === null) return res.redirect('/master/plans?done=badplan');

      const base = slug(name) || 'plan';
      const taken = await query('SELECT code FROM plans WHERE code LIKE $1', [`${base}%`]);
      const codes = new Set(taken.map((p) => p.code));
      let code = base;
      for (let n = 2; codes.has(code); n += 1) code = `${base}-${n}`;

      const order = await one('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM plans');

      const plan = await one(
        `INSERT INTO plans (code, name, description, price_pence, billing_interval,
                            features, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
        [code, name, str(req.body.description, 300), price,
         req.body.billing_interval === 'year' ? 'year' : 'month',
         JSON.stringify(featureList(req.body.features)), order.next]
      );

      await adminAudit(req, {
        action: 'plan.created', entity: 'plan', entityId: plan.id,
        metadata: { plan: code, name, price_pence: price },
      });
      res.redirect(`/master/plans?done=plancreated#plan-${plan.id}`);
    } catch (err) {
      next(err);
    }
  });

  /* ------------------------------------------------- one member's own rate -- */

  /**
   * A concession, a hardship rate, a family second-member discount. The gym
   * does this constantly and it usually lives in somebody's head; here it is a
   * column with a reason attached to it.
   */
  router.post('/master/members/:id/price', requireAdminCsrf, requireAdmin, async (req, res, next) => {
    try {
      const price = toPence(req.body.price);
      const memberId = req.params.id;
      const back = str(req.body.back, 60) === '/master/plans'
        ? '/master/plans' : `/master/members/${memberId}`;
      if (price === null) return res.redirect(`${back}?done=badprice`);

      const reason = str(req.body.reason, 200);

      const sub = await one(
        `UPDATE subscriptions SET price_pence = $1, updated_at = now()
          WHERE member_id = $2 AND status IN ${BILLABLE}
          RETURNING id, plan_id, price_pence`,
        [price, memberId]
      );
      if (!sub) return res.redirect(`${back}?done=nosub`);

      await adminAudit(req, {
        action: 'subscription.repriced', memberId,
        entity: 'subscription', entityId: sub.id,
        metadata: { price_pence: price, reason },
      });
      res.redirect(`${back}?done=memberpriced`);
    } catch (err) {
      next(err);
    }
  });
}

/** Flash for this page, with the repriced count folded into the sentence. */
function pricingFlash({ done, n }) {
  const flash = FLASH[done];
  if (!flash) return null;
  if (done !== 'repriced') return flash;
  const count = /^\d{1,6}$/.test(String(n || '')) ? parseInt(n, 10) : 0;
  return {
    kind: 'ok',
    message: `New price saved and applied to ${count} current ${count === 1 ? 'membership' : 'memberships'} from their next renewal.`,
  };
}

const FLASH = {
  plansaved: { kind: 'ok', message: 'Plan saved. The price did not move, so nobody was repriced.' },
  pricenew: { kind: 'ok', message: 'New price saved for new members. Everybody already on this plan keeps what they pay.' },
  repriced: { kind: 'ok', message: 'New price saved and applied to current members from their next renewal.' },
  plancreated: { kind: 'ok', message: 'Plan created and on offer.' },
  memberpriced: { kind: 'ok', message: 'This membership is now on its own rate.' },
  badprice: { kind: 'bad', message: 'That is not a price. Use pounds and pence, for example 45.00.' },
  badplan: { kind: 'bad', message: 'A plan needs a name and a price.' },
  nosub: { kind: 'bad', message: 'That member has no live membership to reprice.' },
};
