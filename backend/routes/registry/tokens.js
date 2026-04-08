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

const normalizeScopes = (scopes) => {
  if (!Array.isArray(scopes)) return [];
  return Array.from(new Set(scopes.filter((scope) => AGENT_USER_TOKEN_SCOPES.has(scope))));
};

const AUTO_GRANTED_INTEGRATION_SCOPES = [
  'integration:read',
  'integration:messages:read',
];

const sanitizeStringList = (value) => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean)));
};

const normalizeToolPolicy = (policy) => {
  if (!policy || typeof policy !== 'object') return null;
  return {
    allowed: sanitizeStringList(policy.allowed),
    blocked: sanitizeStringList(policy.blocked),
    requireApproval: sanitizeStringList(policy.requireApproval),
  };
};

const normalizeContextPolicy = (policy) => {
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
const issueRuntimeTokenForAgent = async (agentUser, label, installation = null) => {
  // Check if agent already has a runtime token (reuse existing)
  if (agentUser.agentRuntimeTokens?.length > 0) {
    const existingToken = agentUser.agentRuntimeTokens[0];
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
const issueRuntimeTokenForInstallation = async (installation, label) => {
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
