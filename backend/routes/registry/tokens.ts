// Token issuance + scope helpers — extracted from registry.js (GH#112)
const AgentIdentityService = require('../../services/agentIdentityService');
const { hash, randomSecret } = require('../../utils/secret');

const AGENT_USER_TOKEN_SCOPES = new Set([
  'agent:events:read',
  'agent:events:ack',
  'agent:context:read',
  'agent:messages:read',
  'agent:messages:write',
]);

const normalizeScopes = (scopes: any) => {
  if (!Array.isArray(scopes)) return [];
  return Array.from(new Set(scopes.filter((scope) => AGENT_USER_TOKEN_SCOPES.has(scope))));
};

const AUTO_GRANTED_INTEGRATION_SCOPES = [
  'integration:read',
  'integration:messages:read',
];

const sanitizeStringList = (value: any) => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean)));
};

const normalizeToolPolicy = (policy: any) => {
  if (!policy || typeof policy !== 'object') return null;
  return {
    allowed: sanitizeStringList(policy.allowed),
    blocked: sanitizeStringList(policy.blocked),
    requireApproval: sanitizeStringList(policy.requireApproval),
  };
};

const normalizeContextPolicy = (policy: any) => {
  if (!policy || typeof policy !== 'object') return null;
  const next = { ...policy };
  if (next.maxTokens !== undefined) next.maxTokens = Number(next.maxTokens);
  if (next.compactionThreshold !== undefined) next.compactionThreshold = Number(next.compactionThreshold);
  if (next.summaryHours !== undefined) next.summaryHours = Number(next.summaryHours);
  return next;
};

/**
 * Issue a runtime token for an agent.
 * Tokens are stored on the User model (shared across all pod installations).
 * This ensures the same agent identity uses the same token regardless of which pod.
 *
 * @param {Object} agentUser - The agent's User document
 * @param {string} label - Token label
 * @param {Object} installation - Optional installation to also store token on (for backward compat)
 * @returns {Object} - { token, label, existing, createdAt }
 */
// issuer (ADR-026 Phase 0): { ownerUserId, parentId?, machineId? } — when
// present, the mint dual-writes an AgentCredential row alongside the legacy
// embedded record, giving the token per-record status, lineage, and
// revocability. Callers that do not pass it keep minting legacy-only tokens
// (additive migration; auth falls back for those).
const issueRuntimeTokenForAgent = async (agentUser: any, label: any, installation: any = null, issuer: any = null) => {
  // Check if agent already has a runtime token (reuse existing)
  if (agentUser.agentRuntimeTokens?.length > 0) {
    const existingToken = agentUser.agentRuntimeTokens[0];
    // Backfill a credential row for the pre-substrate token so the existing
    // fleet becomes listable and cascade-revocable (Vera on #1312: without
    // this the collection stays near-empty while coverage looks fine).
    // Provenance is unknown, so no parent lineage is claimed.
    if (issuer?.ownerUserId) {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const AgentCredential = require('../../models/AgentCredential');
      await AgentCredential.updateOne(
        { tokenHash: existingToken.tokenHash },
        {
          $setOnInsert: {
            kind: 'runtime',
            ownerUserId: issuer.ownerUserId,
            agentUserId: agentUser._id,
            label: existingToken.label || 'Runtime token',
            status: 'active',
          },
        },
        { upsert: true },
      ).catch((err: Error) => console.warn('Credential backfill failed:', err.message));
    }
    return {
      existing: true,
      label: existingToken.label,
      createdAt: existingToken.createdAt,
      // Can't return raw token for existing - it's hashed
      message: 'Agent already has a runtime token. Use existing token or revoke to generate new.',
    };
  }

  // Generate new token
  const rawToken = `cm_agent_${randomSecret(32)}`;
  const tokenRecord = {
    tokenHash: hash(rawToken),
    label: label || 'Runtime token',
    createdAt: new Date(),
  };

  // Credential row FIRST, then the embedded record (Vera on #1312:
  // warn-and-continue after issuing would hand out a working token with no
  // row — invisible to listing, unreachable by cascade, lineage-free. If
  // the ledger write fails, the mint fails; no token exists without a row
  // when an issuer is known).
  if (issuer?.ownerUserId) {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const AgentCredential = require('../../models/AgentCredential');
    await AgentCredential.create({
      tokenHash: tokenRecord.tokenHash,
      kind: 'runtime',
      ownerUserId: issuer.ownerUserId,
      agentUserId: agentUser._id,
      parentId: issuer.parentId || null,
      machineId: issuer.machineId || null,
      label: tokenRecord.label,
    });
  }

  // Store on User model (primary - shared across pods)
  agentUser.agentRuntimeTokens = agentUser.agentRuntimeTokens || [];
  agentUser.agentRuntimeTokens.push(tokenRecord);
  await agentUser.save();

  // Also store on installation for backward compatibility
  if (installation) {
    installation.runtimeTokens = installation.runtimeTokens || [];
    installation.runtimeTokens.push(tokenRecord);
    await installation.save();
  }

  return {
    token: rawToken,
    label: label || 'Runtime token',
    existing: false,
    createdAt: tokenRecord.createdAt,
  };
};

/**
 * Legacy function for backward compatibility.
 * @deprecated Use issueRuntimeTokenForAgent instead
 */
const issueRuntimeTokenForInstallation = async (installation: any, label: any) => {
  const rawToken = `cm_agent_${randomSecret(32)}`;
  installation.runtimeTokens = installation.runtimeTokens || [];
  installation.runtimeTokens.push({
    tokenHash: hash(rawToken),
    label: label || 'Runtime token',
    createdAt: new Date(),
  });
  await installation.save();
  return { token: rawToken, label: label || 'Runtime token' };
};

const issueUserTokenForInstallation = async ({
  agentName,
  instanceId,
  displayName,
  podId,
  scopes,
  force = false,
}: {
  agentName: any;
  instanceId: any;
  displayName: any;
  podId: any;
  scopes: any;
  force?: boolean;
}) => {
  const agentUser = await AgentIdentityService.getOrCreateAgentUser(agentName.toLowerCase(), {
    instanceId,
    displayName,
  });
  await AgentIdentityService.ensureAgentInPod(agentUser, podId);
  const normalizedScopes = normalizeScopes(scopes);

  // Preserve existing token unless force-rotation is requested
  if (agentUser.apiToken && !force) {
    agentUser.apiTokenScopes = normalizedScopes;
    await agentUser.save();
    return {
      token: agentUser.apiToken,
      scopes: normalizedScopes,
      createdAt: agentUser.apiTokenCreatedAt,
      existing: true,
    };
  }

  const token = agentUser.generateApiToken();
  agentUser.apiTokenScopes = normalizedScopes;
  await agentUser.save();
  return { token, scopes: normalizedScopes, createdAt: agentUser.apiTokenCreatedAt, existing: false };
};

module.exports = {
  AGENT_USER_TOKEN_SCOPES,
  normalizeScopes,
  AUTO_GRANTED_INTEGRATION_SCOPES,
  sanitizeStringList,
  normalizeToolPolicy,
  normalizeContextPolicy,
  issueRuntimeTokenForAgent,
  issueRuntimeTokenForInstallation,
  issueUserTokenForInstallation,
};

export {};
