import type { NextFunction, Request, Response } from 'express';
import { STATUS_CODES } from 'http';

/**
 * The last error handler in the app. An error a route or middleware passes on
 * (a body that is not JSON, a body over the size limit, a disallowed origin,
 * an unhandled throw) is answered with its status and that status's standard
 * phrase, nothing else. The detail goes to the server log.
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

export const finalErrorHandler = (err: unknown, req: Request, res: Response, next: NextFunction): void => {
  if (res.headersSent) {
    // Too late to answer; Express closes the connection.
    next(err);
    return;
  }
  const status = statusOf(err);
  if (status >= 500) {
    console.error('[http] unhandled error on %s %s:', req.method, req.path, err);
  } else {
    console.warn('[http] %d on %s %s:', status, req.method, req.path, (err as Error)?.message);
  }
  res.status(status).json({ error: STATUS_CODES[status] || 'Error' });
};

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { finalErrorHandler };
