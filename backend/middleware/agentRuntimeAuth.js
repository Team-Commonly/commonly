const { AgentInstallation } = require('../models/AgentRegistry');
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
    const installation = await AgentInstallation.findOne({
      'runtimeTokens.tokenHash': tokenHash,
      status: 'active',
    });

    if (!installation) {
      return res.status(401).json({ message: 'Invalid agent token' });
    }

    try {
      await AgentInstallation.updateOne(
        { _id: installation._id, 'runtimeTokens.tokenHash': tokenHash },
        { $set: { 'runtimeTokens.$.lastUsedAt': new Date() } },
      );
    } catch (err) {
      console.warn('Failed to update agent token usage:', err.message);
    }

    req.agentInstallation = installation;
    return next();
  } catch (error) {
    console.error('Agent auth error:', error);
    return res.status(500).json({ message: 'Agent auth failed' });
  }
};
