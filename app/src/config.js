/**
 * Configuration, read once from the environment.
 *
 * Nothing here has a production-ready default: if SESSION_SECRET is missing in
 * production the process refuses to start rather than quietly using a known
 * value.
 */

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

function required(name, fallback) {
  const value = process.env[name] || fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  env,
  isProd,
  port: Number(process.env.PORT || 3000),

  databaseUrl: required(
    'DATABASE_URL',
    isProd ? '' : 'postgres://warriors:warriors_dev@127.0.0.1:5432/weston_warriors'
  ),

  // Used to sign nothing today, but rotating it invalidates every session
  // because session lookup is by hash of the raw token plus this pepper.
  sessionSecret: required('SESSION_SECRET', isProd ? '' : 'dev-only-not-a-secret'),

  sessionCookie: 'ww_session',
  sessionTtlDays: 30,

  // Current version of the privacy policy consents are recorded against.
  policyVersion: process.env.POLICY_VERSION || '1.0',

  // Where the static marketing site lives, relative to app/
  staticRoot: process.env.STATIC_ROOT || '..',
};

if (isProd && config.sessionSecret === 'dev-only-not-a-secret') {
  throw new Error('SESSION_SECRET must be set to a real value in production');
}
