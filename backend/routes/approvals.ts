// Approval-card resolution — ADR-020 D3, implementing ADR-017's decision
// authorization. HUMAN-ONLY by construction: plain `auth` middleware, never
// dualAuth — "no agent may decide in v1" — with a second isBot check inside
// the service as defense in depth.
// ESM import (not require) so CodeQL's js/missing-rate-limiting query
// recognises the limiter on the POST route — same pattern as messages.ts.
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'crypto';
import type { Request } from 'express';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveApproval } = require('../services/approvalActionService');

const router = express.Router();

// Limiter BEFORE auth — the route-order rule messages.ts documents (limiter
// after auth is the shape CodeQL flags and the shape that lets a hot loop
// burn auth work before being throttled).
const approvalResolveLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const authHeader = req.get('Authorization') || req.get('x-auth-token');
    if (authHeader) {
      return `apr:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
    }
    return req.ip ? ipKeyGenerator(req.ip) : 'anon';
  },
  handler: (_req, res) => res.status(429).json({ error: 'rate limit exceeded: 30 approval decisions per 60s' }),
});

interface AuthedReq {
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  userId?: string;
  user?: { id?: string; _id?: unknown };
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

router.post('/:approvalId/resolve', approvalResolveLimit, auth, async (req: AuthedReq, res: Res) => {
  try {
    const approvalId = String(req.params?.approvalId || '');
    // Deliberately NOT req.agentUser — an agent token must never reach a
    // decision. `auth` doesn't set agentUser, so this is belt to the
    // service-layer isBot suspenders.
    const callerUserId = String(req.userId || req.user?._id || req.user?.id || '');
    if (!callerUserId) return res.status(401).json({ error: 'Unauthorized' });
    if (!/^[a-f0-9]{24}$/i.test(approvalId)) {
      return res.status(400).json({ error: 'Invalid approval id' });
    }
    const decision = String((req.body || {}).decision || '');
    if (decision !== 'approved' && decision !== 'declined') {
      return res.status(400).json({ error: "decision must be 'approved' or 'declined'" });
    }
    const result = await resolveApproval({ approvalId, callerUserId, decision });
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('POST /approvals/:id/resolve error:', err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

module.exports = router;

export {};
