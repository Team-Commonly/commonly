const AgentEventService = require('./agentEventService');
const { AgentInstallation } = require('../models/AgentRegistry');

const MENTION_ALIASES = {
  'commonly-bot': ['commonly-bot', 'commonlybot'],
  'clawdbot-bridge': ['clawdbot-bridge', 'clawdbot'],
};

const buildAliasMap = () => {
  const aliasMap = new Map();
  Object.entries(MENTION_ALIASES).forEach(([agentName, aliases]) => {
    aliases.forEach((alias) => {
      aliasMap.set(alias.toLowerCase(), agentName);
    });
  });
  return aliasMap;
};

const aliasMap = buildAliasMap();

const extractMentions = (content = '') => {
  if (!content || typeof content !== 'string') return [];
  const mentions = new Set();
  const regex = /@([a-z0-9-]{2,})/gi;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[1]?.toLowerCase();
    if (!raw) continue;
    const agentName = aliasMap.get(raw);
    if (agentName) {
      mentions.add(agentName);
    }
  }
  return Array.from(mentions);
};

const enqueueMentions = async ({
  podId,
  message,
  userId,
  username,
}) => {
  const content = message?.content || message?.text || '';
  const mentionAgents = extractMentions(content);
  if (!podId || mentionAgents.length === 0) {
    return { enqueued: [], skipped: [] };
  }

  const enqueued = [];
  const skipped = [];

  await Promise.all(
    mentionAgents.map(async (agentName) => {
      let installed = false;
      try {
        installed = await AgentInstallation.isInstalled(agentName, podId);
      } catch (error) {
        console.warn('Agent mention install check failed:', error.message);
      }

      if (!installed) {
        skipped.push(agentName);
        return;
      }

      try {
        await AgentEventService.enqueue({
          agentName,
          podId,
          type: 'chat.mention',
          payload: {
            messageId: message?._id || message?.id,
            content,
            userId,
            username,
            mentions: mentionAgents,
            source: 'chat',
            messageType: message?.messageType || message?.message_type || 'text',
            createdAt: message?.createdAt || message?.created_at || new Date(),
          },
        });
        enqueued.push(agentName);
      } catch (error) {
        console.warn('Failed to enqueue agent mention:', error.message);
      }
    }),
  );

  return { enqueued, skipped };
};

module.exports = {
  extractMentions,
  enqueueMentions,
  MENTION_ALIASES,
};
