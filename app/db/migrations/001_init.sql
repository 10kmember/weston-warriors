-- Weston Warriors — member platform schema
--
-- Design notes that matter:
--
--  * Consent is an append-only ledger, not a boolean column. Article 7(1)
--    requires you to *demonstrate* that consent was given, which means keeping
--    the history with timestamps, policy version and source. Current state is
--    the latest row per (member, purpose).
--
--  * Erasure anonymises the member row rather than deleting it. UK tax law
--    requires financial records to be kept for six years, which Article 17(3)(b)
--    explicitly permits as an exemption. We strip the personal data and keep the
--    invoice trail pointing at a tombstone row.
--
--  * Card numbers are never stored. `payment_methods` holds a provider token
--    plus the display fragments a processor gives you back.

CREATE TABLE schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────── plans ────────

CREATE TABLE plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  price_pence      integer NOT NULL CHECK (price_pence >= 0),
  billing_interval text NOT NULL DEFAULT 'month'
                     CHECK (billing_interval IN ('month', 'year')),
  features         jsonb NOT NULL DEFAULT '[]'::jsonb,
  capacity         integer,
  is_active        boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────────────────────────────────── members ────────

CREATE TABLE members (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                    text NOT NULL,
  password_hash            text NOT NULL,
  first_name               text NOT NULL DEFAULT '',
  last_name                text NOT NULL DEFAULT '',
  phone                    text NOT NULL DEFAULT '',
  date_of_birth            date,

  address_line1            text NOT NULL DEFAULT '',
  address_line2            text NOT NULL DEFAULT '',
  city                     text NOT NULL DEFAULT '',
  postcode                 text NOT NULL DEFAULT '',

  emergency_contact_name   text NOT NULL DEFAULT '',
  emergency_contact_phone  text NOT NULL DEFAULT '',

  -- Article 9 special category data. Optional, separately consented, and the
  -- first thing cleared on erasure.
  medical_notes            text NOT NULL DEFAULT '',

  status                   text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('pending','active','suspended','cancelled','erased')),
  role                     text NOT NULL DEFAULT 'member'
                             CHECK (role IN ('member','coach','admin')),

  email_verified_at        timestamptz,
  last_login_at            timestamptz,
  failed_login_count       integer NOT NULL DEFAULT 0,
  locked_until             timestamptz,

  erasure_requested_at     timestamptz,
  erasure_due_at           timestamptz,
  erased_at                timestamptz,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Emails are compared case-insensitively; stored lowercase on write.
CREATE UNIQUE INDEX members_email_key ON members (lower(email));
CREATE INDEX members_status_idx ON members (status);

-- ──────────────────────────────────────────────────────── sessions ────────

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- the raw token lives only in the cookie; we keep a SHA-256 of it
  token_hash    text NOT NULL UNIQUE,
  csrf_token    text NOT NULL,
  ip            inet,
  user_agent    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);

CREATE INDEX sessions_member_idx ON sessions (member_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- ─────────────────────────────────────────────────── subscriptions ────────

CREATE TABLE subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id             uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  plan_id               uuid NOT NULL REFERENCES plans(id),
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('trialing','active','past_due','paused','cancelled')),
  started_at            timestamptz NOT NULL DEFAULT now(),
  current_period_start  timestamptz NOT NULL,
  current_period_end    timestamptz NOT NULL,
  cancel_at_period_end  boolean NOT NULL DEFAULT false,
  cancelled_at          timestamptz,
  paused_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subscriptions_member_idx ON subscriptions (member_id);
-- one live subscription per member
CREATE UNIQUE INDEX subscriptions_one_live_per_member
  ON subscriptions (member_id)
  WHERE status IN ('trialing','active','past_due','paused');

-- ───────────────────────────────────────────── invoices & payments ────────

CREATE TABLE invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        uuid NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  subscription_id  uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  number           text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('draft','open','paid','void','uncollectible')),
  currency         text NOT NULL DEFAULT 'GBP',
  subtotal_pence   integer NOT NULL DEFAULT 0,
  tax_pence        integer NOT NULL DEFAULT 0,
  total_pence      integer NOT NULL DEFAULT 0,
  period_start     timestamptz,
  period_end       timestamptz,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  due_at           timestamptz,
  paid_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invoices_member_idx ON invoices (member_id, issued_at DESC);
CREATE INDEX invoices_status_idx ON invoices (status);

CREATE TABLE invoice_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description       text NOT NULL,
  quantity          integer NOT NULL DEFAULT 1,
  unit_price_pence  integer NOT NULL,
  amount_pence      integer NOT NULL,
  sort_order        integer NOT NULL DEFAULT 0
);

CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id);

CREATE TABLE payment_methods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id       uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('card','direct_debit')),
  brand           text NOT NULL DEFAULT '',
  last4           text NOT NULL DEFAULT '',
  exp_month       integer,
  exp_year        integer,
  account_name    text NOT NULL DEFAULT '',
  -- opaque reference from the payment processor; no PAN ever touches this table
  provider_token  text NOT NULL,
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_methods_member_idx ON payment_methods (member_id);
CREATE UNIQUE INDEX payment_methods_one_default
  ON payment_methods (member_id) WHERE is_default;

CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id         uuid REFERENCES invoices(id) ON DELETE SET NULL,
  member_id          uuid NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  payment_method_id  uuid REFERENCES payment_methods(id) ON DELETE SET NULL,
  amount_pence       integer NOT NULL,
  status             text NOT NULL
                       CHECK (status IN ('pending','succeeded','failed','refunded')),
  method             text NOT NULL DEFAULT 'card',
  reference          text NOT NULL DEFAULT '',
  failure_reason     text NOT NULL DEFAULT '',
  processed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payments_member_idx ON payments (member_id, processed_at DESC);
CREATE INDEX payments_invoice_idx ON payments (invoice_id);

-- ──────────────────────────────────────────────────────── consents ────────

-- Append only. Never UPDATE a row here; write a new one.
CREATE TABLE consents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id       uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  purpose         text NOT NULL
                    CHECK (purpose IN ('marketing_email','marketing_sms','photography',
                                       'health_data','third_party_sharing')),
  granted         boolean NOT NULL,
  policy_version  text NOT NULL DEFAULT '1.0',
  source          text NOT NULL DEFAULT 'dashboard'
                    CHECK (source IN ('signup','dashboard','import','staff')),
  ip              inet,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX consents_member_purpose_idx ON consents (member_id, purpose, created_at DESC);

-- Current consent state: the most recent row wins.
CREATE VIEW current_consents AS
SELECT DISTINCT ON (member_id, purpose)
       member_id, purpose, granted, policy_version, source, created_at
FROM consents
ORDER BY member_id, purpose, created_at DESC;

-- ───────────────────────────────────────────── data subject requests ──────

CREATE TABLE data_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  type          text NOT NULL
                  CHECK (type IN ('export','erasure','rectification','restriction','objection')),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_progress','completed','rejected','cancelled')),
  detail        text NOT NULL DEFAULT '',
  requested_at  timestamptz NOT NULL DEFAULT now(),
  -- Article 12(3): respond within one month
  due_at        timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  completed_at  timestamptz
);

CREATE INDEX data_requests_member_idx ON data_requests (member_id, requested_at DESC);

-- ─────────────────────────────────────────────────────── audit log ────────

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  member_id   uuid REFERENCES members(id) ON DELETE SET NULL,
  actor       text NOT NULL DEFAULT 'member'
                CHECK (actor IN ('member','staff','system')),
  action      text NOT NULL,
  entity      text NOT NULL DEFAULT '',
  entity_id   text NOT NULL DEFAULT '',
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          inet,
  user_agent  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_member_idx ON audit_log (member_id, created_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action);

-- ───────────────────────────────────────────── classes & attendance ───────

CREATE TABLE class_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  coach       text NOT NULL DEFAULT '',
  level       text NOT NULL DEFAULT 'all'
                CHECK (level IN ('all','beginner','intermediate','advanced')),
  location    text NOT NULL DEFAULT 'Main floor',
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  capacity    integer NOT NULL DEFAULT 20,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX class_sessions_start_idx ON class_sessions (starts_at);

CREATE TABLE bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_session_id  uuid NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  member_id         uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'booked'
                      CHECK (status IN ('booked','attended','no_show','cancelled')),
  booked_at         timestamptz NOT NULL DEFAULT now(),
  cancelled_at      timestamptz,
  UNIQUE (class_session_id, member_id)
);

CREATE INDEX bookings_member_idx ON bookings (member_id, booked_at DESC);
