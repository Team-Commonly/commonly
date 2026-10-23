import type { NextFunction, Request, Response } from 'express';
import { STATUS_CODES } from 'http';

/**
 * The last error handler in the app. An error a route or middleware passes on
 * (a body that is not JSON, a body over the size limit, a disallowed origin,
 * an unhandled throw) is answered with its status and that status's standard
 * phrase, nothing else. Only the status is logged: exception messages and
 * request paths can contain OAuth codes or token responses.
 *
 * Without it, Express's built-in handler answers, and its body depends on
 * NODE_ENV. The status is kept as is, so clients that tell 400/401/403/404
 * apart keep working; anything outside 4xx/5xx becomes 500.
 */
const statusOf = (err: unknown): number => {
  const raw = Number((err as { status?: unknown; statusCode?: unknown })?.status
    ?? (err as { statusCode?: unknown })?.statusCode);
  return Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500;
};

export const finalErrorHandler = (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
  if (res.headersSent) {
    // Too late to answer; Express closes the connection.
    next(err);
    return;
  }
  const status = statusOf(err);
  if (status >= 500) {
    console.error('[http] unhandled request error, status %d', status);
  } else {
    console.warn('[http] request error, status %d', status);
  }
  res.status(status).json({ error: STATUS_CODES[status] || 'Error' });
};

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { finalErrorHandler };
