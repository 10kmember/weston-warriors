-- Staff accounts and the master dashboard.
--
-- Staff are a separate table with separate sessions and a separate cookie, not
-- a role column on `members`. That means a member session can never become a
-- staff session, and compromising a member account gives an attacker no path
-- to the till: there is no flag to flip. The two sign in pages are different
-- pages backed by different tables.

BEGIN;

CREATE TABLE staff_users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL,
  password_hash       text NOT NULL,
  name                text NOT NULL DEFAULT '',
  role                text NOT NULL DEFAULT 'coach'
                        CHECK (role IN ('coach', 'admin')),
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended')),
  last_login_at       timestamptz,
  failed_login_count  integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX staff_users_email_key ON staff_users (lower(email));

CREATE TABLE staff_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  csrf_token    text NOT NULL,
  ip            inet,
  user_agent    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);

CREATE INDEX staff_sessions_staff_idx ON staff_sessions (staff_id);

-- Offline reconciliation: who took the cash, and what they wrote on the slip.
ALTER TABLE payments
  ADD COLUMN recorded_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN note        text NOT NULL DEFAULT '';

COMMENT ON COLUMN payments.recorded_by IS
  'Set when a member of staff recorded the payment by hand, rather than a processor reporting it.';

-- Attribute staff actions in the shared audit trail.
ALTER TABLE audit_log
  ADD COLUMN staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL;

CREATE INDEX audit_log_staff_idx ON audit_log (staff_id, created_at DESC);

-- What is actually owed on each invoice.
--
-- Derived rather than stored: a `balance` column would be one failed write away
-- from disagreeing with the payments that back it.
CREATE VIEW invoice_balances AS
SELECT
  i.id                                            AS invoice_id,
  i.member_id,
  i.number,
  i.status,
  i.total_pence,
  i.issued_at,
  i.due_at,
  i.paid_at,
  COALESCE(p.paid_pence, 0)                       AS paid_pence,
  i.total_pence - COALESCE(p.paid_pence, 0)       AS outstanding_pence,
  (i.status = 'open' AND i.due_at < now())        AS is_overdue,
  GREATEST(0, date_part('day', now() - i.due_at))::int AS days_overdue
FROM invoices i
LEFT JOIN (
  SELECT invoice_id, SUM(amount_pence)::int AS paid_pence
    FROM payments
   WHERE status = 'succeeded'
   GROUP BY invoice_id
) p ON p.invoice_id = i.id;

INSERT INTO schema_migrations (version) VALUES ('003_staff');

COMMIT;
