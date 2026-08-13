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

// Pending approvals for a pod, from the ApprovalAction rows — NOT the card
// messages. Chat messages retire under the 30-day PG retention window while
// approval rows never expire, so "scroll up and find the card" is unreliable
// by construction; this is the durable index the inspector renders. Read
// gate = pod visibility (members); DECIDING stays owner-only in resolve.
router.get('/pending', approvalResolveLimit, auth, async (req: AuthedReq & { query?: Record<string, string> }, res: Res) => {
  try {
    const podId = String((req as { query?: Record<string, string> }).query?.podId || '');
    const callerUserId = String(req.userId || req.user?._id || req.user?.id || '');
    if (!callerUserId) return res.status(401).json({ error: 'Unauthorized' });
    if (!/^[a-f0-9]{24}$/i.test(podId)) {
      return res.status(400).json({ error: 'podId is required' });
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Pod = require('../models/Pod');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const DMService = require('../services/dmService');
    const pod = await Pod.findById(podId);
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    const canView = await DMService.canViewPod(callerUserId, pod);
    if (!canView) return res.status(403).json({ error: 'Access denied' });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ApprovalAction = require('../models/ApprovalAction');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildCardPayload } = require('../services/approvalActionService');
    const rows = await ApprovalAction.find({ podId, status: 'flagged' })
      .sort({ createdAt: -1 })
      .limit(50);
    return res.status(200).json({
      approvals: rows.map((row: unknown) => ({
        ...buildCardPayload(row),
        messageId: (row as { messageId?: string }).messageId || null,
        createdAt: (row as { createdAt?: Date }).createdAt || null,
      })),
    });
  } catch (err) {
    console.error('GET /approvals/pending error:', err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

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
