const { AgentInstallation } = require('../models/AgentRegistry');
const User = require('../models/User');
const Pod = require('../models/Pod');
const { hash } = require('../utils/secret');

const normalizeTokenIdentityValue = (value) => (
  String(value || '').trim().toLowerCase()
);

const deriveInstanceIdFromUsername = (agentName, username) => {
  const normalizedAgent = normalizeTokenIdentityValue(agentName);
  const normalizedUsername = normalizeTokenIdentityValue(username);
  if (!normalizedAgent || !normalizedUsername) return null;
  if (normalizedUsername === normalizedAgent) return 'default';
  const prefix = `${normalizedAgent}-`;
  if (normalizedUsername.startsWith(prefix)) {
    const suffix = normalizedUsername.slice(prefix.length).trim();
    return suffix || null;
  }
  return null;
};

const resolveTokenAgentIdentity = (agentUser) => {
  const meta = agentUser?.botMetadata || {};
  const username = normalizeTokenIdentityValue(agentUser?.username);
  const agentName = normalizeTokenIdentityValue(meta.agentName || meta.agentType || username);

  const metadataInstanceId = normalizeTokenIdentityValue(meta.instanceId);
  const usernameInstanceId = deriveInstanceIdFromUsername(agentName, username);
  let instanceId = metadataInstanceId || usernameInstanceId || 'default';
  if (usernameInstanceId && (!metadataInstanceId || metadataInstanceId === 'default')) {
    instanceId = usernameInstanceId;
  }

  return { agentName, instanceId };
};

const extractToken = (req) => {
  const authHeader = req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.replace('Bearer ', '').trim();
  }
  return req.header('x-commonly-agent-token');
};

module.exports = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token || !token.startsWith('cm_agent_')) {
      return res.status(401).json({ message: 'Missing agent token' });
    }

    const tokenHash = hash(token);

    // First, check User model for shared runtime tokens (new approach)
    const agentUser = await User.findOne({
      'agentRuntimeTokens.tokenHash': tokenHash,
      isBot: true,
    });

    if (agentUser) {
      // Reject expired session tokens
      const tokenRecord = agentUser.agentRuntimeTokens.find((t) => t.tokenHash === tokenHash);
      if (tokenRecord?.expiresAt && tokenRecord.expiresAt < new Date()) {
        return res.status(401).json({ message: 'Session token expired' });
      }

      // Update last used timestamp on User
      try {
        await User.updateOne(
          { _id: agentUser._id, 'agentRuntimeTokens.tokenHash': tokenHash },
          { $set: { 'agentRuntimeTokens.$.lastUsedAt': new Date() } },
        );
      } catch (err) {
        console.warn('Failed to update agent token usage on User:', err.message);
      }

      // Find all active installations for this agent
      const { agentName, instanceId } = resolveTokenAgentIdentity(agentUser);

      const installations = await AgentInstallation.find({
        agentName,
        instanceId,
        status: 'active',
      }).lean();
      const installationPodIds = installations
        .map((installation) => installation?.podId?.toString())
        .filter(Boolean);
      const dmPods = await Pod.find({
        type: 'agent-admin',
        members: agentUser._id,
      }).select('_id').lean();
      const dmPodIds = dmPods.map((pod) => pod._id?.toString()).filter(Boolean);
      const authorizedPodIds = Array.from(new Set([...installationPodIds, ...dmPodIds]));

      req.agentUser = agentUser;
      req.agentInstallations = installations;
      req.agentAuthorizedPodIds = authorizedPodIds;
      // For backward compatibility, set agentInstallation to first installation
      req.agentInstallation = installations[0] || null;
      return next();
    }

    // Fallback: check AgentInstallation for legacy per-installation tokens
    const installation = await AgentInstallation.findOne({
      'runtimeTokens.tokenHash': tokenHash,
      status: 'active',
    });

    if (!installation) {
      return res.status(401).json({ message: 'Invalid agent token' });
    }

    // Update last used timestamp on installation
    try {
      await AgentInstallation.updateOne(
        { _id: installation._id, 'runtimeTokens.tokenHash': tokenHash },
        { $set: { 'runtimeTokens.$.lastUsedAt': new Date() } },
      );
    } catch (err) {
      console.warn('Failed to update agent token usage:', err.message);
    }

    req.agentInstallation = installation;
    req.agentInstallations = [installation];
    req.agentAuthorizedPodIds = [installation?.podId?.toString()].filter(Boolean);
    return next();
  } catch (error) {
    console.error('Agent auth error:', error);
    return res.status(500).json({ message: 'Agent auth failed' });
  }
};
