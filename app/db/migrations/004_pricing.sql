-- ─────────────────────────────────────────────────────────── pricing ──────
--
-- Staff can change what a membership costs. That makes one question urgent
-- that did not exist while prices were seed data: what happens to the people
-- already paying the old price.
--
-- The answer here is that a subscription carries its own price. The plan holds
-- the price we sell at today; the subscription holds the price this member was
-- signed up at. Raising a plan therefore does nothing to anybody until a member
-- of staff says it should, and "grandfathered on the old rate" is a state the
-- system can represent rather than a spreadsheet somebody keeps privately.
--
-- Every change is written to an append-only log, because "who put the juniors
-- up to £40 and when" is a question that gets asked months later.

ALTER TABLE subscriptions
  ADD COLUMN price_pence      integer,
  ADD COLUMN billing_interval text NOT NULL DEFAULT 'month'
                                CHECK (billing_interval IN ('month', 'year'));

-- Existing rows inherit whatever their plan charges right now, which is by
-- definition the price they are on today.
UPDATE subscriptions s
   SET price_pence      = p.price_pence,
       billing_interval = p.billing_interval
  FROM plans p
 WHERE p.id = s.plan_id;

ALTER TABLE subscriptions
  ALTER COLUMN price_pence SET NOT NULL,
  ADD CONSTRAINT subscriptions_price_nonneg CHECK (price_pence >= 0);

CREATE TABLE plan_price_changes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id              uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  staff_id             uuid REFERENCES staff_users(id),
  old_price_pence      integer NOT NULL,
  new_price_pence      integer NOT NULL,
  applied_to           text NOT NULL
                         CHECK (applied_to IN ('new_members', 'everyone')),
  subscribers_repriced integer NOT NULL DEFAULT 0,
  note                 text NOT NULL DEFAULT '',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX plan_price_changes_plan_idx
  ON plan_price_changes (plan_id, created_at DESC);

-- What each plan is worth per month at the prices members are actually on,
-- not at the price on the pricing page. A plan can be sold at £45 while half
-- its members sit on £35, and the number that pays the rent is the second one.
CREATE VIEW plan_rollup AS
  SELECT p.id                                                          AS plan_id,
         p.code,
         p.name,
         p.price_pence                                                 AS list_price_pence,
         p.billing_interval,
         p.is_active,
         p.sort_order,
         COUNT(s.id) FILTER (
           WHERE s.status IN ('trialing', 'active', 'past_due')
         )::int                                                        AS subscribers,
         COUNT(s.id) FILTER (
           WHERE s.status IN ('trialing', 'active', 'past_due')
             AND s.price_pence <> p.price_pence
         )::int                                                        AS off_list_price,
         COALESCE(SUM(
           CASE WHEN s.status IN ('trialing', 'active', 'past_due')
                THEN CASE WHEN s.billing_interval = 'year'
                          THEN s.price_pence / 12
                          ELSE s.price_pence END
                ELSE 0 END
         ), 0)::int                                                    AS monthly_pence
    FROM plans p
    LEFT JOIN subscriptions s ON s.plan_id = p.id
   GROUP BY p.id;
