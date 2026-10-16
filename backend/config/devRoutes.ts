/**
 * Dev tooling routes (/api/dev, /api/test/bot) exist only where an operator
 * opts in with COMMONLY_ENABLE_DEV_ROUTES=true. Local docker-compose sets it;
 * nothing deployed does.
 *
 * Never gate these on NODE_ENV: a deployed instance can run with
 * NODE_ENV=development, and these routes write agent events with
 * caller-supplied fields that the real producers set server-side.
 */
import type { NextFunction, Request, Response } from 'express';

export const devRoutesEnabled = (): boolean => process.env.COMMONLY_ENABLE_DEV_ROUTES === 'true';

/** Router guard: without the opt-in the routes do not exist, so 404 rather than 403. */
export const requireDevRoutes = (_req: Request, res: Response, next: NextFunction): void => {
  if (devRoutesEnabled()) {
    next();
    return;
  }
  res.status(404).json({ error: 'Not found' });
};

module.exports = { devRoutesEnabled, requireDevRoutes };
