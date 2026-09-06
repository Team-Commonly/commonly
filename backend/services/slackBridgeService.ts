import SlackApi = require('./slackApi');

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const isPodMember = require('../utils/isPodMember');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const connectorSecrets = require('./connectorSecrets');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { shouldEscalate } = require('./connectorRelayPolicy');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const channelVerdictService = require('./channelVerdictService');
import type { DecisionRelayCard } from './decisionCardRelay';
import { resolveDecisionCardReply } from './decisionCardReply';
import type { ChannelCardEntry } from './decisionCardReply';

const RELAY_MAP_CAP = 100;
const OUTBOUND_TEXT_CAP = 900;
const CARD_OUTBOUND_TEXT_CAP = 1_900;

interface SlackIntegrationDoc {
  _id: unknown;
  installationId?: string;
  podId: unknown;
  scope?: 'pod' | 'user';
  type?: string;
  isActive?: boolean;
  status?: string;
  config?: {
    teamId?: string;
    chatId?: string;
    chatType?: string;
    botTokenRef?: string;
    linkedUserId?: string;
    slackUserId?: string;
    liveRelay?: boolean;
    relayAllAgentMessages?: boolean;
    gates?: Record<string, { enabled?: boolean }>;
    leadAgentUsername?: string;
    relayMutedUntil?: Date | string;
    adminPause?: { reason?: string; at?: Date | string; adminId?: string };
    relayMap?: Array<{
      externalMessageId?: string;
      tgMessageId?: string;
      agentUsername?: string;
      podMessageId?: string | null;
      podId?: string;
    }>;
    cards?: ChannelCardEntry[];
  };
}

const isRelayableIntegration = (integration: SlackIntegrationDoc, podId: string): boolean => (
  (integration.scope === 'user'
    ? integration.config?.gates?.[String(podId)]?.enabled === true
    : String(integration.podId) === String(podId))
  && integration.type === 'slack'
  && integration.isActive === true
  && integration.status !== 'error'
  && integration.config?.liveRelay === true
  && integration.config?.chatType === 'im'
  && !integration.config?.adminPause
  && Boolean(integration.config?.teamId)
  && Boolean(integration.config?.chatId)
  && Boolean(integration.config?.botTokenRef)
);

const truncateWithEllipsis = (value: string, limit: number): string => {
  if (value.length <= limit) return value;
  if (limit <= 1) return '…'.slice(0, limit);
  return `${value.slice(0, limit - 1)}…`;
};

// Slack mrkdwn treats these as control characters: escaping keeps agent-authored
// card fields from creating links, mentions, or other markup in a human's DM.
const escapeSlackMrkdwn = (raw: string): string => String(raw)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

export const renderSlackDecisionCard = (opts: {
  card: DecisionRelayCard;
  displayName: string;
  agentUsername: string;
  link: string;
}): string => {
  const { card, displayName, agentUsername, link } = opts;
  const footer = `\n\nReply to this message with a number, or write your ruling.\nopen in Commonly → ${link}`;
  const optionLines = card.options.map((option, index) => (
    `\n${index + 1}. *${escapeSlackMrkdwn(option.label)}*${option.recommended ? ' ★ recommended' : ''}`
  ));
  const title = escapeSlackMrkdwn(card.title);
  const question = escapeSlackMrkdwn(card.question);
  const agent = escapeSlackMrkdwn(displayName || agentUsername);
  const header = `*${agent} needs a ruling · ${title}*\n${question}\n`;
  let remaining = CARD_OUTBOUND_TEXT_CAP - header.length - footer.length
    - optionLines.reduce((sum, line) => sum + line.length, 0);
  const descriptions = card.options.map((option) => (
    option.description ? escapeSlackMrkdwn(truncateWithEllipsis(option.description, 100)) : ''
  ));
  const descriptionLines = descriptions.map((description, index) => {
    if (!description || remaining <= 4) return '';
    const nonEmptyRemaining = descriptions.slice(index).filter(Boolean).length;
    const allowance = Math.max(0, Math.floor(remaining / Math.max(1, nonEmptyRemaining)) - 4);
    if (!allowance) return '';
    const fitted = truncateWithEllipsis(description, allowance);
    const line = `\n   ${fitted}`;
    remaining -= line.length;
    return line;
  });
  return header + optionLines.map((line, index) => `${line}${descriptionLines[index]}`).join('') + footer;
};

// The enabled gate is only the pod → connector subscription. Inbound follows
// the owner's active pod selection and validates membership at receive time.
const isInboundRelayableIntegration = (integration: SlackIntegrationDoc, podId: string): boolean => (
  String(integration.podId) === String(podId)
  && integration.type === 'slack'
  && integration.isActive === true
  && integration.status !== 'error'
  && integration.config?.liveRelay === true
  && integration.config?.chatType === 'im'
  && !integration.config?.adminPause
  && Boolean(integration.config?.teamId)
  && Boolean(integration.config?.chatId)
  && Boolean(integration.config?.botTokenRef)
);

const NO_ACTIVE_POD_REPLY = 'This connector has no active pod. Choose one in Commonly first.';

const replyNoActivePod = async (integration: SlackIntegrationDoc): Promise<void> => {
  const chatId = integration.config?.chatId;
  const botTokenRef = integration.config?.botTokenRef;
  if (!chatId || !botTokenRef) return;
  try {
    const token = await connectorSecrets.get(String(botTokenRef));
    await new SlackApi(token).postMessage(String(chatId), NO_ACTIVE_POD_REPLY);
  } catch (error) {
    console.warn('[slack-bridge] could not send no-active-pod reply:', (error as Error).message);
  }
};

const findLiveIntegration = async (podId: string): Promise<SlackIntegrationDoc | null> => (
  Integration.findOne({
    type: 'slack',
    isActive: true,
    status: { $ne: 'error' },
    podId,
    'config.liveRelay': true,
    'config.chatType': 'im',
    'config.teamId': { $exists: true, $ne: null },
    'config.chatId': { $exists: true, $ne: null },
    'config.botTokenRef': { $exists: true, $ne: null },
    'config.adminPause': { $exists: false },
  }).lean()
);

// Outbound is intentionally secret-ref-only: legacy Slack rows remain on the
// legacy provider path and cannot be selected by the installable dispatcher.
export const relayAgentMessageToSlack = async (opts: {
  podId: string;
  agentUsername: string;
  displayName: string;
  content: string;
  podMessageId?: string | null;
  card?: DecisionRelayCard;
  integration?: SlackIntegrationDoc;
}): Promise<void> => {
  const {
    podId, agentUsername, displayName, content, podMessageId,
  } = opts;
  try {
    const integration = opts.integration ?? await findLiveIntegration(podId);
    if (!integration) return;
    const cardHoldReason = opts.card
      ? (integration.config?.adminPause
        ? 'paused'
        : integration.scope === 'user' && integration.config?.gates?.[podId]?.enabled !== true
          ? 'gate_off'
          : null)
      : null;
    if (cardHoldReason) {
      if (podMessageId) {
        await channelVerdictService.record({
          integrationId: integration._id,
          ...(integration.installationId ? { installationId: integration.installationId } : {}),
          podId,
          provider: 'slack',
          event: { kind: 'decision_request', podMessageId },
          verdict: 'hold',
          reason: cardHoldReason,
        });
      }
      return;
    }
    if (!isRelayableIntegration(integration, podId)) return;
    const mutedUntil = integration.config?.relayMutedUntil;
    if (mutedUntil && new Date(mutedUntil) > new Date()) {
      if (opts.card && podMessageId) {
        await channelVerdictService.record({
          integrationId: integration._id,
          ...(integration.installationId ? { installationId: integration.installationId } : {}),
          podId,
          provider: 'slack',
          event: { kind: 'decision_request', podMessageId },
          verdict: 'hold',
          reason: 'muted',
        });
      }
      return;
    }
    if (!opts.card && !shouldEscalate({ content, agentUsername, integration, podId })) return;

    const [pod, token] = await Promise.all([
      Pod.findById(podId).select('name').lean(),
      connectorSecrets.get(String(integration.config!.botTokenRef)),
    ]);
    const podName = String(pod?.name || 'Commonly');
    const base = (process.env.PUBLIC_APP_URL || 'https://commonly.me').replace(/\/$/, '');
    const link = opts.card && podMessageId
      ? `${base}/v2/pods/${encodeURIComponent(podId)}?message=${encodeURIComponent(podMessageId)}`
      : `${base}/v2/pods/${podId}`;
    const text = opts.card
      ? renderSlackDecisionCard({ card: opts.card, displayName, agentUsername, link })
      : `[${podName}] ${displayName || agentUsername}: ${String(content).slice(0, OUTBOUND_TEXT_CAP)}`;
    const result = await new SlackApi(token).postMessage(String(integration.config!.chatId), text);
    if (!result.ok || !result.ts) {
      throw new Error(`chat.postMessage failed: ${String(result.error || 'unknown error')}`);
    }
    await Integration.findByIdAndUpdate(integration._id, {
      $push: {
        'config.relayMap': {
          $each: [{
            externalMessageId: String(result.ts), agentUsername, podMessageId: podMessageId || null, podId,
          }],
          $slice: -RELAY_MAP_CAP,
        },
        ...(opts.card && podMessageId ? {
          'config.cards': { podMessageId, externalMessageId: String(result.ts), sentAt: new Date() },
        } : {}),
      },
    });
    if (opts.card && podMessageId) {
      await channelVerdictService.record({
        integrationId: integration._id,
        ...(integration.installationId ? { installationId: integration.installationId } : {}),
        podId,
        provider: 'slack',
        event: { kind: 'decision_request', podMessageId },
        verdict: 'interrupt',
        reason: 'card',
      });
    }
  } catch (error) {
    const config = opts.integration?.config;
    console.warn(
      `[slack-bridge] outbound relay failed integration=${String(opts.integration?._id || 'lookup')} `
      + `team=${String(config?.teamId || 'unknown')}: ${(error as Error).message}`,
    );
  }
};

// D11: a Slack thread attached to a relayed line is a direct answer to that
// line's agent. Keep the map generic so Telegram can migrate from tgMessageId
// without changing this reader.
export const routeSlackReplyContent = (opts: {
  content: string;
  threadTs?: string | null;
  relayMap?: Array<{
    externalMessageId?: string;
    tgMessageId?: string;
    agentUsername?: string;
  }>;
}): { content: string; routedAgent: string | null } => {
  const { content, threadTs, relayMap } = opts;
  if (!threadTs || !Array.isArray(relayMap)) return { content, routedAgent: null };
  const hit = relayMap.find((entry) => String(entry.externalMessageId || entry.tgMessageId) === String(threadTs));
  if (!hit?.agentUsername) return { content, routedAgent: null };
  const mention = `@${hit.agentUsername}`;
  return content.toLowerCase().includes(mention.toLowerCase())
    ? { content, routedAgent: hit.agentUsername }
    : { content: `${mention} ${content}`, routedAgent: hit.agentUsername };
};

// Inbound Slack DM → Commonly pod. The event route has already proven the
// Slack signature and selected the team/channel row; this function repeats
// the ownership-shaped checks because a bridge is never allowed to rely on a
// caller's selection alone.
export const relaySlackMessageToPod = async (opts: {
  integration: SlackIntegrationDoc;
  event: {
    text?: string;
    user?: string;
    ts?: string;
    thread_ts?: string;
    user_profile?: { real_name?: string; display_name?: string };
  };
}): Promise<{ relayed: boolean; routedAgent?: string | null }> => {
  const { integration, event } = opts;
  const rawText = String(event.text || '').trim();
  if (!rawText || rawText.startsWith('/')) return { relayed: false };
  if (!integration.podId && !integration.config?.cards?.length) {
    // A user-scoped connector may have gates without an active inbound
    // destination. Fail closed rather than querying/authoring under
    // `String(undefined)`.
    console.warn('[slack-bridge] inbound dropped — connector has no active pod');
    await replyNoActivePod(integration);
    return { relayed: false };
  }
  const config = integration.config || {};
  if (
    !isInboundRelayableIntegration(integration, String(integration.podId))
    || !config.linkedUserId
    || !config.slackUserId
    || event.user !== config.slackUserId
  ) {
    console.warn(
      `[slack-bridge] inbound dropped integration=${String(integration._id)}: `
      + 'unbound or mismatched DM sender',
    );
    return { relayed: false };
  }
  const cardReply = await resolveDecisionCardReply({
    integrationId: integration._id,
    linkedUserId: String(config.linkedUserId),
    cards: config.cards,
    provider: 'slack',
    text: rawText,
    replyToExternalId: event.thread_ts,
  });
  if (cardReply.confirmation) {
    try {
      const token = await connectorSecrets.get(String(config.botTokenRef));
      const sent = await new SlackApi(token).postMessage(
        String(config.chatId), escapeSlackMrkdwn(cardReply.confirmation), undefined, cardReply.externalMessageId,
      );
      if (!sent.ok) console.warn('[slack-bridge] card confirmation was not sent');
    } catch (error) {
      console.warn('[slack-bridge] card confirmation failed:', (error as Error).message);
    }
  }
  if (cardReply.handled && !cardReply.lateReply) return { relayed: false };
  if (!cardReply.lateReply && !integration.podId) {
    await replyNoActivePod(integration);
    return { relayed: false };
  }
  const { content: routedText, routedAgent } = routeSlackReplyContent({
    content: rawText,
    threadTs: event.thread_ts,
    relayMap: cardReply.lateReply ? [] : config.relayMap,
  });
  const podId = cardReply.lateReply?.podId || String(integration.podId);
  const replyToMessageId = cardReply.lateReply?.messageId || null;
  const linkedUserId = String(config.linkedUserId);
  const senderName = event.user_profile?.display_name || event.user_profile?.real_name;
  const content = senderName
    ? `💬 ${senderName} (via Slack): ${routedText}`
    : `💬 (via Slack): ${routedText}`;

  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const User = require('../models/User');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const PodModel = require('../models/Pod');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const PGMessage = require('../models/pg/Message');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { deliverMessageToAgents } = require('./messageAgentDeliveryService');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const socketConfig = require('../config/socket');

  const pod = await PodModel.findById(podId).select('type createdBy members').lean();
  if (!pod || !isPodMember(pod, linkedUserId)) {
    console.warn('[slack-bridge] inbound dropped — linked user is no longer a pod member');
    await replyNoActivePod(integration);
    return { relayed: false };
  }
  const linkedUser = await User.findById(linkedUserId).select('username profilePicture').lean();
  if (!linkedUser) {
    console.warn('[slack-bridge] inbound dropped — linked user missing');
    return { relayed: false };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const PGPod = require('../models/pg/Pod');
    if (!await PGPod.findById(podId)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const { syncPodFromMongo } = require('./pgPodSyncService');
      await syncPodFromMongo(podId, linkedUserId);
    }
  } catch (error) {
    console.warn('[slack-bridge] PG pod backfill skipped:', (error as Error).message);
  }
  let threadRootId: number | null = null;
  if (cardReply.lateReply?.threadRootId) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { resolveThreadRoot } = require('./threadRootResolver');
    threadRootId = await resolveThreadRoot({ podId, replyToMessageId, threadRootId: cardReply.lateReply.threadRootId });
  }
  const created = await PGMessage.create(podId, linkedUserId, content, 'text', replyToMessageId, null, threadRootId);
  let message: Record<string, unknown> = created;
  try {
    const populated = created?.id ? await PGMessage.findById(created.id) : null;
    if (populated) message = populated;
  } catch (error) {
    console.warn('[slack-bridge] post-write read failed:', (error as Error).message);
  }
  // A post is durable. As in the Telegram bridge, do not turn a later wake or
  // socket failure into a Slack retry that writes the same human message again.
  try {
    await deliverMessageToAgents({
      podId,
      podType: pod.type,
      message,
      userId: linkedUserId,
      requestUser: { username: linkedUser.username },
      replyToMessageId,
    });
  } catch (error) {
    console.error('[slack-bridge] agent delivery failed after pod write:', (error as Error).message);
  }
  try {
    const io = socketConfig.getIO();
    if (io) {
      io.to(`pod_${podId}`).emit('newMessage', {
        _id: (message as { id?: unknown }).id,
        id: (message as { id?: unknown }).id,
        pod_id: podId,
        podId,
        content: (message as { content?: unknown }).content || content,
        messageType: 'text',
        userId: { _id: linkedUserId, username: linkedUser.username, profilePicture: linkedUser.profilePicture },
        username: linkedUser.username,
        profile_picture: linkedUser.profilePicture,
        createdAt: (message as { created_at?: unknown }).created_at || new Date(),
        replyTo: replyToMessageId,
        thread_root_id: (message as { thread_root_id?: unknown }).thread_root_id ?? threadRootId ?? replyToMessageId,
        payload: null,
      });
    }
  } catch (error) {
    console.warn('[slack-bridge] socket emit failed:', (error as Error).message);
  }
  return { relayed: true, routedAgent };
};

module.exports = {
  relayAgentMessageToSlack,
  relaySlackMessageToPod,
  routeSlackReplyContent,
  renderSlackDecisionCard,
  isRelayableIntegration,
  isInboundRelayableIntegration,
};
