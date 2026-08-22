# Weston Warriors — member platform

The member area behind the marketing site: accounts, membership, billing,
class booking and a full set of data rights. Express and PostgreSQL, server
rendered, no front-end framework and no build step.

## Running it

You need Node 20+ and PostgreSQL 14+.

```bash
# 1. database
createdb weston_warriors
psql -c "CREATE ROLE warriors LOGIN PASSWORD 'warriors_dev'"
psql -c "ALTER DATABASE weston_warriors OWNER TO warriors"

# 2. app
cd app
cp .env.example .env          # then fill in SESSION_SECRET
npm install
npm run migrate
npm run seed
npm start                     # http://localhost:3000
```

`npm run reset` re-runs the migration and reseeds. `npm run dev` restarts on
change. `npm test` runs the unit tests, which need the database.

The server hosts the marketing site from the repository root as well as the
dashboard, so everything is one origin and the session cookie works across
both. Open `/` for the site and `/dashboard` for the member area.

### Seeded accounts

Two members, two invoices each. Sign in at `/signin` with:

| Email | Password | State |
| --- | --- | --- |
| `demo@westonwarriors.example` | `WarriorsTest2026` | Contender, active, both invoices paid |
| `overdue@westonwarriors.example` | `WarriorsTest2026` | Initiate, past due, one declined card payment |

`npm run seed` prints these at the end of every run, so you never have to come
back here for them.

The seed is deterministic and small on purpose: enough to populate every screen
and to show the two states worth looking at, without rows you have to scroll
past to reach the one you care about.

### The master dashboard

Admins have their own area at **`/master`**, behind **its own sign in page** at
`/master/signin`. It is not the member sign in page with a role check bolted on:
admins are a separate table with separate sessions and a cookie scoped to
`/master`, so a member's browser never even sends a credential there. A member
session that navigates to `/master` is bounced to the admin door.

There are two kinds of account in this system and no more: **members and
admins**. Every admin can do everything an admin can do. There is no second
tier that sees the numbers but may not touch them, because the club does not
work that way and a tier like that means writing half this dashboard twice.

| Email | Password |
| --- | --- |
| `dean@westonwarriors.example` | `MasterFloor2026` |
| `simon@westonwarriors.example` | `MasterFloor2026` |

It answers what a club asks on a Monday morning:

- **How many participants**, how many are on a membership, how many joined this month
- **How many are square with us**, as a count and a percentage
- **Who is in shortfall**, what they owe, how overdue, worst case first
- **What was taken** in the last 30 days, and how much of it came off the card rails
- **Reconciliation**: put last night's cash, a bank transfer or a terminal
  receipt against the invoice it belongs to, in one line per invoice with the
  outstanding amount pre-filled

Reconciliation is append-only. Recording a payment writes a row stamped with the
admin who took it. Correcting a mistake writes a **reversal** rather
than editing or deleting the original, never an edit or a delete. Clearing
an invoice in full also lifts the membership back out of `past_due`.

Admins can read a participant's record but cannot edit their personal details.
Rectification is the member's own right under Article 16 and stays on their
profile.

### Pricing

`/master/plans` is where what the club charges is set: create a plan, rename
one, edit what it includes, change the price, or stop offering it.

The rule that makes the rest of it work: **a plan holds the price we sell at
today, a subscription holds the price that member was signed up at.** They are
two columns, not one, so putting a plan up prices nobody by accident.

Every price change therefore asks one question in the same form:

| Applied to | What happens |
| --- | --- |
| **New members only** | Only the plan moves. Everybody already on it keeps paying what they pay. |
| **Everyone on this plan** | Current memberships move too, and it lands at their next renewal. Invoices already issued keep their own totals. |

Either way the change is written to `plan_price_changes` with the old price, the
new one, how it applied, how many memberships moved, who did it and why. "Who
put the juniors up to £40, and when" is a question that gets asked months later.

Two consequences worth having:

- **Concessions are a supported state.** Set one membership's own rate from the
  participant's record with a reason attached: hardship, second family member,
  a deal somebody did at the door. It survives a plan increase unless that
  increase is applied to everyone. The pricing page lists everybody held on a
  rate that is not the list price, with one click to move them back, so a
  concession lives in a column rather than in somebody's memory.
- **The month is booked at what people actually pay.** The `plan_rollup` view
  sums subscription prices, not list prices, so a plan sold at £45 with half
  its members on £35 reports the number that pays the rent.

The marketing site's price list follows this automatically when the platform is
serving it: the page ships with prices in the markup, then asks `/api/plans` and
corrects itself. On a static host with no server behind it, the authored markup
stands.

### Avatars

Members pick from ten faces and cannot upload anything. That is a product
decision with a useful consequence: there is no file upload path in the
application, so no image parsing, no storage bucket, no EXIF to strip, no
moderation queue and no way to smuggle a payload in through an avatar. The
column holds a key and the key is checked against `assets/avatars/manifest.json`.

Illustrations are credited to **Alesyia Volkova**. Regenerate the set with
`npm run avatars` from the repository root; `tools/make-avatars.mjs` holds the
drawing code, so a change to one helper moves all ten faces together.

## What is in it

```
src/server.js        express app, security headers, static hosting, errors
src/config.js        environment, refuses to boot without a real secret in prod
src/db.js            pg pool, query/one/transaction helpers
src/auth.js          scrypt passwords, sessions, CSRF, throttling, audit
src/erasure.js       the sweep that actually carries out erasure requests
src/validate.js      input rules
src/views/layout.js  HTML rendering and escaping
src/routes/auth.js       sign up, sign in, sign out
src/routes/dashboard.js  overview, class timetable and booking
src/routes/account.js    membership, billing, invoices, profile
src/routes/privacy.js    consent, export, erasure, security
src/routes/master.js     admin dashboard: counts, shortfall, reconciliation
src/routes/master-pricing.js  plans, price changes, concessions
src/admin-auth.js        admin sessions, separate from members entirely
src/views/master-layout.js  the admin shell and its own sign in page
db/migrations/       schema
db/seed.js           test data
test/                unit tests
```

## Security

- **Passwords** use scrypt from `node:crypto` (N=16384, r=8, p=1) with a random
  16 byte salt per user. No native dependency to build at deploy time.
- **Sessions** are 32 random bytes in an httpOnly, SameSite=Lax cookie, secure
  in production. Only an HMAC of the token is stored, so a database leak does
  not hand over live sessions. Signing in rotates the session; changing a
  password revokes every other one.
- **CSRF** is enforced on every state-changing route by a token bound to the
  session, not a global secret.
- **SQL** is parameterised everywhere. There is no string interpolation of user
  input into a query in this codebase.
- **Output** goes through `esc()` at every interpolation point.
- **Authorisation** is by scoping rather than checking: every query filters on
  `member_id`, so another member's invoice does not 404 after a permission
  check, it simply is not in the result set.
- **Card numbers** are never accepted or stored. `payment_methods` holds a
  processor token and the display fragments a processor hands back.
- **Login throttling** per IP, plus a per-account lockout after eight failures.
- **Admins are a separate system**, not a role column: separate table, separate
  sessions, separate cookie scoped to `/master`, a tighter lockout after five
  failures and a seven day session instead of thirty. There is no flag on a
  member row that could be flipped to gain admin access, because there is no
  such flag: `members` has no role column at all.

Not done, and worth doing before real members use it: email verification and
password reset (both need a mail provider), a real payment processor, and
moving the login throttle into Redis or the database so it survives a restart
and works across instances.

## Data protection

The dashboard implements these directly rather than pointing at an email
address:

| Right | Where |
| --- | --- |
| Access (Art. 15) | Account activity log, and the export |
| Rectification (Art. 16) | Profile, editable by the member |
| Erasure (Art. 17) | Request, 30 day grace, then anonymisation |
| Restriction (Art. 18) | Request recorded for an admin |
| Portability (Art. 20) | JSON export of the complete record |
| Objection (Art. 21) | Request recorded; marketing stops immediately |
| Consent (Art. 7) | Granular, withdrawable, evidenced by a ledger |

Two design decisions worth knowing:

**Consent is an append-only ledger.** Article 7(1) requires the controller to
demonstrate that consent was given, which a boolean column cannot do. Every
decision is a new row with a timestamp, policy version and source; the current
state is a view over the latest row per purpose.

**Erasure anonymises rather than deletes.** Names, contact details, address,
emergency contact, medical notes, password, sessions and payment methods all
go. Invoices, invoice lines and payments stay, pointing at a tombstone member
row, because UK tax law requires six years of financial records and Article
17(3)(b) permits retention for a legal obligation. The audit log and consent
ledger survive with identifiers stripped, since they are the evidence that the
erasure was requested and carried out.

The sweep runs hourly inside the web process. At any real scale it belongs in a
scheduled job instead: `runErasureSweep()` in `src/erasure.js` is safe to call
from anywhere.

## Deploying to Vercel with Supabase

This cannot run on GitHub Pages: Pages serves static files, and this needs Node
and PostgreSQL. The repository is set up for Vercel plus Supabase.

**1. Supabase.** Create a project, then take two connection strings from
Settings → Database:

- the **direct** connection (port 5432) for migrations
- the **transaction pooler** (port 6543) for the app

Run the migrations against the direct connection from your machine:

```bash
DATABASE_URL='postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres' \
  npm run migrate
```

Seeding is optional and development only. Do not run it against a database with
real members in it: it truncates every table first.

**2. Vercel.** Import the repository. `vercel.json` already routes every request
to `api/index.js`, which is the same Express app, so there is one code path in
development and in production. Set these environment variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the **pooler** string, port 6543 |
| `SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `NODE_ENV` | `production` |
| `CRON_SECRET` | any long random string |

`DATABASE_SSL` is inferred from the hostname, so Supabase connections encrypt
without you setting anything. If you want certificate verification rather than
encryption alone, put Supabase's CA PEM in `DATABASE_CA`.

**3. Erasure on a schedule.** A serverless function has no process to hold a
timer, so the hourly sweep in `server.js` never runs there. `vercel.json`
registers a daily cron against `/internal/erasure-sweep`, which is a 404 to
anyone without the `CRON_SECRET` bearer token.

### Things to know about this shape

- Every request, including the marketing site, goes through the function.
  That is the simplest correct arrangement, and it means the vendored
  `three.module.js` is served by a lambda rather than a CDN. If that matters,
  split the static site into its own Vercel project and point the member links
  at the platform's domain.
- The login throttle lives in memory, so on serverless it is per-instance
  rather than global. The per-account lockout in the database still holds.
  Move the IP throttle into Postgres or Redis before you rely on it.
- The transaction pooler does not support session-level features. This app
  does not use them: no `LISTEN`, no advisory locks, no named prepared
  statements.
