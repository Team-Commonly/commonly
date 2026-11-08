import type { NextFunction, Request, Response } from 'express';

/**
 * A path id that cannot be a Mongo ObjectId (F330).
 *
 * `findById(':podId')` throws a CastError, and a handler whose catch-all says
 * 500 turns a caller's malformed URL into a server error in the ERROR log.
 * On 11-07 prod logged five in 15 hours: a literal ":podId", guessed names
 * like "connections", and an event id with one stray digit.
 *
 * Only the 24-hex form counts. `mongoose.isValidObjectId` also admits any
 * 12-character string, which casts to an id nobody holds; this is the
 * `/^[a-f\d]{24}$/i` check pod routes already make inline.
 */
export const isObjectIdHex = (value: unknown): boolean => (
  typeof value === 'string' && /^[a-f\d]{24}$/i.test(value)
);

/**
 * Route middleware: answer `status` with `body` when `req.params[param]` is
 * not an ObjectId, before the handler casts it. Mount it after auth and rate
 * limits, so it tells a signed-out caller nothing the auth answer would not.
 */
export const requireObjectIdParam = (
  param: string,
  body: Record<string, unknown>,
  status = 400,
) => (req: Request, res: Response, next: NextFunction): void => {
  if (isObjectIdHex(req.params?.[param])) {
    next();
    return;
  }
  res.status(status).json(body);
};

export const INVALID_POD_ID = { code: 'invalid_pod_id', message: 'Invalid pod ID' };

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { isObjectIdHex, requireObjectIdParam, INVALID_POD_ID };
