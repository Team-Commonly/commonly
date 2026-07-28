// Agent token management routes — extracted from registry.js (GH#112)
// Handles: runtime-tokens (R/W/D) and user-token (R/W/D)

// ESM import (not require) so CodeQL's js/missing-rate-limiting query can
// trace the middleware; it cannot follow a limiter through a require() return
// or a router.use wrapper. Same shape as routes/messages.ts.
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'crypto';

interface TokenRateReq { get?: (name: string) => string | undefined; ip?: string }
interface TokenRateRes { status: (code: number) => { json: (body: unknown) => void } }

// These routes read and mint agent credentials, so they are deliberately
// tighter than ordinary reads. Keyed on the hashed bearer token so one NAT'd
// office doesn't share a bucket.
const tokenRouteLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: TokenRateReq) => {
    const authHeader = req.get?.('authorization');
    if (authHeader) {
      return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
    }
    return req.ip ? ipKeyGenerator(req.ip) : 'anon';
  },
  handler: (_req: unknown, res: TokenRateRes) => {
    res.status(429).json({ error: 'rate limit exceeded: 60 token requests per 60s' });
  },
});
const express = require('express');
const auth = require('../../middleware/auth');
const { AgentInstallation } = require('../../models/AgentRegistry');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AgentIdentityService = require('../../services/agentIdentityService');
const {
  getUserId,
  resolveInstallation,
  resolveRuntimeInstanceId,
  serializeRuntimeTokens,
} = require('./helpers');
const {
  normalizeScopes,
  issueRuntimeTokenForAgent,
  issueUserTokenForInstallation,
} = require('./tokens');

const agentTokensRouter = express.Router();

/**
 * GET /api/registry/pods/:podId/agents/:name/runtime-tokens
 * List runtime tokens for an installed agent
 */
agentTokensRouter.get('/pods/:podId/agents/:name/runtime-tokens', tokenRouteLimit, auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { installation, instanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: req.query.instanceId,
    });
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m: any) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const resolvedType = AgentIdentityService.resolveAgentType(name);
    const agentUsername = AgentIdentityService.buildAgentUsername(resolvedType, instanceId);
    const agentUser = await User.findOne({ username: agentUsername, isBot: true })
      .select('agentRuntimeTokens')
      .lean();
    const tokens = serializeRuntimeTokens(agentUser?.agentRuntimeTokens || []);

    return res.json({ tokens });
  } catch (error) {
    console.error('Error listing agent runtime tokens:', error);
    return res.status(500).json({ error: 'Failed to list runtime tokens' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-tokens
 * Issue a runtime token for an installed agent
 */
agentTokensRouter.post('/pods/:podId/agents/:name/runtime-tokens', tokenRouteLimit, auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { label, instanceId, force } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m: any) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const resolved = await resolveInstallation({
      agentName: name,
      podId,
      instanceId,
    });
    const installation = resolved.installation;
    const normalizedInstanceId = resolveRuntimeInstanceId({
      agentName: name,
      requestedInstanceId: resolved.instanceId,
      installation,
    });

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const resolvedType = AgentIdentityService.resolveAgentType(name);
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(resolvedType, {
      instanceId: normalizedInstanceId,
      displayName: installation.displayName,
    });
    await AgentIdentityService.ensureAgentInPod(agentUser, podId);

    let issued = await issueRuntimeTokenForAgent(
      agentUser,
      label || `Provisioned ${normalizedInstanceId}`,
      installation,
    );
    // ADR-005 §detach + reattach: a fresh attach after detach has no local
    // copy of the prior token (the file was deleted on detach), but the
    // agent User row's hashed token persists per ADR-001 identity-continuity.
    // issueRuntimeTokenForAgent then returns `{existing: true}` with no
    // usable raw token, leaving the CLI with nothing to save. The same
    // workaround already lives in reprovision.ts/provision.ts; surfacing it
    // here as an explicit `force` body flag keeps the install flow honest.
    if (issued.existing && force) {
      agentUser.agentRuntimeTokens = [];
      const fresh = await issueRuntimeTokenForAgent(
        agentUser,
        label || `Provisioned ${normalizedInstanceId}`,
        installation,
      );
      issued = { ...issued, ...fresh };
    }
    return res.json(issued);
  } catch (error) {
    console.error('Error issuing agent runtime token:', error);
    return res.status(500).json({ error: 'Failed to issue runtime token' });
  }
});

/**
 * DELETE /api/registry/pods/:podId/agents/:name/runtime-tokens/:tokenId
 * Revoke a runtime token for an installed agent
 */
agentTokensRouter.delete('/pods/:podId/agents/:name/runtime-tokens/:tokenId', tokenRouteLimit, auth, async (req: any, res: any) => {
  try {
    const { podId, name, tokenId } = req.params;
    const { installation, instanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: req.query.instanceId,
    });
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m: any) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const resolvedType = AgentIdentityService.resolveAgentType(name);
    const agentUsername = AgentIdentityService.buildAgentUsername(resolvedType, instanceId);
    const agentUser = await User.findOne({ username: agentUsername, isBot: true });
    if (!agentUser) {
      return res.status(404).json({ error: 'Agent user not found' });
    }

    const originalCount = agentUser.agentRuntimeTokens?.length || 0;
    agentUser.agentRuntimeTokens = (agentUser.agentRuntimeTokens || []).filter(
      (token: any) => token._id?.toString() !== tokenId,
    );

    if ((agentUser.agentRuntimeTokens || []).length === originalCount) {
      return res.status(404).json({ error: 'Runtime token not found' });
    }

    await agentUser.save();
    await AgentInstallation.updateMany(
      {
        agentName: name.toLowerCase(),
        instanceId,
        status: { $ne: 'uninstalled' },
      },
      {
        $pull: { runtimeTokens: { _id: tokenId } },
      },
    );
    return res.json({ success: true });
  } catch (error) {
    console.error('Error revoking agent runtime token:', error);
    return res.status(500).json({ error: 'Failed to revoke runtime token' });
  }
});

/**
 * GET /api/registry/pods/:podId/agents/:name/user-token
 * Get metadata for the agent's designated user token (no raw token returned)
 */
agentTokensRouter.get('/pods/:podId/agents/:name/user-token', tokenRouteLimit, auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { installation, instanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: req.query.instanceId,
    });
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m: any) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const resolvedType = AgentIdentityService.resolveAgentType(name);
    const agentUsername = AgentIdentityService.buildAgentUsername(resolvedType, instanceId);
    // Needs +apiToken (select:false on the field) to report hasToken correctly.
    const agentUser = await User.findOne({ username: agentUsername }).select('+apiToken').lean();
    if (!agentUser || !agentUser.apiToken) {
      return res.json({ hasToken: false, scopes: [], scopeMode: 'none' });
    }
    const normalizedScopesArr = normalizeScopes(agentUser.apiTokenScopes || []);
    const scopeMode = normalizedScopesArr.length > 0 ? 'scoped' : 'all';

    return res.json({
      hasToken: true,
      createdAt: agentUser.apiTokenCreatedAt || null,
      scopes: normalizedScopesArr,
      scopeMode,
    });
  } catch (error) {
    console.error('Error fetching agent user token metadata:', error);
    return res.status(500).json({ error: 'Failed to fetch user token metadata' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/user-token
 * Issue a designated user API token for the agent user
 */
agentTokensRouter.post('/pods/:podId/agents/:name/user-token', tokenRouteLimit, auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { scopes, instanceId, displayName } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m: any) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const resolved = await resolveInstallation({
      agentName: name,
      podId,
      instanceId,
    });
    const installation = resolved.installation;
    const normalizedInstanceId = resolveRuntimeInstanceId({
      agentName: name,
      requestedInstanceId: resolved.instanceId,
      installation,
    });

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const issued = await issueUserTokenForInstallation({
      agentName: name,
      instanceId: normalizedInstanceId,
      displayName: displayName || installation.displayName,
      podId,
      scopes,
    });
    return res.json({
      ...issued,
      scopeMode: Array.isArray(issued.scopes) && issued.scopes.length > 0 ? 'scoped' : 'all',
    });
  } catch (error) {
    console.error('Error issuing agent user token:', error);
    return res.status(500).json({ error: 'Failed to issue user token' });
  }
});

/**
 * DELETE /api/registry/pods/:podId/agents/:name/user-token
 * Revoke designated user token for the agent user
 */
agentTokensRouter.delete('/pods/:podId/agents/:name/user-token', tokenRouteLimit, auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { installation, instanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: req.query.instanceId,
    });
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m: any) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const resolvedType = AgentIdentityService.resolveAgentType(name);
    const agentUsername = AgentIdentityService.buildAgentUsername(resolvedType, instanceId);
    const agentUser = await User.findOne({ username: agentUsername });
    if (!agentUser) {
      return res.status(404).json({ error: 'Agent user not found' });
    }

    agentUser.revokeApiToken();
    agentUser.apiTokenScopes = [];
    await agentUser.save();

    return res.json({ success: true });
  } catch (error) {
    console.error('Error revoking agent user token:', error);
    return res.status(500).json({ error: 'Failed to revoke user token' });
  }
});

module.exports = agentTokensRouter;

export {};
