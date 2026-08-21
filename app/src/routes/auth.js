/**
 * Sign up, sign in, sign out.
 *
 * Consent is captured at signup and written to the ledger in the same
 * transaction as the member row, so there is never a member without a recorded
 * consent decision.
 */

import express from 'express';
import { query, one, transaction } from '../db.js';
import { config } from '../config.js';
import {
  hashPassword, verifyPassword, burnPasswordTime, createSession, setSessionCookie,
  clearSessionCookie, revokeSession, requireGuest, requireCsrf, throttleLogin,
  recordFailedLogin, clearLoginAttempts, audit,
} from '../auth.js';
import { isEmail, passwordProblem, str, Errors, isDate, ageFrom } from '../validate.js';
import { page, esc, csrf, field } from '../views/layout.js';

export const authRouter = express.Router();

/* ------------------------------------------------------------- sign in --- */

function signinPage({ email = '', error = '', next = '' }) {
  return page({
    title: 'Sign in',
    body: `
    <div class="gate">
      <p class="gate__eyebrow mono">MEMBER ACCESS</p>
      <h1 class="gate__title">Sign In</h1>
      <p class="gate__lede">Manage your membership, billing and data.</p>

      ${error ? `<div class="banner banner--bad">${esc(error)}</div>` : ''}

      <form method="post" action="/signin" class="gate__form" novalidate>
        <input type="hidden" name="next" value="${esc(next)}" />
        ${field('email', 'EMAIL', email, { type: 'email', required: true, autocomplete: 'email' })}
        ${field('password', 'PASSWORD', '', { type: 'password', required: true, autocomplete: 'current-password' })}
        <button class="btn btn--solid btn--full" type="submit">Sign In</button>
      </form>

      <p class="gate__alt mono">
        NO ACCOUNT? <a href="/join">CREATE ONE</a>
      </p>
    </div>`,
  });
}

authRouter.get('/signin', requireGuest, (req, res) => {
  res.send(signinPage({ next: str(req.query.next, 200) }));
});

authRouter.post('/signin', requireGuest, throttleLogin, async (req, res, next) => {
  try {
    const email = str(req.body.email, 320).toLowerCase();
    const password = String(req.body.password || '');
    const target = str(req.body.next, 200);

    const member = await one(
      `SELECT id, email, password_hash, status, locked_until
         FROM members WHERE lower(email) = $1`,
      [email]
    );

    // Same message and similar work regardless of which half failed.
    if (!member) {
      burnPasswordTime(password);
      recordFailedLogin(req);
      return res.status(401).send(signinPage({ email, next: target, error: 'Email or password is incorrect.' }));
    }

    if (member.locked_until && new Date(member.locked_until) > new Date()) {
      return res.status(429).send(signinPage({
        email, next: target,
        error: 'This account is temporarily locked after repeated failed attempts. Try again shortly.',
      }));
    }

    if (member.status === 'erased') {
      return res.status(401).send(signinPage({ email, next: target, error: 'Email or password is incorrect.' }));
    }

    if (!verifyPassword(password, member.password_hash)) {
      recordFailedLogin(req);
      await query(
        `UPDATE members
            SET failed_login_count = failed_login_count + 1,
                locked_until = CASE WHEN failed_login_count + 1 >= 8
                                    THEN now() + interval '15 minutes' ELSE locked_until END
          WHERE id = $1`,
        [member.id]
      );
      await audit(req, { memberId: member.id, action: 'auth.signin_failed' });
      return res.status(401).send(signinPage({ email, next: target, error: 'Email or password is incorrect.' }));
    }

    if (member.status === 'suspended') {
      return res.status(403).send(signinPage({
        email, next: target,
        error: 'This account is suspended. Speak to a coach on the floor.',
      }));
    }

    const session = await createSession(member.id, {
      ip: req.ip, userAgent: req.get('user-agent'),
    });
    setSessionCookie(res, session.raw, session.expiresAt);
    clearLoginAttempts(req);

    await query(
      `UPDATE members SET last_login_at = now(), failed_login_count = 0, locked_until = NULL
        WHERE id = $1`,
      [member.id]
    );
    await audit(req, { memberId: member.id, action: 'auth.signin' });

    // Only ever redirect to a path on this site.
    const safe = target.startsWith('/') && !target.startsWith('//') ? target : '/dashboard';
    res.redirect(safe);
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------- sign up --- */

function joinPage({ values = {}, errors = new Errors(), error = '' }) {
  const v = (k) => values[k] || '';
  const e = (k) => errors.fields[k] || '';
  return page({
    title: 'Create account',
    body: `
    <div class="gate gate--wide">
      <p class="gate__eyebrow mono">MEMBER ACCESS</p>
      <h1 class="gate__title">Create Account</h1>
      <p class="gate__lede">
        This sets up your member area. Membership itself starts after your
        assessment on the floor.
      </p>

      ${error ? `<div class="banner banner--bad">${esc(error)}</div>` : ''}

      <form method="post" action="/join" class="gate__form" novalidate>
        <div class="grid2">
          ${field('first_name', 'FIRST NAME', v('first_name'), { required: true, autocomplete: 'given-name', error: e('first_name') })}
          ${field('last_name', 'LAST NAME', v('last_name'), { required: true, autocomplete: 'family-name', error: e('last_name') })}
        </div>
        ${field('email', 'EMAIL', v('email'), { type: 'email', required: true, autocomplete: 'email', error: e('email') })}
        <div class="grid2">
          ${field('phone', 'PHONE', v('phone'), { type: 'tel', autocomplete: 'tel', error: e('phone') })}
          ${field('date_of_birth', 'DATE OF BIRTH', v('date_of_birth'), { type: 'date', required: true, error: e('date_of_birth'), hint: 'Members under 16 need a parent or guardian to register in person.' })}
        </div>
        ${field('password', 'PASSWORD', '', { type: 'password', required: true, autocomplete: 'new-password', error: e('password'), hint: 'At least 10 characters. Length beats punctuation.' })}
        ${field('password_confirm', 'CONFIRM PASSWORD', '', { type: 'password', required: true, autocomplete: 'new-password', error: e('password_confirm') })}

        <fieldset class="consents">
          <legend class="mono">PERMISSIONS</legend>
          <p class="consents__note">
            You can change any of these later, and the club keeps a dated record
            of every choice. None of them are required to train here.
          </p>
          <label class="check">
            <input type="checkbox" name="consent_marketing_email" ${values.consent_marketing_email ? 'checked' : ''} />
            <span>Email me about club news, fight nights and timetable changes.</span>
          </label>
          <label class="check">
            <input type="checkbox" name="consent_photography" ${values.consent_photography ? 'checked' : ''} />
            <span>You may use photographs and video of me from the gym floor.</span>
          </label>
          <label class="check">
            <input type="checkbox" name="consent_health_data" ${values.consent_health_data ? 'checked' : ''} />
            <span>
              Store the medical notes I choose to give you, so coaches can train
              me safely. This is health data and is kept separately.
            </span>
          </label>
        </fieldset>

        <label class="check check--terms">
          <input type="checkbox" name="accept_terms" required ${values.accept_terms ? 'checked' : ''} />
          <span>
            I have read how the club uses my data and I want to create an account.
            ${errors.fields.accept_terms ? `<em class="f__err">${esc(errors.fields.accept_terms)}</em>` : ''}
          </span>
        </label>

        <button class="btn btn--solid btn--full" type="submit">Create Account</button>
      </form>

      <p class="gate__alt mono">
        ALREADY REGISTERED? <a href="/signin">SIGN IN</a>
      </p>
    </div>`,
  });
}

authRouter.get('/join', requireGuest, (req, res) => {
  res.send(joinPage({}));
});

authRouter.post('/join', requireGuest, async (req, res, next) => {
  try {
    const values = {
      first_name: str(req.body.first_name, 80),
      last_name: str(req.body.last_name, 80),
      email: str(req.body.email, 320).toLowerCase(),
      phone: str(req.body.phone, 40),
      date_of_birth: str(req.body.date_of_birth, 20),
      consent_marketing_email: !!req.body.consent_marketing_email,
      consent_photography: !!req.body.consent_photography,
      consent_health_data: !!req.body.consent_health_data,
      accept_terms: !!req.body.accept_terms,
    };
    const password = String(req.body.password || '');
    const confirm = String(req.body.password_confirm || '');

    const errors = new Errors();
    if (!values.first_name) errors.add('first_name', 'Required.');
    if (!values.last_name) errors.add('last_name', 'Required.');
    if (!isEmail(values.email)) errors.add('email', 'Enter a valid email address.');
    if (!isDate(values.date_of_birth)) errors.add('date_of_birth', 'Enter your date of birth.');
    else {
      const age = ageFrom(values.date_of_birth);
      if (age === null || age < 0 || age > 120) errors.add('date_of_birth', 'That date does not look right.');
      else if (age < 16) errors.add('date_of_birth', 'Under 16s must be registered in person by a parent or guardian.');
    }
    const pwProblem = passwordProblem(password);
    if (pwProblem) errors.add('password', pwProblem);
    if (password !== confirm) errors.add('password_confirm', 'Passwords do not match.');
    if (!values.accept_terms) errors.add('accept_terms', 'Please confirm to continue.');

    if (errors.any) {
      return res.status(400).send(joinPage({ values, errors }));
    }

    const existing = await one('SELECT id FROM members WHERE lower(email) = $1', [values.email]);
    if (existing) {
      // Not a silent success: this is a login form's sibling, and the honest
      // message is more useful than the enumeration it technically avoids.
      errors.add('email', 'An account already exists for that email. Try signing in.');
      return res.status(409).send(joinPage({ values, errors }));
    }

    const memberId = await transaction(async (tx) => {
      const member = await tx.one(
        `INSERT INTO members (email, password_hash, first_name, last_name, phone,
                              date_of_birth, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active')
         RETURNING id`,
        [values.email, hashPassword(password), values.first_name, values.last_name,
         values.phone, values.date_of_birth || null]
      );

      const consents = [
        ['marketing_email', values.consent_marketing_email],
        ['photography', values.consent_photography],
        ['health_data', values.consent_health_data],
        ['marketing_sms', false],
        ['third_party_sharing', false],
      ];
      for (const [purpose, granted] of consents) {
        await tx.query(
          `INSERT INTO consents (member_id, purpose, granted, policy_version, source, ip)
           VALUES ($1, $2, $3, $4, 'signup', $5)`,
          [member.id, purpose, granted, config.policyVersion, req.ip || null]
        );
      }
      return member.id;
    });

    const session = await createSession(memberId, { ip: req.ip, userAgent: req.get('user-agent') });
    setSessionCookie(res, session.raw, session.expiresAt);
    await audit(req, { memberId, action: 'account.created' });

    res.redirect('/dashboard?welcome=1');
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------ sign out --- */

// CSRF only applies when there is a session to protect; a signed-out POST here
// is a no-op redirect rather than an error.
const csrfIfSignedIn = (req, res, next) => (req.session ? requireCsrf(req, res, next) : next());

authRouter.post('/signout', csrfIfSignedIn, async (req, res, next) => {
  try {
    if (req.session) {
      await revokeSession(req.session.id);
      await audit(req, { memberId: req.session.member_id, action: 'auth.signout' });
    }
    clearSessionCookie(res);
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});
