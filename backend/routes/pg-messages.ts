// ESM import (not require) so CodeQL's js/missing-rate-limiting query can
// trace the middleware — it does not follow a rate-limit factory through a
// require() return. Same shape as routes/messages.ts.
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'crypto';

// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const {
  getMessages,
  createMessage,
  updateMessage,
  deleteMessage,
} = require('../controllers/pgMessageController');

interface RateLimitReq { get?: (name: string) => string | undefined; ip?: string }
interface RateLimitRes { status: (code: number) => { json: (body: unknown) => void } }

// Keyed on the bearer token (hashed) rather than IP, so users behind one NAT
// don't share a bucket; falls back to the IPv6-safe key generator for the
// unauth path. Limits mirror routes/messages.ts, which fronts the same tables.
const keyByToken = (req: RateLimitReq) => {
  const authHeader = req.get?.('authorization');
  if (authHeader) {
    return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
  }
  return req.ip ? ipKeyGenerator(req.ip) : 'anon';
};

const readLimit = rateLimit({
  windowMs: 60_000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByToken,
  handler: (_req: unknown, res: RateLimitRes) => {
    res.status(429).json({ msg: 'rate limit exceeded: 240 reads per 60s' });
  },
});

const writeLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByToken,
  handler: (_req: unknown, res: RateLimitRes) => {
    res.status(429).json({ msg: 'rate limit exceeded: 60 writes per 60s' });
  },
});

const router: ReturnType<typeof express.Router> = express.Router();

// Limiter first on every route, so the query sees it ahead of the
// database-touching handler.
router.get('/:podId', readLimit, auth, getMessages);
router.post('/:podId', writeLimit, auth, createMessage);
router.put('/:id', writeLimit, auth, updateMessage);
router.delete('/:id', writeLimit, auth, deleteMessage);

module.exports = router;

export {};
