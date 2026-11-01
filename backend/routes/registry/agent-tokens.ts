// Agent token management routes — extracted from registry.js (GH#112)
// Handles: runtime-tokens (R/W/D) and user-token (R/W/D)

// ESM import (not require) so CodeQL's js/missing-rate-limiting query can
// trace the middleware; it cannot follow a limiter through a require() return
// or a router.use wrapper. Same shape as routes/messages.ts.
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../../middleware/ipRateLimit';
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
    return cloudflareIpRateLimitKeyGenerator(req as never);
  },
  handler: (_req: unknown, res: TokenRateRes) => {
    res.status(429).json({ error: 'rate limit exceeded: 60 token requests per 60s' });
  },
});
const express = require('express');
const auth = require('../../middleware/auth');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AgentCredential = require('../../models/AgentCredential');
const AgentIdentityService = require('../../services/agentIdentityService');
const {
  getUserId,
  isGlobalAdminUser,
  resolveInstallation,
  resolveRuntimeInstanceId,
  serializeRuntimeTokens,
} = require('./helpers');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ownsRuntimeIdentity, runtimeCredentialRefusal } = require('../../services/runtimeIdentityOwnership');
const {
  normalizeScopes,
  revokeRuntimeTokenEverywhere,
  revokeRuntimeTokensForAgent,
  issueRuntimeTokenForAgent,
  issueUserTokenForInstallation,
} = require('./tokens');

const agentTokensRouter = express.Router();

/**
 * Pod membership is not enough to mint, force-rotate or revoke a runtime token,
 * or to issue or revoke the agent's user token. Either one acts as the agent in
 * every pod where that identity is installed, so these routes apply the same
 * sole-installer rule as the daemon routes. Admins are exempt, because
 * operators renew shared fleet seats.
 */
const credentialRefusal = async (userId: unknown, agentName: string, instanceId: string) => {
  if (await isGlobalAdminUser(userId)) return null;
  const check = await ownsRuntimeIdentity(userId, String(agentName).toLowerCase(), instanceId);
  if (check.owned) return null;
  return { code: check.failure, error: runtimeCredentialRefusal[check.failure] };
};

// Legacy embedded keys predate the credential ledger. Record their metadata
// before a replacement or revoke removes the only embedded copy, so Settings
// can still show the revoked state after the authenticating copies are pulled.
const recordLegacyKeys = async (
  agentUser: any, ownerUserId: unknown, agentName: string, instanceId: string,
) => {
  const { AgentInstallation } = require('../../models/AgentRegistry');
  const installations = await AgentInstallation.find({ agentName, instanceId })
    .collation({ locale: 'en', strength: 2 }).select('runtimeTokens').lean();
  const records = [...(agentUser.agentRuntimeTokens || []),
    ...(installations || []).flatMap((entry: any) => entry.runtimeTokens || [])];
  const seen = new Set<string>();
  await Promise.all(records.filter((record) => {
    if (!record?.tokenHash || seen.has(record.tokenHash)) return false;
    seen.add(record.tokenHash);
    return true;
  }).map((record) => AgentCredential.updateOne(
    { tokenHash: record.tokenHash },
    { $setOnInsert: {
      kind: 'runtime', ownerUserId, agentUserId: agentUser._id,
      label: record.label || 'Runtime token', status: 'active',
      createdAt: record.createdAt || new Date(), lastUsedAt: record.lastUsedAt || null,
    } },
    { upsert: true },
  )));
};

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

    if (!membership && !isCreator && !(await isGlobalAdminUser(userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const refusal = await credentialRefusal(userId, installation.agentName || name, instanceId);
    if (refusal) return res.status(403).json(refusal);

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

    if (!membership && !isCreator && !(await isGlobalAdminUser(userId))) {
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

    const refusal = await credentialRefusal(userId, installation.agentName || name, normalizedInstanceId);
    if (refusal) return res.status(403).json(refusal);

    const resolvedType = AgentIdentityService.resolveAgentType(name);
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(resolvedType, {
      instanceId: normalizedInstanceId,
      displayName: installation.displayName,
    });
    await AgentIdentityService.ensureAgentInPod(agentUser, podId);

    // ADR-005 §detach + reattach: force rotation is a replacement operation,
    // not merely clearing the User row. Runtime auth accepts both the shared
    // User token and legacy installation copies, so revoke every hash before
    // issuing the replacement.
    if (force) {
      await recordLegacyKeys(
        agentUser, installation.installedBy || userId,
        installation.agentName || name, normalizedInstanceId,
      );
      await revokeRuntimeTokensForAgent({
        agentUser,
        agentName: installation.agentName || name,
        instanceId: normalizedInstanceId,
        installation,
      });
    }
    const issued = await issueRuntimeTokenForAgent(
      agentUser,
      label || `Provisioned ${normalizedInstanceId}`,
      installation,
      { ownerUserId: userId },
    );
    return res.json(issued);
  } catch (error) {
    if ((error as { code?: string })?.code === 'in_process_agent_no_token') {
      return res.status(409).json({ code: 'in_process_agent_no_token', error: (error as Error).message });
    }
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

    if (!membership && !isCreator && !(await isGlobalAdminUser(userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!installation || installation.status !== 'active') {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const refusal = await credentialRefusal(userId, installation.agentName || name, instanceId);
    if (refusal) return res.status(403).json(refusal);

    const resolvedType = AgentIdentityService.resolveAgentType(name);
    const agentUsername = AgentIdentityService.buildAgentUsername(resolvedType, instanceId);
    const agentUser = await User.findOne({ username: agentUsername, isBot: true });
    if (!agentUser) {
      return res.status(404).json({ error: 'Agent user not found' });
    }

    // The listed id is this User row's copy. Every other copy of the token
    // (each installation's, and the ledger row) has a different id, so the
    // revoke goes by the hash they all share (revokeRuntimeTokenEverywhere).
    const record = (agentUser.agentRuntimeTokens || []).find(
      (token: any) => token._id?.toString() === tokenId,
    );
    if (!record?.tokenHash) {
      return res.status(404).json({ error: 'Runtime token not found' });
    }

    await recordLegacyKeys(agentUser, installation.installedBy || userId, installation.agentName || name, instanceId);
    await revokeRuntimeTokenEverywhere(record.tokenHash);
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
    const agentUser = await User.findOne({ username: agentUsername, isBot: true }).select('+apiToken +apiTokenHash').lean();
    if (!agentUser || !(agentUser.apiTokenHash || agentUser.apiToken)) {
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
    const { scopes, instanceId, displayName, force } = req.body || {};
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

    // The user token signs in as the agent's User in every pod and room that
    // User belongs to. Every call takes the same sole-installer rule as the
    // runtime-token routes: one without `force` still mints when no token
    // exists, rewrites the scopes of one that does, and returns a legacy
    // token that was never hashed.
    const refusal = await credentialRefusal(userId, installation.agentName || name, normalizedInstanceId);
    if (refusal) return res.status(403).json(refusal);

    const issued = await issueUserTokenForInstallation({
      agentName: name,
      instanceId: normalizedInstanceId,
      displayName: displayName || installation.displayName,
      podId,
      scopes,
      force: force === true,
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

    const refusal = await credentialRefusal(userId, installation.agentName || name, instanceId);
    if (refusal) return res.status(403).json(refusal);

    const resolvedType = AgentIdentityService.resolveAgentType(name);
    const agentUsername = AgentIdentityService.buildAgentUsername(resolvedType, instanceId);
    const agentUser = await User.findOne({ username: agentUsername, isBot: true });
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
