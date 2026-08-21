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

  // TLS to the database. Managed providers need it; a local socket does not.
  // Set explicitly with DATABASE_SSL=true|false, otherwise inferred.
  databaseSsl: process.env.DATABASE_SSL
    ? process.env.DATABASE_SSL === 'true'
    : /supabase|neon|render|amazonaws|sslmode=require/i.test(process.env.DATABASE_URL || ''),
  databaseCa: process.env.DATABASE_CA || '',

  // Vercel and friends set this. It changes how we size the connection pool
  // and stops us starting an interval timer that a lambda would never run.
  isServerless: !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),

  // Shared secret for the scheduled erasure endpoint.
  cronSecret: process.env.CRON_SECRET || '',
};

if (isProd && config.sessionSecret === 'dev-only-not-a-secret') {
  throw new Error('SESSION_SECRET must be set to a real value in production');
}
