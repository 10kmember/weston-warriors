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
| Restriction (Art. 18) | Request recorded for staff |
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
