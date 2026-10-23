import express from 'express';
import rateLimit from 'express-rate-limit';
import { createHash } from 'crypto';
import { cloudflareIpRateLimitKeyGenerator } from '../../middleware/ipRateLimit';
import { AgentInstallation } from '../../models/AgentRegistry';
import RoomGrant from '../../models/RoomGrant';
import Integration from '../../models/Integration';
import Pod from '../../models/Pod';
import User from '../../models/User';
import AgentIdentityService from '../../services/agentIdentityService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  getUserId, isGlobalAdminUser, normalizeInstanceId,
} = require('./helpers');

const router = express.Router();
const grantManageLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: express.Request): string => {
    const bearer = req.get('Authorization');
    if (bearer) return `grant-manage:${createHash('sha256').update(bearer).digest('hex').slice(0, 16)}`;
    return cloudflareIpRateLimitKeyGenerator(req as never);
  },
  handler: (_req, res) => res.status(429).json({ code: 'rate_limited' }),
});

/** The manage page reads one identity, not every grant in a pod. */
router.get('/agents/:name/instances/:instanceId/grants', grantManageLimit, auth, async (req: any, res: any) => {
  try {
    const userId = String(getUserId(req) || '');
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const agentName = String(req.params.name || '').toLowerCase();
    const instanceId = normalizeInstanceId(req.params.instanceId);
    const installations = await AgentInstallation.find({
      agentName, instanceId, status: 'active',
    }).lean();
    if (!installations.length) return res.status(404).json({ error: 'Agent not installed' });

    const isAdmin = req.user?.role === 'admin' || await isGlobalAdminUser(userId);
    // A shared identity reaches every installation. One installer must not
    // inspect another installer's grants through the shared agent principal.
    if (!isAdmin && !installations.every((row: any) => String(row.installedBy || '') === userId)) {
      return res.status(403).json({ error: 'Only the agent installer or an instance admin can manage this agent' });
    }

    const username = AgentIdentityService.buildAgentUsername(agentName, instanceId);
    const agentUser = await User.findOne({ username, isBot: true }).select('_id').lean();
    if (!agentUser) return res.json({ grants: [] });

    const agentId = String(agentUser._id);
    const grants = await RoomGrant.find({ audience: agentId }).sort({ createdAt: -1 }).lean();
    const podIds = grants.filter((row) => row.target.kind === 'pod').map((row) => row.target.id);
    const pods = podIds.length
      ? await Pod.find({ _id: { $in: podIds } }).select('name members').lean()
      : [];
    const podById = new Map(pods.map((pod: any) => [String(pod._id), pod]));
    const visibleGrants = grants.filter((row) => {
      if (row.target.kind === 'seat') return row.target.id === agentId;
      const pod: any = podById.get(row.target.id);
      return Boolean(pod?.members?.some((member: any) => String(member?.userId || member) === agentId));
    });

    const connections = await Promise.all(Array.from(new Set(visibleGrants.map((row) => row.connectionId)))
      .map(async (connectionId) => {
        const byId = /^[a-f\d]{24}$/i.test(connectionId)
          ? await Integration.findById(connectionId).select('type createdBy config.entryId config.linkedUserId').lean()
          : null;
        const connection = byId || await Integration.findOne({ installationId: connectionId })
          .select('type createdBy config.entryId config.linkedUserId').lean();
        return [connectionId, connection] as const;
      }));
    const connectionById = new Map(connections);
    const granterIds = Array.from(new Set(connections
      .map(([, connection]) => String(connection?.createdBy || connection?.config?.linkedUserId || ''))
      .filter(Boolean)));
    const granters = granterIds.length
      ? await User.find({ _id: { $in: granterIds } }).select('username displayName').lean()
      : [];
    const granterById = new Map(granters.map((user: any) => [String(user._id), user]));

    return res.json({
      grants: visibleGrants.map((grant) => {
        const connection = connectionById.get(grant.connectionId);
        const granterId = String(connection?.createdBy || connection?.config?.linkedUserId || '');
        const granter: any = granterById.get(granterId);
        return {
          grantId: grant.grantId,
          tools: grant.tools,
          connector: connection?.type === 'github-app' ? 'GitHub' : connection?.config?.entryId || null,
          podId: grant.target.kind === 'pod' ? grant.target.id : null,
          podName: grant.target.kind === 'pod'
            ? (podById.get(grant.target.id) as any)?.name || null : null,
          grantedBy: granter?.displayName || granter?.username || null,
          createdAt: grant.createdAt,
          expiresAt: grant.expiresAt,
          revokedAt: grant.revokedAt || null,
          canRevoke: Boolean(connection) && (isAdmin || granterId === userId),
        };
      }),
    });
  } catch (error) {
    console.error('Error loading agent grants:', error);
    return res.status(500).json({ error: 'Failed to load agent grants' });
  }
});

module.exports = router;
export {};
