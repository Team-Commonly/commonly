// eslint-disable-next-line global-require
const AgentEventService = require('./agentEventService');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const AgentProfile = require('../models/AgentProfile');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const chatSummarizerService = require('./chatSummarizerService');

const ChatSummarizerService = chatSummarizerService.constructor as {
  getLatestPodSummary: (podId: string) => Promise<unknown>;
};

interface MentionTarget {
  agentName: string;
  instanceId: string;
}

interface MentionMapEntry {
  agentName: string;
  instanceId: string;
  displayName: string;
  displaySlug: string;
}

interface EnqueueMentionsOptions {
  podId: string;
  message: {
    content?: string;
    text?: string;
    source?: string;
    _id?: unknown;
    id?: unknown;
    messageType?: string;
    message_type?: string;
    createdAt?: unknown;
    created_at?: unknown;
    thread?: unknown;
  };
  userId: string;
  username: string;
}

interface EnqueueDmOptions {
  podId: string;
  message: EnqueueMentionsOptions['message'];
  userId: string;
  username: string;
}

interface EnqueueResult {
  enqueued: string[];
  skipped: string[];
}

interface EnqueueDmResult {
  enqueued: string[] | boolean;
  skipped?: string[];
  reason?: string;
}

interface SummaryPayload {
  content: unknown;
  title: unknown;
  source: string;
  sourceLabel: string;
  channelName: string;
  channelUrl: null;
  messageCount: number;
  timeRange: unknown;
  summaryType: string;
}

interface SummaryEnqueueOptions {
  podId: string;
  instanceId: string;
  summary: Record<string, unknown> | null;
  pod: Record<string, unknown> | null;
}

interface SenderRow {
  isBot?: boolean;
  botMetadata?: { agentName?: string; instanceId?: string };
}

/**
 * Mention Aliases
 *
 * Maps @mention aliases to agent types
 * agentType = the runtime type (openclaw, commonly-bot, etc.)
 */
const MENTION_ALIASES: Record<string, string[]> = {};

const buildAliasMap = (): Map<string, string> => {
  const aliasMap = new Map<string, string>();
  Object.entries(MENTION_ALIASES).forEach(([agentType, aliases]) => {
    aliases.forEach((alias) => {
      aliasMap.set(alias.toLowerCase(), agentType);
    });
  });
  return aliasMap;
};

const aliasMap = buildAliasMap();

const extractMentions = (content = ''): string[] => {
  if (!content || typeof content !== 'string') return [];
  const mentions = new Set<string>();
  const regex = /@([a-z0-9-]{2,})/gi;
  let match;
  // eslint-disable-next-line no-cond-assign
  while ((match = regex.exec(content)) !== null) {
    const raw = match[1]?.toLowerCase();
    if (!raw) continue;
    mentions.add(raw);
  }
  return Array.from(mentions);
};

const slugify = (value = ''): string => value
  .toString()
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '');

const buildMentionMap = (
  installations: Array<Record<string, unknown>> = [],
  profiles: Array<Record<string, unknown>> = [],
): { map: Map<string, MentionTarget>; byAgent: Map<string, MentionMapEntry[]> } => {
  const map = new Map<string, MentionTarget>();
  const byAgent = new Map<string, MentionMapEntry[]>();

  installations.forEach((installation) => {
    const agentName = installation.agentName as string;
    const instanceId = (installation.instanceId as string) || 'default';
    const profile = profiles.find(
      (p) => p.agentName === agentName && p.instanceId === instanceId,
    );
    const displayName = (installation.displayName as string) || (profile?.name as string) || agentName;
    const displaySlug = slugify(displayName);

    const list = byAgent.get(agentName) || [];
    list.push({
      agentName, instanceId, displayName, displaySlug,
    });
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

const buildSummaryPayload = (
  summary: Record<string, unknown> | null,
  pod: Record<string, unknown> | null,
): SummaryPayload | null => {
  if (!summary) return null;
  const metadata = summary.metadata as Record<string, unknown> | undefined;
  return {
    content: summary.content,
    title: summary.title,
    source: 'chat',
    sourceLabel: 'Commonly',
    channelName: (metadata?.podName as string) || (pod?.name as string) || 'pod',
    channelUrl: null,
    messageCount: (metadata?.totalItems as number) || 0,
    timeRange: summary.timeRange || null,
    summaryType: (summary.type as string) || 'chats',
  };
};

const enqueueSummarizerEvent = async ({
  podId,
  instanceId,
  summary,
  pod,
}: SummaryEnqueueOptions): Promise<void> => {
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

// Feature gate for the §3.4 mention-driven autoJoin path. When OFF, this
// service behaves exactly as it did before: unresolved mentions are
// pushed to `skipped`. When ON, an unresolved alias falls through to
// pod.contacts → sender.contacts and may install an agent into the pod.
// Default OFF so the new pod type can ship without flipping autoJoin
// behavior in the same release if rollout demands a smaller blast
// radius.
const isMentionAutoJoinEnabled = (): boolean => (
  String(process.env.ENABLE_MENTION_AUTOJOIN || '').toLowerCase() === 'true'
);

// Try the alias against pod-level binding first, then sender's contact
// list. Returns the resolved binding *and the source* so the autoJoin
// gate can apply the §3.2 admin-binding carve-out without re-reading
// `pod.contacts` (which would open a TOCTOU window if an admin removed
// the binding mid-resolution). Caller passes the already-fetched
// pod.contacts row so we don't re-query.
type ResolvedAlias =
  | { agentName: string; instanceId: string; source: 'pod' | 'sender' }
  | null;

const resolveContactAlias = async (
  alias: string,
  podContacts: Record<string, { agentName?: string; instanceId?: string }> | null | undefined,
  senderUserId: string,
): Promise<ResolvedAlias> => {
  const lower = alias.toLowerCase();
  const fromPod = podContacts?.[lower];
  if (fromPod?.agentName) {
    return { agentName: fromPod.agentName.toLowerCase(), instanceId: fromPod.instanceId || 'default', source: 'pod' };
  }
  try {
    const sender = await User.findById(senderUserId).select('contacts').lean() as { contacts?: Array<{ alias?: string; agentName?: string; instanceId?: string }> } | null;
    const fromSender = (sender?.contacts || []).find((c) => (c.alias || '').toLowerCase() === lower && c.agentName);
    if (fromSender?.agentName) {
      return { agentName: fromSender.agentName.toLowerCase(), instanceId: fromSender.instanceId || 'default', source: 'sender' };
    }
  } catch (err) {
    console.warn('[mention-autojoin] sender contacts lookup failed:', (err as Error).message);
  }
  return null;
};

// Pull a non-member agent into the pod via mention-driven autoJoin.
// Runs the §3.7 co-pod-member rule (with the §3.2 admin-binding carve-
// out — i.e. if the resolution came from pod.contacts, that's the
// authorization signal). Idempotent on (agentName, instanceId, podId).
// Returns true on success, false on auth-refused.
const autoJoinAgentToPod = async (
  agentName: string,
  instanceId: string,
  podId: string,
  senderUserId: string,
  resolvedFromPodBinding: boolean,
): Promise<boolean> => {
  // eslint-disable-next-line global-require
  const AgentIdentityService = require('./agentIdentityService');
  // eslint-disable-next-line global-require
  const DMService = require('./dmService');
  // eslint-disable-next-line global-require
  const AgentMessageService = require('./agentMessageService');

  const targetUser = await AgentIdentityService.getOrCreateAgentUser(agentName, { instanceId });
  if (!targetUser?._id) return false;

  // Authorization: pod-binding is itself the admin signal; otherwise
  // require sharePod between sender and target.
  if (!resolvedFromPodBinding) {
    const shared = await DMService.sharePod(senderUserId, targetUser._id);
    if (!shared) {
      console.warn(`[mention-autojoin] refused — no shared pod between sender=${senderUserId} target=${agentName}:${instanceId}`);
      return false;
    }
  }

  // Upsert the AgentInstallation (heartbeat off — agent-dm and pulled-
  // in agents are reactive, not scheduled). Idempotent.
  await AgentInstallation.upsert(agentName, podId, {
    version: '1.0.0',
    config: {
      heartbeat: { enabled: false },
      autoJoinSource: 'mention-resolution',
    } as unknown as Map<string, unknown>,
    scopes: ['context:read', 'summaries:read', 'messages:write'],
    installedBy: senderUserId,
    instanceId,
    displayName: agentName,
  });

  // Add to pod.members if not already.
  try {
    await Pod.updateOne({ _id: podId }, { $addToSet: { members: targetUser._id } });
  } catch (err) {
    console.warn('[mention-autojoin] pod.members $addToSet failed:', (err as Error).message);
  }

  // Drop a system event so humans see what happened.
  try {
    await AgentMessageService.postMessage({
      agentName: 'commonly-bot',
      podId,
      content: `↗︎ pulled in @${agentName} via @-mention resolution`,
      metadata: { systemEventType: 'mention-autojoin', agentName, instanceId },
    });
  } catch (err) {
    console.warn('[mention-autojoin] system event post failed:', (err as Error).message);
  }

  return true;
};

const enqueueMentions = async ({
  podId,
  message,
  userId,
  username,
}: EnqueueMentionsOptions): Promise<EnqueueResult> => {
  const content = message?.content || message?.text || '';
  const source = message?.source || 'chat';
  const eventType = source === 'thread' ? 'thread.mention' : 'chat.mention';
  const rawMentions = extractMentions(content);
  if (!podId || rawMentions.length === 0) {
    return { enqueued: [], skipped: [] };
  }

  const enqueued: string[] = [];
  const skipped: string[] = [];

  let installations: Array<Record<string, unknown>> = [];
  let profiles: Array<Record<string, unknown>> = [];
  try {
    installations = await AgentInstallation.find({
      podId,
      status: 'active',
    }).lean();
    profiles = await AgentProfile.find({ podId }).lean();
  } catch (error) {
    console.warn('Agent mention lookup failed:', (error as Error).message);
  }

  const { map: mentionMap, byAgent } = buildMentionMap(installations, profiles);
  let pod: Record<string, unknown> | null = null;

  // Self-mention guard: if the sender is a bot, resolve their own
  // (agentName, instanceId) so we can skip re-enqueuing an event on themselves.
  // Without this, any agent whose reply echoes its own handle (e.g. the
  // webhook-SDK "echo:" template, or a CLI-wrapper that quotes the mention)
  // triggers an infinite chat.mention → reply → chat.mention loop.
  let sender: SenderRow | null = null;
  try {
    sender = await User.findById(userId).select('isBot botMetadata').lean() as SenderRow | null;
  } catch (error) {
    // Non-fatal: missing sender just means we can't suppress self-mentions,
    // which is a strictly weaker invariant than the one we had before.
    console.warn('Agent mention sender lookup failed:', (error as Error).message);
  }
  const senderAgentName = sender?.isBot ? sender.botMetadata?.agentName?.toLowerCase() : null;
  const senderInstanceId = sender?.isBot ? (sender.botMetadata?.instanceId || 'default') : null;
  const isSelfMention = (target: MentionTarget): boolean => (
    !!senderAgentName
    && target.agentName.toLowerCase() === senderAgentName
    && (target.instanceId || 'default') === senderInstanceId
  );

  await Promise.all(
    rawMentions.map(async (raw) => {
      const normalized = raw.toLowerCase();
      const directMatch = mentionMap.get(normalized);
      if (directMatch) {
        if (isSelfMention(directMatch)) {
          skipped.push(`${directMatch.agentName}:self`);
          return;
        }
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
              summary: summary as Record<string, unknown> | null,
              pod: pod as Record<string, unknown> | null,
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
          console.warn('Failed to enqueue agent mention:', (error as Error).message);
        }
        return;
      }

      // §3.4 mention-driven autoJoin — resolve unresolved aliases via
      // pod.contacts then sender.contacts, then upsert + add to pod and
      // proceed to enqueue. Behind ENABLE_MENTION_AUTOJOIN so the new
      // pod type can ship without flipping this in the same release.
      if (isMentionAutoJoinEnabled()) {
        try {
          // Single fetch of pod.contacts; both the resolver and the
          // admin-binding carve-out read from this snapshot so a binding
          // can't be removed between resolution and authorization (the
          // TOCTOU window the v1 implementation had).
          const podRow = await Pod.findById(podId).select('contacts').lean() as { contacts?: Record<string, { agentName?: string; instanceId?: string }> } | null;
          const podContacts = podRow?.contacts || null;
          const resolved = await resolveContactAlias(normalized, podContacts, userId);
          if (resolved) {
            const joined = await autoJoinAgentToPod(
              resolved.agentName,
              resolved.instanceId,
              podId,
              userId,
              resolved.source === 'pod',
            );
            if (joined) {
              await AgentEventService.enqueue({
                agentName: resolved.agentName,
                instanceId: resolved.instanceId,
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
                  autoJoined: true,
                },
              });
              enqueued.push(`${resolved.agentName}:autoJoined`);
              return;
            }
            skipped.push(`${normalized}:auth-refused`);
            return;
          }
        } catch (err) {
          console.warn('[mention-autojoin] resolution path failed:', (err as Error).message);
        }
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
            if (isSelfMention({ agentName: agentType, instanceId: match.instanceId })) {
              skipped.push(`${agentType}:self`);
              return;
            }
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
                  summary: summary as Record<string, unknown> | null,
                  pod: pod as Record<string, unknown> | null,
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
              console.warn('Failed to enqueue agent mention:', (error as Error).message);
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

// Pod types that auto-route every message to non-sender members as a
// chat.mention event. Adding a new private 1:1 type without listing it
// here silently drops every message; mirrored in
// `messageController.createMessage` and called out in
// docs/agents/AGENT_RUNTIME.md "Routing Invariants".
const DM_POD_TYPES = new Set(['agent-admin', 'agent-room', 'agent-dm']);

/**
 * Auto-enqueue a DM-origin chat.mention event for every user message in a
 * DM-shaped pod (agent-admin / agent-room / agent-dm). Unlike regular
 * mentions, no explicit @mention is required — the pod itself is the
 * routing primitive. For agent-dm with two bot members, the sender check
 * below allows bot-to-bot DMs to enqueue against the non-sender.
 */
const enqueueDmEvent = async ({
  podId, message, userId, username,
}: EnqueueDmOptions): Promise<EnqueueDmResult> => {
  const pod = await Pod.findById(podId).lean() as Record<string, unknown> | null;
  if (!pod || !DM_POD_TYPES.has(pod.type as string)) {
    return { enqueued: false, reason: 'not_dm_pod' };
  }

  const sender = await User.findById(userId).select('_id isBot').lean() as { _id: unknown; isBot?: boolean } | null;
  // Bot senders are allowed in agent-dm (the whole point) but still blocked
  // in agent-admin/agent-room — those are operator-driven 1:1 with one
  // agent; a bot posting there shouldn't auto-route to itself.
  if (sender?.isBot && pod.type !== 'agent-dm') {
    return { enqueued: false, reason: 'sender_is_bot' };
  }

  // Bot-loop guard for agent-dm rooms. Without this, agent A and agent
  // B can ping-pong forever (every message auto-routes a chat.mention,
  // each reply does the same, neither stops — and humans aren't members
  // so they can't post a turn to break the streak themselves). The
  // guard refuses to enqueue when:
  //   - the sender is a bot, AND
  //   - the last MAX_CONSECUTIVE_BOT_TURNS messages in this pod are ALL
  //     from bots, AND
  //   - those messages are within the recent activity window (so a
  //     dormant DM picking back up tomorrow doesn't trip on yesterday's
  //     final exchange).
  // To resume after a trip, a human can @mention either bot in a pod
  // they share — that fires a chat.mention OUTSIDE agent-dm, and the
  // agent can choose to re-engage in the dm at its own discretion.
  const MAX_CONSECUTIVE_BOT_TURNS = 8;
  const ACTIVITY_WINDOW_MS = 30 * 60 * 1000; // 30 min
  if (sender?.isBot && pod.type === 'agent-dm') {
    try {
      // eslint-disable-next-line global-require
      const PGMessageLocal = require('../models/pg/Message');
      const recent = PGMessageLocal && typeof PGMessageLocal.findByPodId === 'function'
        ? (await PGMessageLocal.findByPodId(podId, MAX_CONSECUTIVE_BOT_TURNS)) as Array<{ user_id?: unknown; created_at?: unknown }>
        : null;
      if (recent && recent.length >= MAX_CONSECUTIVE_BOT_TURNS) {
        const cutoff = Date.now() - ACTIVITY_WINDOW_MS;
        const inWindow = recent.every((m) => {
          const t = new Date(String(m?.created_at || '')).getTime();
          return Number.isFinite(t) && t >= cutoff;
        });
        if (inWindow) {
          const recentSenderIds = recent
            .map((m) => String(m?.user_id || ''))
            .filter(Boolean);
          const uniqueSenders = Array.from(new Set(recentSenderIds));
          if (uniqueSenders.length > 0) {
            const recentBots = await User.find({
              _id: { $in: uniqueSenders },
              isBot: true,
            }).select('_id').lean() as Array<{ _id: unknown }>;
            const botIds = new Set(recentBots.map((u) => String(u._id)));
            const allBots = recentSenderIds.every((id) => botIds.has(id));
            if (allBots) {
              console.warn(`[agent-dm] bot-loop guard tripped — ${MAX_CONSECUTIVE_BOT_TURNS} consecutive bot turns in pod=${podId} within ${ACTIVITY_WINDOW_MS / 60000}min, refusing enqueue`);
              return { enqueued: false, reason: 'bot_loop_guard' };
            }
          }
        }
      }
    } catch (err) {
      console.warn('[agent-dm] bot-loop guard recent-message check failed (allowing through):', (err as Error).message);
    }
  }

  const senderIdStr = String(userId);
  const otherMemberIds = ((pod.members as unknown[]) || [])
    .map((m: unknown) => {
      const mem = m as { _id?: unknown } | string;
      return String(typeof mem === 'object' && mem !== null ? mem._id || mem : mem);
    })
    .filter((id) => id !== senderIdStr);

  if (otherMemberIds.length === 0) {
    return { enqueued: false, reason: 'no_other_member' };
  }

  const agentMembers = await User.find({
    _id: { $in: otherMemberIds },
    isBot: true,
  }).select('_id username botMetadata').lean() as Array<{
    _id: unknown;
    username: string;
    botMetadata?: { agentName?: string; instanceId?: string };
  }>;

  if (agentMembers.length === 0) {
    return { enqueued: false, reason: 'no_agent_user' };
  }

  const content = message?.content || message?.text || '';
  const enqueued: string[] = [];

  for (const agentUser of agentMembers) {
    const agentName = agentUser.botMetadata?.agentName || agentUser.username;
    const instanceId = agentUser.botMetadata?.instanceId || 'default';
    const mentionHandle = `@${instanceId}`;

    const installations = await AgentInstallation.find({
      agentName: agentName.toLowerCase(),
      instanceId,
      status: 'active',
    })
      .select('podId installedBy')
      .lean() as Array<{ podId: unknown; installedBy: unknown }>;

    if (!Array.isArray(installations) || installations.length === 0) continue;

    const senderScopedPodIds = new Set<string>(
      installations
        .filter((entry) => String(entry?.installedBy || '') === senderIdStr)
        .map((entry) => String(entry?.podId || ''))
        .filter(Boolean),
    );

    const memberPodCandidates = installations
      .map((entry) => entry?.podId)
      .filter(Boolean);
    if (memberPodCandidates.length > 0) {
      const memberPods = await Pod.find({
        _id: { $in: memberPodCandidates },
        members: userId,
      }).select('_id').lean() as Array<{ _id: unknown }>;
      memberPods.forEach((entry) => {
        const id = String(entry?._id || '');
        if (id) senderScopedPodIds.add(id);
      });
    }

    const availablePods = senderScopedPodIds.size > 0
      ? await Pod.find({ _id: { $in: Array.from(senderScopedPodIds) } })
        .select('_id name type')
        .lean() as Array<{ _id: unknown; name?: string; type?: string }>
      : [];
    const installationPodId = (installations[0]?.podId as { toString?: () => string })?.toString?.() || null;

    await AgentEventService.enqueue({
      agentName: agentName.toLowerCase(),
      instanceId,
      podId,
      type: 'chat.mention',
      payload: {
        messageId: message?._id || message?.id
          ? String(message?._id || message?.id)
          : undefined,
        content,
        userId,
        username,
        mentions: [mentionHandle],
        source: 'dm',
        messageType: message?.messageType || message?.message_type || 'text',
        createdAt: message?.createdAt || message?.created_at || new Date(),
        dmPodId: String(podId),
        installationPodId,
        availablePods: (availablePods || []).map((entry) => ({
          podId: String(entry?._id || ''),
          name: entry?.name || null,
          type: entry?.type || null,
        })),
      },
    });
    enqueued.push(agentName);
  }

  return { enqueued, skipped: [] };
};

export {
  extractMentions,
  enqueueMentions,
  enqueueDmEvent,
  MENTION_ALIASES,
};
