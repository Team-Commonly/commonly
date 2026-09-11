import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'crypto';
import { Types } from 'mongoose';
import Integration from '../models/Integration';
import Pod from '../models/Pod';
import RoomGrant from '../models/RoomGrant';
import {
  assertGrantUsable,
  attenuateGrant,
  createGrant,
  effectiveAudience,
  revokeGrant,
  RoomGrantError,
} from '../services/roomGrantService';
import type { RoomGrantCreateInput } from '../services/roomGrantService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');

const router = express.Router();

const grantRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: express.Request): string => {
    const authHeader = req.get('Authorization') || req.get('x-auth-token');
    if (authHeader) return `grant:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
    return req.ip ? ipKeyGenerator(req.ip) : 'anon';
  },
  handler: (_req, res) => res.status(429).json({ message: 'rate limit exceeded: 60 grant operations per 60s' }),
});

interface AuthenticatedRequest extends express.Request {
  userId?: string;
}

const callerId = (req: AuthenticatedRequest): string => {
  const user = req.user as { id?: string; _id?: string } | undefined;
  return String(req.userId || user?.id || user?._id || '');
};

const findConnection = async (connectionId: string): Promise<any> => {
  if (Types.ObjectId.isValid(connectionId)) {
    const byId = await Integration.findById(connectionId);
    if (byId) return byId;
  }
  return Integration.findOne({ installationId: connectionId });
};

const connectionOwnerId = (connection: any): string => String(
  connection?.createdBy || connection?.config?.linkedUserId || '',
);

const getTargetMembers = async (target: { kind: 'pod' | 'seat'; id: string }): Promise<string[] | undefined> => {
  // Seat grants already identify their single target; there is no pod census
  // to intersect for them. The broker still checks the explicit audience.
  if (target.kind !== 'pod') return undefined;
  if (!Types.ObjectId.isValid(target.id)) {
    throw new RoomGrantError('invalid_target', 'target.id must be a valid pod id');
  }
  const pod = await Pod.findById(target.id).select('members').lean();
  if (!pod) throw new RoomGrantError('target_not_found', 'target pod not found', 404);
  return (pod.members || []).map((member: Types.ObjectId | string) => String(member));
};

const ensureTargetAccess = async (target: { kind: 'pod' | 'seat'; id: string }, userId: string): Promise<string[]> => {
  const members = (await getTargetMembers(target)) || [];
  if (target.kind === 'pod' && !members.includes(userId)) {
    throw new RoomGrantError('access_denied', 'caller is not a member of the target pod', 403);
  }
  return members;
};

const handleError = (res: express.Response, error: unknown): express.Response => {
  if (error instanceof RoomGrantError) {
    return res.status(error.statusCode).json({ error: error.code, message: error.message, details: error.details });
  }
  console.error('Room grant route error:', error);
  return res.status(500).json({ error: 'server_error', message: 'Server error' });
};

/** Mint a root grant. The connection owner is the granter; it is never taken from the body. */
router.post('/', grantRateLimit, auth, async (req: AuthenticatedRequest, res: express.Response) => {
  try {
    const body = (req.body || {}) as Record<string, any>;
    const userId = callerId(req);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const connectionId = String(body.connectionId || '').trim();
    const connection = await findConnection(connectionId);
    if (!connection) return res.status(404).json({ error: 'connection_not_found' });
    if (connectionOwnerId(connection) !== userId) return res.status(403).json({ error: 'access_denied' });
    if (connection.type !== 'github-app' || connection.status !== 'connected' || connection.revokedAt) {
      return res.status(403).json({ error: 'connection_mismatch', message: 'connection is not a connected GitHub App installation' });
    }

    const target = body.target;
    if (!target || (target.kind !== 'pod' && target.kind !== 'seat')) {
      return res.status(400).json({ error: 'invalid_target', message: 'target.kind must be pod or seat' });
    }
    const members = await ensureTargetAccess(target, userId);
    // Pod grants default to the current member snapshot. A seat has no pod
    // census, so its own seat id is the minimum audience and can be extended
    // explicitly by the granter.
    const audience = target.kind === 'seat'
      ? (body.audience === undefined ? [target.id] : body.audience)
      : (body.audience === undefined ? members : body.audience);
    const audienceValues = Array.isArray(audience) ? audience.map(String) : audience;
    if (
      target.kind === 'seat'
      && (!Array.isArray(audienceValues)
        || audienceValues.length !== 1
        || audienceValues[0] !== String(target.id))
    ) {
      return res.status(400).json({ error: 'invalid_audience', message: 'seat audience must be the target seat' });
    }
    if (
      target.kind === 'pod'
      && Array.isArray(audienceValues)
      && audienceValues.some((id: string) => !members.includes(id))
    ) {
      return res.status(400).json({ error: 'invalid_audience', message: 'audience must be current target members' });
    }

    const grantInput: RoomGrantCreateInput = {
      connectionId,
      installationId: String(body.installationId || ''),
      target,
      tools: body.tools,
      writeMode: body.writeMode,
      budget: body.budget,
      audience: audienceValues,
      expiresAt: body.expiresAt,
      brokerId: String(body.brokerId || ''),
    };
    const grant = await createGrant(grantInput);
    return res.status(201).json(grant);
  } catch (error) {
    return handleError(res, error);
  }
});

/** Agent-only delegation; all parent capabilities are loaded server-side. */
router.post(
  '/:grantId/attenuate',
  grantRateLimit,
  agentRuntimeAuth,
  async (req: AuthenticatedRequest, res: express.Response) => {
  try {
    const parent = await RoomGrant.findOne({ grantId: req.params.grantId });
    if (!parent) return res.status(404).json({ error: 'grant_not_found' });
    const agentId = String(req.agentUser?._id || '');
    if (!agentId) return res.status(401).json({ error: 'agent_identity_required' });
    const members = await getTargetMembers(parent.target);
    await assertGrantUsable({
      grant: parent,
      agentUserId: agentId,
      // Seat targets have no pod census; the explicit audience is the live
      // membership context for the seat-grant check.
      currentMemberIds: members ?? parent.audience,
    });
    const body = (req.body || {}) as Record<string, unknown>;
    const child = await attenuateGrant({
      parentGrantId: parent.grantId,
      tools: body.tools as string[] | undefined,
      writeMode: body.writeMode as any,
      budget: body.budget as any,
      audience: body.audience as string[] | undefined,
      expiresAt: body.expiresAt as string | undefined,
    });
    return res.status(201).json(child);
  } catch (error) {
    return handleError(res, error);
  }
  },
);

const revokeHandler = async (req: AuthenticatedRequest, res: express.Response): Promise<express.Response> => {
  try {
    const grant = await RoomGrant.findOne({ grantId: req.params.grantId });
    if (!grant) return res.status(404).json({ error: 'grant_not_found' });
    const userId = callerId(req);
    const connection = await findConnection(grant.connectionId);
    if (!connection || connectionOwnerId(connection) !== userId) {
      return res.status(403).json({ error: 'access_denied' });
    }
    const revoked = await revokeGrant(grant.grantId);
    return res.json({ grantId: grant.grantId, revoked });
  } catch (error) {
    return handleError(res, error);
  }
};

router.post('/:grantId/revoke', grantRateLimit, auth, revokeHandler);
router.delete('/:grantId', grantRateLimit, auth, revokeHandler);

// Read is intentionally member-scoped. The route exposes the effective
// audience, never raw connection material or the owner's secret reference.
router.get('/:grantId', grantRateLimit, auth, async (req: AuthenticatedRequest, res: express.Response) => {
  try {
    const grant = await RoomGrant.findOne({ grantId: req.params.grantId }).lean();
    if (!grant) return res.status(404).json({ error: 'grant_not_found' });
    const members = await ensureTargetAccess(grant.target, callerId(req));
    const currentMembers = grant.target.kind === 'seat' ? grant.audience : members;
    return res.json({ ...grant, effectiveAudience: effectiveAudience(grant, currentMembers) });
  } catch (error) {
    return handleError(res, error);
  }
});

export default router;
module.exports = router;
