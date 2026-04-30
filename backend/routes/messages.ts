// ESM import (not require) so CodeQL's js/missing-rate-limiting query
// recognises the limiter on the POST route — same pattern as uploads.ts.
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
  deleteMessage,
} = require('../controllers/messageController');

interface RateLimitReq {
  ip?: string;
  get?: (header: string) => string | undefined;
}
interface RateLimitRes {
  status: (n: number) => RateLimitRes;
  json: (d: unknown) => void;
}

// 60 chat messages/min/user is roomy for a person typing fast (one per second
// for a minute straight) and tight enough to blunt a runaway client looping
// on a flaky send. Keyed on the Authorization header (hashed) so each user's
// bearer token gets its own bucket — NAT'd users sharing one office IP don't
// collide. Falls back to the IPv6-safe ipKeyGenerator for the rare unauth
// path. Applied as the FIRST middleware on POST so CodeQL's
// js/missing-rate-limiting query sees it.
const sendMessageRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: RateLimitReq) => {
    const authHeader = req.get?.('authorization');
    if (authHeader) {
      return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
    }
    return req.ip ? ipKeyGenerator(req.ip) : 'anon';
  },
  handler: (_req: unknown, res: RateLimitRes) => {
    res.status(429).json({ msg: 'rate limit exceeded: 60 messages per 60s' });
  },
});

const router: ReturnType<typeof express.Router> = express.Router();

router.get('/:podId', auth, getMessages);
router.post('/:podId', sendMessageRateLimit, auth, createMessage);
router.delete('/:id', auth, deleteMessage);

module.exports = router;

export {};
