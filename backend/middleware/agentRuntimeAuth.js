const { AgentInstallation } = require('../models/AgentRegistry');
const User = require('../models/User');
const { hash } = require('../utils/secret');

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
      const agentName = agentUser.botMetadata?.agentName || agentUser.botMetadata?.agentType;
      const instanceId = agentUser.botMetadata?.instanceId || 'default';

      const installations = await AgentInstallation.find({
        agentName: agentName?.toLowerCase(),
        instanceId,
        status: 'active',
      }).lean();

      req.agentUser = agentUser;
      req.agentInstallations = installations;
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
    return next();
  } catch (error) {
    console.error('Agent auth error:', error);
    return res.status(500).json({ message: 'Agent auth failed' });
  }
};
