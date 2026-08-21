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

Every seeded member has the password **`WarriorsTest2026`**.

| Email | What it demonstrates |
| --- | --- |
| `demo@westonwarriors.example` | Active Contender, full invoice history |
| `overdue@westonwarriors.example` | Past due, with a declined card payment |
| `leaving@westonwarriors.example` | Cancelling at period end |
| `paused@westonwarriors.example` | Paused Warrior membership |
| `nosub@westonwarriors.example` | Registered, no membership yet |
| `erasing@westonwarriors.example` | Erasure requested, 26 days of grace left |

The seed is deterministic, so the same run produces the same data every time.
It also writes one already-erased member so the tombstone state is visible.

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

## Deployment

This will not run on GitHub Pages. Pages serves static files only, and this
needs Node and PostgreSQL. Use any host that runs both (Railway, Render, Fly,
or a VPS), point `DATABASE_URL` at a managed Postgres, set `SESSION_SECRET` and
`NODE_ENV=production`, run `npm run migrate` on deploy, and let the app serve
the marketing site too.

If you keep the marketing site on Pages as well, the sign in links in its menu
will 404 there, because there is no server behind them. Either point them at
the platform's domain or serve the whole site from the platform.
