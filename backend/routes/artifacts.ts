/**
 * GET /api/artifacts — every file and page the caller can see, newest first.
 *
 * Direction C PR 5 (Sharpen 66366 §2–§4). dualAuth, the shape reactions use:
 * one implementation, two scope resolvers. A human's scope is the pods they
 * are a member of — the default surface is membership-gated, admins do not
 * bypass here (PR #375). An agent's scope is its active installation set,
 * already resolved by agentRuntimeAuth as `req.agentAuthorizedPodIds`.
 *
 *   ?podId=   fixed → the inspector's Files pane; absent → the Artifacts page
 *   ?kind=    image | page | doc (derived from contentType; page = text/html only)
 *   ?q=       matches originalName only
 *   ?limit=   1..100, default 50
 *   ?after=   opaque cursor from the previous page's `nextCursor`
 */
import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';
import { ARTIFACT_KINDS, listArtifacts } from '../services/artifactService';

const express = require('express');
const auth = require('../middleware/auth');
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
const Pod = require('../models/Pod');

type Res = Response;
type AuthReq = Request & {
  userId?: string;
  user?: { id?: string; _id?: unknown };
  agentUser?: { _id?: unknown };
  agentAuthorizedPodIds?: Array<string | { toString(): string }> | Set<string> | null;
};

const artifactsRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: Request) => cloudflareIpRateLimitKeyGenerator(req),
  handler: (_req: unknown, res: Res) => res.status(429).json({ code: 'rate_limited' }),
});

const dualAuth = (req: any, res: any, next: any) => {
  const bearer = ((req.header?.('Authorization') || '').replace('Bearer ', '')).trim();
  const altHeader = (req.header?.('x-commonly-agent-token') || '').trim();
  const token = bearer || altHeader;
  if (token.startsWith('cm_agent_')) return agentRuntimeAuth(req, res, next);
  return auth(req, res, next);
};

// Two scope resolvers, one read.
async function resolveScope(req: AuthReq): Promise<string[] | null> {
  if (req.agentUser) {
    const ids = req.agentAuthorizedPodIds;
    if (!ids) return [];
    return [...(ids instanceof Set ? ids : ids)].map((id) => String(id));
  }
  const userId = req.userId || req.user?.id || (req.user?._id ? String(req.user._id) : null);
  if (!userId) return null;
  const pods = await Pod.find({ members: userId }).select('_id').lean();
  return pods.map((pod: { _id: unknown }) => String(pod._id));
}

const router: ReturnType<typeof express.Router> = express.Router();

router.get('/', artifactsRateLimit, dualAuth, async (req: AuthReq, res: Res) => {
  try {
    const scope = await resolveScope(req);
    if (scope === null) return res.status(401).json({ msg: 'auth required' });
    const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : null;
    if (kind && !ARTIFACT_KINDS.includes(kind as never)) {
      return res.status(400).json({ msg: `kind must be one of ${ARTIFACT_KINDS.join(', ')}` });
    }
    const podId = typeof req.query.podId === 'string' && req.query.podId ? req.query.podId : null;
    if (podId && !scope.includes(podId)) return res.status(403).json({ msg: 'not a member of this pod' });
    const result = await listArtifacts({
      scopePodIds: scope,
      podId,
      kind,
      q: typeof req.query.q === 'string' ? req.query.q : null,
      limit: req.query.limit,
      after: typeof req.query.after === 'string' ? req.query.after : null,
    });
    return res.json(result);
  } catch (error) {
    console.error('Error listing artifacts:', error);
    return res.status(500).json({ msg: 'Server error' });
  }
});

export default router;
// CJS compat: let require() return the router directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
