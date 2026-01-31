const AgentEventService = require('./agentEventService');
const { AgentInstallation } = require('../models/AgentRegistry');

/**
 * Mention Aliases
 *
 * Maps @mention aliases to agent types
 * agentType = the runtime type (openclaw, commonly-summarizer, etc.)
 */
const MENTION_ALIASES = {
  // openclaw (official: Cuz 🦞) - Claude-powered AI
  openclaw: ['openclaw', 'cuz', 'clawd', 'clawd-bot', 'clawdbot'],
  // commonly-summarizer (official: Commonly Summarizer)
  'commonly-summarizer': ['commonly-summarizer', 'commonly-bot', 'commonlybot', 'commonly', 'summarizer'],
  // claude-code (future)
  'claude-code': ['claude-code', 'claudecode'],
  // codex (future)
  codex: ['codex', 'openai-codex'],
};

const buildAliasMap = () => {
  const aliasMap = new Map();
  Object.entries(MENTION_ALIASES).forEach(([agentType, aliases]) => {
    aliases.forEach((alias) => {
      aliasMap.set(alias.toLowerCase(), agentType);
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
    const agentType = aliasMap.get(raw);
    if (agentType) {
      mentions.add(agentType);
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
  const mentionAgentTypes = extractMentions(content);
  if (!podId || mentionAgentTypes.length === 0) {
    return { enqueued: [], skipped: [] };
  }

  const enqueued = [];
  const skipped = [];

  await Promise.all(
    mentionAgentTypes.map(async (agentType) => {
      let installed = false;
      try {
        installed = await AgentInstallation.isInstalled(agentType, podId);
      } catch (error) {
        console.warn('Agent mention install check failed:', error.message);
      }

      if (!installed) {
        skipped.push(agentType);
        return;
      }

      try {
        // Find the installation (prefer default instance, fall back to any)
        let installation = await AgentInstallation.findOne({
          agentName: agentType.toLowerCase(),
          podId,
          instanceId: 'default',
          status: 'active',
        }).lean();

        if (!installation) {
          installation = await AgentInstallation.findOne({
            agentName: agentType.toLowerCase(),
            podId,
            status: 'active',
          }).lean();
        }

        await AgentEventService.enqueue({
          agentName: agentType,
          instanceId: installation?.instanceId || 'default',
          podId,
          type: 'chat.mention',
          payload: {
            messageId: message?._id || message?.id,
            content,
            userId,
            username,
            mentions: mentionAgentTypes,
            source: 'chat',
            messageType: message?.messageType || message?.message_type || 'text',
            createdAt: message?.createdAt || message?.created_at || new Date(),
          },
        });
        enqueued.push(agentType);
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
