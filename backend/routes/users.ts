// ESM imports keep CodeQL's missing-rate-limiting dataflow connected to the
// DB-backed polling route below (same established pattern as messages.ts).
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'crypto';
// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const AgentIdentityService = require('../services/agentIdentityService');
// eslint-disable-next-line global-require
const {
  getCurrentProfile,
  updateProfile,
  getUserById,
  getUserPublicActivity,
  followUser,
  unfollowUser,
} = require('../controllers/userController');

const router: ReturnType<typeof express.Router> = express.Router();

const agentConnectionReadLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: { get?: (header: string) => string | undefined; ip?: string }) => {
    const authHeader = req.get?.('authorization');
    if (authHeader) {
      return `agent-connection:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
    }
    return req.ip ? ipKeyGenerator(req.ip) : 'anon';
  },
  handler: (_req: unknown, res: any) => res.status(429).json({
    msg: 'rate limit exceeded: 60 agent connection reads per 60s',
  }),
});

// Profile writes change the label that every chat message renders. Keep a
// coarse ingress cap ahead of auth (the CodeQL-recognized shape) before doing
// JWT work; the per-user cap below is the durable write protection.
const profileWriteIngressLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: { ip?: string }) => req.ip ? ipKeyGenerator(req.ip) : 'anon',
  handler: (_req: unknown, res: any) => res.status(429).json({
    msg: 'rate limit exceeded: too many profile writes from this address',
  }),
});

// Auth has established the durable identity by this point, so this is the
// quota that prevents any one account from repeatedly changing its chat label.
const profileWriteUserLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: {
    userId?: unknown;
    user?: { id?: unknown; _id?: unknown };
    ip?: string;
  }) => {
    const userId = req.userId || req.user?.id || req.user?._id;
    if (userId) return `profile-write:${String(userId)}`;
    return req.ip ? ipKeyGenerator(req.ip) : 'anon';
  },
  handler: (_req: unknown, res: any) => res.status(429).json({
    msg: 'rate limit exceeded: 30 profile writes per 15 minutes',
  }),
});

router.get('/me/agent-connection', agentConnectionReadLimit, auth, async (req: any, res: any) => {
  try {
    const userId = req.userId || req.user?.id || req.user?._id;
    if (!userId) return res.status(401).json({ msg: 'Unauthorized' });

    // Runtime tokens belong to durable agent User identities, not to the
    // installing human. Restrict the lookup through installations owned by
    // this caller so the endpoint can never disclose another user's agent
    // activity (or any token material).
    const installations = await AgentInstallation.find({
      installedBy: userId,
      status: 'active',
    })
      .select('agentName instanceId podId')
      .lean();

    const installationsByIdentity = new Map((installations || []).map((installation: any) => {
      const agentName = String(installation.agentName || '').trim().toLowerCase();
      const instanceId = String(installation.instanceId || 'default').trim().toLowerCase();
      const identityAgentName = AgentIdentityService.resolveAgentType(agentName);
      return [`${identityAgentName}:${instanceId}`, {
        agentName,
        instanceId,
        podId: String(installation.podId || ''),
        identityAgentName,
      }];
    }));
    const identities = Array.from(installationsByIdentity.values())
      .filter((identity: any) => identity.agentName);

    if (identities.length === 0) {
      return res.json({
        issued: false,
        connected: false,
        lastUsedAt: null,
        connectedAgent: null,
      });
    }

    const agentUsers = await User.find({
      isBot: true,
      $or: identities.map((identity: any) => ({
        'botMetadata.agentName': identity.identityAgentName,
        'botMetadata.instanceId': identity.instanceId,
      })),
    })
      .select('botMetadata.agentName botMetadata.instanceId agentRuntimeTokens.lastUsedAt')
      .lean();

    let latestConnection: { usedAt: Date; identity: any } | null = null;
    for (const agentUser of agentUsers || []) {
      const agentName = String(agentUser.botMetadata?.agentName || '').trim().toLowerCase();
      const instanceId = String(agentUser.botMetadata?.instanceId || 'default').trim().toLowerCase();
      const identity = installationsByIdentity.get(`${agentName}:${instanceId}`);
      if (!identity) continue;
      for (const token of agentUser.agentRuntimeTokens || []) {
        if (!token?.lastUsedAt) continue;
        const usedAt = new Date(token.lastUsedAt);
        if (Number.isNaN(usedAt.getTime())) continue;
        if (!latestConnection || usedAt > latestConnection.usedAt) {
          latestConnection = { usedAt, identity };
        }
      }
    }

    return res.json({
      // "Issued" is deliberately installation ownership, not pod membership
      // or token presence. Joining an agent-rich community pod must not make a
      // newcomer look onboarded when they have attached nothing themselves.
      issued: true,
      connected: latestConnection !== null,
      lastUsedAt: latestConnection ? latestConnection.usedAt.toISOString() : null,
      connectedAgent: latestConnection ? {
        agentName: latestConnection.identity.agentName,
        instanceId: latestConnection.identity.instanceId,
        podId: latestConnection.identity.podId,
      } : null,
    });
  } catch (error) {
    console.error('Error reading agent connection status:', error);
    return res.status(500).json({ error: 'Failed to read agent connection status' });
  }
});

router.get('/profile', auth, getCurrentProfile);
router.put('/profile', profileWriteIngressLimit, auth, profileWriteUserLimit, updateProfile);
router.get('/:id/public-activity', auth, getUserPublicActivity);
router.get('/:id', auth, getUserById);
router.post('/:id/follow', auth, followUser);
router.delete('/:id/follow', auth, unfollowUser);

module.exports = router;

export {};
