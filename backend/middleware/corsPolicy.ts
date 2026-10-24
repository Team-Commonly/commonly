import type { CorsOptions } from 'cors';

/**
 * The browser origins the API answers. FRONTEND_URL is a comma-separated list;
 * unset, it is the local dev server and the production shell.
 */
export const buildAllowedOrigins = (raw: string | undefined = process.env.FRONTEND_URL): string[] => {
  if (raw && raw.trim()) {
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return ['http://localhost:3000', 'https://commonly.me'];
};

/**
 * CORS for the HTTP API. A request with no Origin (agents, webhooks, curl) and
 * a request from an allowed origin pass. One from any other origin is refused
 * before it reaches a route, preflight or not. That refusal matters because
 * credentials are allowed (below), so a cross-site request carries the API's
 * cookies.
 *
 * The refusal carries status 403. finalErrorHandler answers an error with its
 * status, so a bare Error here was a 500: every preflight from a page served
 * anywhere else (a local build pointed at production, for one) counted as a
 * server error, and on 2026-10-19 165 of them set off the 5xx alert.
 */
export const corsOptions = (allowedOrigins: string[]): CorsOptions => ({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(Object.assign(new Error('Not allowed by CORS'), { status: 403 }));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token'],
  // Slack OAuth starts in the authenticated shell and returns through an
  // unauthenticated callback. The browser-bound nonce is HttpOnly on the
  // API origin, so the authorize-url request must be allowed to persist it
  // when the shell is served from commonly.me.
  credentials: true,
});

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { buildAllowedOrigins, corsOptions };
