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

// Backdate a message's `created_at`. Pod-creator-only (or message author);
// no general-purpose user authorization for editing other people's chronology.
//
// Why this exists: chat history demos / fixtures need plausible timestamps
// (yesterday / this morning / etc.) but POST /:podId always stamps with NOW().
// Direct PG UPDATE works for ops with PG access; this route is the same
// capability for ops without PG access (Aiven IP-allowlisted, kubectl exec
// timing out on new sessions, etc.).
//
// Body: { created_at: ISO8601 string }
router.patch('/:id/created-at', auth, async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const { created_at: createdAtRaw } = req.body || {};
    const ts = createdAtRaw ? new Date(createdAtRaw) : null;
    if (!ts || Number.isNaN(ts.getTime())) {
      return res.status(400).json({ msg: 'created_at (ISO8601) is required' });
    }

    // Authorization: load the message, then check author or pod-creator.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const PGMessage = require('../models/pg/Message');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const Pod = require('../models/Pod');
    const userId = req.userId || req.user?.id;
    if (!userId) return res.status(401).json({ msg: 'auth required' });

    const message = await PGMessage.findById(id);
    if (!message) return res.status(404).json({ msg: 'message not found' });

    if (String(message.user_id) !== String(userId)) {
      const pod = await Pod.findById(message.pod_id);
      if (!pod || String(pod.createdBy) !== String(userId)) {
        return res.status(403).json({ msg: 'must be message author or pod creator' });
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { pool } = require('../config/db-pg');
    const r = await pool.query(
      'UPDATE messages SET created_at = $1, updated_at = $1 WHERE id = $2 RETURNING id, created_at',
      [ts, id],
    );
    if (r.rowCount === 0) return res.status(404).json({ msg: 'message not found in PG' });
    return res.json({ ok: true, id: r.rows[0].id, created_at: r.rows[0].created_at });
  } catch (err: any) {
    console.error('backdate route error:', err?.message || err);
    return res.status(500).json({ msg: 'backdate failed' });
  }
});

module.exports = router;

export {};
