/**
 * Vercel entry point.
 *
 * Vercel gives every request to this function; the Express app inside handles
 * both the marketing site and the dashboard, so there is one code path in
 * development and in production.
 */

import { app } from '../app/src/server.js';

export default app;
