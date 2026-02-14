const AgentEventService = require('./agentEventService');
const { AgentInstallation } = require('../models/AgentRegistry');
const AgentProfile = require('../models/AgentProfile');
const Pod = require('../models/Pod');
const User = require('../models/User');
const chatSummarizerService = require('./chatSummarizerService');
const ChatSummarizerService = chatSummarizerService.constructor;

/**
 * Mention Aliases
 *
 * Maps @mention aliases to agent types
 * agentType = the runtime type (openclaw, commonly-bot, etc.)
 */
const MENTION_ALIASES = {};

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
    mentions.add(raw);
  }
  return Array.from(mentions);
};

const slugify = (value = '') => value
  .toString()
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '');

const buildMentionMap = (installations = [], profiles = []) => {
  const map = new Map();
  const byAgent = new Map();

  installations.forEach((installation) => {
    const agentName = installation.agentName;
    const instanceId = installation.instanceId || 'default';
    const profile = profiles.find(
      (p) => p.agentName === agentName && p.instanceId === instanceId,
    );
    const displayName = installation.displayName || profile?.name || agentName;
    const displaySlug = slugify(displayName);

    const list = byAgent.get(agentName) || [];
    list.push({ agentName, instanceId, displayName, displaySlug });
    byAgent.set(agentName, list);

    // Always allow explicit instance references
    map.set(`${agentName}-${instanceId}`.toLowerCase(), { agentName, instanceId });
    map.set(instanceId.toLowerCase(), { agentName, instanceId });
    if (displaySlug) {
      map.set(displaySlug, { agentName, instanceId });
    }
  });

  // Only allow bare agentName if there's a single installation in the pod
  byAgent.forEach((list, agentName) => {
    if (list.length === 1) {
      map.set(agentName.toLowerCase(), { agentName, instanceId: list[0].instanceId });
      const aliases = MENTION_ALIASES[agentName] || [];
      aliases.forEach((alias) => {
        map.set(alias.toLowerCase(), { agentName, instanceId: list[0].instanceId });
      });
    }
  });

  return { map, byAgent };
};

const buildSummaryPayload = (summary, pod) => {
  if (!summary) return null;
  return {
    content: summary.content,
    title: summary.title,
    source: 'chat',
    sourceLabel: 'Commonly',
    channelName: summary?.metadata?.podName || pod?.name || 'pod',
    channelUrl: null,
    messageCount: summary?.metadata?.totalItems || 0,
    timeRange: summary.timeRange || null,
    summaryType: summary.type || 'chats',
  };
};

const enqueueSummarizerEvent = async ({
  podId,
  instanceId,
  summary,
  pod,
}) => {
  const payload = buildSummaryPayload(summary, pod);
  if (!payload) return;
  await AgentEventService.enqueue({
    agentName: 'commonly-bot',
    instanceId,
    podId,
    type: 'summary.request',
    payload: { summary: payload, source: 'chat' },
  });
};

const enqueueMentions = async ({
  podId,
  message,
  userId,
  username,
}) => {
  const content = message?.content || message?.text || '';
  const source = message?.source || 'chat';
  const eventType = source === 'thread' ? 'thread.mention' : 'chat.mention';
  const rawMentions = extractMentions(content);
  if (!podId || rawMentions.length === 0) {
    return { enqueued: [], skipped: [] };
  }

  const enqueued = [];
  const skipped = [];

  let installations = [];
  let profiles = [];
  try {
    installations = await AgentInstallation.find({
      podId,
      status: 'active',
    }).lean();
    profiles = await AgentProfile.find({ podId }).lean();
  } catch (error) {
    console.warn('Agent mention lookup failed:', error.message);
  }

  const { map: mentionMap, byAgent } = buildMentionMap(installations, profiles);
  let pod = null;

  await Promise.all(
    rawMentions.map(async (raw) => {
      const normalized = raw.toLowerCase();
      const directMatch = mentionMap.get(normalized);
      if (directMatch) {
        try {
          if (directMatch.agentName === 'commonly-bot') {
            pod = pod || await Pod.findById(podId).lean();
            let summary = await ChatSummarizerService.getLatestPodSummary(podId);
            if (!summary) {
              summary = await chatSummarizerService.summarizePodMessages(podId);
            }
            await enqueueSummarizerEvent({
              podId,
              instanceId: directMatch.instanceId || 'default',
              summary,
              pod,
            });
            enqueued.push(directMatch.agentName);
            return;
          }
              await AgentEventService.enqueue({
                agentName: directMatch.agentName,
                instanceId: directMatch.instanceId || 'default',
                podId,
                type: eventType,
                payload: {
                  messageId: message?._id || message?.id
                    ? String(message?._id || message?.id)
                    : undefined,
                  content,
                  userId,
                  username,
              mentions: rawMentions,
              source,
              messageType: message?.messageType || message?.message_type || 'text',
              createdAt: message?.createdAt || message?.created_at || new Date(),
              thread: message?.thread || null,
            },
          });
          enqueued.push(directMatch.agentName);
        } catch (error) {
          console.warn('Failed to enqueue agent mention:', error.message);
        }
        return;
      }

      const agentType = aliasMap.get(normalized);
      if (agentType) {
        const matches = byAgent.get(agentType) || [];
        if (matches.length === 0) {
          skipped.push(agentType);
          return;
        }
        await Promise.all(
          matches.map(async (match) => {
            try {
              if (agentType === 'commonly-bot') {
                pod = pod || await Pod.findById(podId).lean();
                let summary = await ChatSummarizerService.getLatestPodSummary(podId);
                if (!summary) {
                  summary = await chatSummarizerService.summarizePodMessages(podId);
                }
                await enqueueSummarizerEvent({
                  podId,
                  instanceId: match.instanceId || 'default',
                  summary,
                  pod,
                });
                enqueued.push(agentType);
                return;
              }
              await AgentEventService.enqueue({
                agentName: agentType,
                instanceId: match.instanceId || 'default',
                podId,
                type: eventType,
                payload: {
                  messageId: message?._id || message?.id
                    ? String(message?._id || message?.id)
                    : undefined,
                  content,
                  userId,
                  username,
                  mentions: rawMentions,
                  source,
                  messageType: message?.messageType || message?.message_type || 'text',
                  createdAt: message?.createdAt || message?.created_at || new Date(),
                  thread: message?.thread || null,
                },
              });
              enqueued.push(agentType);
            } catch (error) {
              console.warn('Failed to enqueue agent mention:', error.message);
            }
          }),
        );
        return;
      }

      skipped.push(raw);
    }),
  );

  return { enqueued, skipped };
};

/**
 * Auto-enqueue a dm.message event for every user message in an agent-admin
 * DM pod.  Unlike enqueueMentions, no @mention is required — in a 1:1 DM
 * every message from the human should reach the agent.
 */
const enqueueDmEvent = async ({ podId, message, userId, username }) => {
  const pod = await Pod.findById(podId).lean();
  if (!pod || pod.type !== 'agent-admin') {
    return { enqueued: false, reason: 'not_dm_pod' };
  }

  const senderIdStr = String(userId);
  const otherMemberIds = (pod.members || [])
    .map((m) => String(m._id || m))
    .filter((id) => id !== senderIdStr);

  if (otherMemberIds.length === 0) {
    return { enqueued: false, reason: 'no_other_member' };
  }

  const agentMembers = await User.find({
    _id: { $in: otherMemberIds },
    isBot: true,
  }).select('_id username botMetadata').lean();

  if (agentMembers.length === 0) {
    return { enqueued: false, reason: 'no_agent_user' };
  }

  const content = message?.content || message?.text || '';
  const enqueued = [];

  for (const agentUser of agentMembers) {
    const agentName = agentUser.botMetadata?.agentName || agentUser.username;
    const instanceId = agentUser.botMetadata?.instanceId || 'default';

    // Find any active installation to confirm the agent is live
    const installation = await AgentInstallation.findOne({
      agentName: agentName.toLowerCase(),
      instanceId,
      status: 'active',
    }).lean();

    if (!installation) continue;

    await AgentEventService.enqueue({
      agentName: agentName.toLowerCase(),
      instanceId,
      podId,
      type: 'dm.message',
      payload: {
        messageId: message?._id || message?.id
          ? String(message?._id || message?.id)
          : undefined,
        content,
        userId,
        username,
        source: 'dm',
        messageType: message?.messageType || message?.message_type || 'text',
        createdAt: message?.createdAt || message?.created_at || new Date(),
        dmPodId: String(podId),
        installationPodId: installation.podId?.toString(),
      },
    });
    enqueued.push(agentName);
  }

  return { enqueued, skipped: [] };
};

module.exports = {
  extractMentions,
  enqueueMentions,
  enqueueDmEvent,
  MENTION_ALIASES,
};
