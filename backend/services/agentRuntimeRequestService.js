const User = require('../models/User');
const Post = require('../models/Post');
const { AgentInstallation } = require('../models/AgentRegistry');
const AgentIdentityService = require('./agentIdentityService');

const DEFAULT_INSTANCE_ID = 'default';

const ensurePodMatch = (installation, podId) => (
  installation?.podId?.toString() === podId.toString()
);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const parseLimit = (raw, fallback, max) => {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return clamp(parsed, 1, max);
};

const buildContextRequest = (
  query,
  {
    podId,
    userId,
    agentName,
    instanceId,
  },
) => ({
  podId,
  userId,
  agentContext: { agentName, instanceId },
  task: query.task || '',
  summaryLimit: parseLimit(query.summaryLimit, 6, 20),
  assetLimit: parseLimit(query.assetLimit, 12, 40),
  tagLimit: parseLimit(query.tagLimit, 16, 40),
  skillLimit: parseLimit(query.skillLimit, 6, 12),
  skillMode: typeof query.skillMode === 'string' ? query.skillMode.toLowerCase() : 'llm',
  skillRefreshHours: parseLimit(query.skillRefreshHours, 6, 72),
});

const resolveBotIdentity = (user, requestData = {}) => {
  const agentName = requestData.agentName || user.botMetadata?.agentName || null;
  const instanceId = requestData.instanceId || user.botMetadata?.instanceId || DEFAULT_INSTANCE_ID;
  return {
    agentName: agentName || user.username,
    instanceId,
  };
};

const botIdentityMatchesUser = (user, { agentName, instanceId }) => {
  const expectedUsername = AgentIdentityService.buildAgentUsername(agentName, instanceId);
  return expectedUsername.toLowerCase() === user.username.toLowerCase();
};

const ensureBotInstallation = async (agentName, podId, instanceId = DEFAULT_INSTANCE_ID) => (
  AgentInstallation.findOne({
    agentName: agentName.toLowerCase(),
    podId,
    instanceId,
    status: 'active',
  }).lean()
);

const listAgentInstallations = async (agentName, instanceId = DEFAULT_INSTANCE_ID) => (
  AgentInstallation.find({
    agentName: agentName.toLowerCase(),
    instanceId,
    status: 'active',
  }).lean()
);

const requireBotRequestContext = async (req, res, { podId, source = 'query' } = {}) => {
  const userId = req.userId || req.user?.id;
  const user = await User.findById(userId).lean();
  if (!user || !user.isBot) {
    return { error: res.status(403).json({ message: 'This endpoint is for bot users only' }) };
  }

  const requestData = req[source] || {};
  const identity = resolveBotIdentity(user, requestData);
  if (!botIdentityMatchesUser(user, identity)) {
    return { error: res.status(403).json({ message: 'Agent token does not match bot user' }) };
  }

  let installation = null;
  if (podId) {
    installation = await ensureBotInstallation(identity.agentName, podId, identity.instanceId);
    if (!installation) {
      return { error: res.status(403).json({ message: 'Bot not installed in this pod' }) };
    }
  }

  return {
    user,
    installation,
    agentName: identity.agentName,
    instanceId: identity.instanceId,
  };
};

const loadThreadPost = async (threadId) => Post.findById(threadId).select('_id podId').lean();

const resolveThreadTargetPod = (post, fallbackPodId) => post?.podId || fallbackPodId || null;

module.exports = {
  DEFAULT_INSTANCE_ID,
  buildContextRequest,
  ensurePodMatch,
  listAgentInstallations,
  loadThreadPost,
  parseLimit,
  requireBotRequestContext,
  resolveThreadTargetPod,
};
