import SlackApi = require('./slackApi');

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const isPodMember = require('../utils/isPodMember');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const connectorSecrets = require('./connectorSecrets');
const deliveryFailures = require('./connectorDeliveryFailureService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { shouldEscalate, isGatedPodTarget, isRoutedPodTarget } = require('./connectorRelayPolicy');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const channelVerdictService = require('./channelVerdictService');
import type { DecisionRelayCard } from './decisionCardRelay';
import { resolveDecisionCardReply } from './decisionCardReply';
import type { ChannelCardEntry } from './decisionCardReply';

const RELAY_MAP_CAP = 100;

// One implementation, in slackApi.ts one step above the call that posts it. This
// file and decisionCardReconcileService each carried their own copy, which is how
// an escaped call site came to sit beside an unescaped one in the same ternary.
const escapeSlackMrkdwn = SlackApi.escapeSlackMrkdwn;
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
  isGatedPodTarget(integration, podId)
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

// Every field this renderer is handed goes through the shared escape: mrkdwn
// reads &, < and > as markup, so an agent-authored card could otherwise create
// links and mentions in a human's DM.
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

// ADR-025 D11: a quote-reply whose pod is no longer reachable is refused in the
// chat and posted nowhere. Naming the pod is the whole point — "your reply did
// not go through" is unactionable, while "that line came from Launch" tells the
// user which pod the fix is in.
const routedPodRefusal = (podLabel: string): string => (
  `⚠️ That line came from “${podLabel}”, which this chat no longer reaches. `
  + 'Nothing was posted — open Commonly to reply there.'
);

const replyNoActivePod = async (integration: SlackIntegrationDoc): Promise<void> => {
  const chatId = integration.config?.chatId;
  const botTokenRef = integration.config?.botTokenRef;
  if (!chatId || !botTokenRef) return;
  try {
    const token = await connectorSecrets.get(String(botTokenRef));
    // Bound channel, so this is one of the sends that may flip the connector.
    const sent = await new SlackApi(token).postMessage(String(chatId), NO_ACTIVE_POD_REPLY);
    await deliveryFailures.noteBoundChatDeliveryFailure(integration, chatId, sent);
  } catch (error) {
    console.warn('[slack-bridge] could not send no-active-pod reply:', (error as Error).message);
  }
};

// Same trust level as replyNoActivePod: a refusal that never reaches the chat
// leaves the user believing their message was relayed.
const replyRoutedPodRefused = async (
  integration: SlackIntegrationDoc,
  podLabel: string,
): Promise<void> => {
  const chatId = integration.config?.chatId;
  const botTokenRef = integration.config?.botTokenRef;
  if (!chatId || !botTokenRef) return;
  try {
    const token = await connectorSecrets.get(String(botTokenRef));
    const sent = await new SlackApi(token).postMessage(String(chatId), routedPodRefusal(podLabel));
    await deliveryFailures.noteBoundChatDeliveryFailure(integration, chatId, sent);
  } catch (error) {
    console.warn('[slack-bridge] could not send routed-pod refusal:', (error as Error).message);
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
    // TASK-160: the "why is this held" label reads the gate through the same
    // predicate the relay itself uses, so a change to gate semantics cannot
    // leave the reason a user is shown stale. The scope test stays because it
    // asks a different question than the gate read does: the label means "this
    // person's gate for that pod is off", not "this connector owns that pod",
    // which is what the predicate's pod-scoped arm answers.
    const cardHoldReason = opts.card
      ? (integration.config?.adminPause
        ? 'paused'
        : integration.scope === 'user' && !isGatedPodTarget(integration, podId)
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
      // One ternary, two escape regimes: the card renderer escapes every field it
      // is handed, this fall-through used to interpolate three of them raw. Slice
      // before escaping — the other order can cut a `&amp;` in half.
      : `[${escapeSlackMrkdwn(podName)}] ${escapeSlackMrkdwn(displayName || agentUsername)}: `
        + escapeSlackMrkdwn(String(content).slice(0, OUTBOUND_TEXT_CAP));
    const result = await new SlackApi(token).postMessage(String(integration.config!.chatId), text);
    if (!result.ok || !result.ts) {
      // Bound channel. Only an `ok: false` classifies — a missing `ts` on an
      // otherwise successful send says nothing about reachability.
      await deliveryFailures.noteBoundChatDeliveryFailure(integration, integration.config?.chatId, result);
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
//
// It also returns the pod the quoted line came from. The caller owns the
// decision — the map is data, and this function does no lookups — so a `podId`
// here means "the quoted entry names a pod", not "routing to it is allowed".
export const routeSlackReplyContent = (opts: {
  content: string;
  threadTs?: string | null;
  relayMap?: Array<{
    externalMessageId?: string;
    tgMessageId?: string;
    agentUsername?: string;
    podId?: string | null;
  }>;
}): { content: string; routedAgent: string | null; podId: string | null } => {
  const { content, threadTs, relayMap } = opts;
  if (!threadTs || !Array.isArray(relayMap)) return { content, routedAgent: null, podId: null };
  const hit = relayMap.find((entry) => String(entry.externalMessageId || entry.tgMessageId) === String(threadTs));
  if (!hit?.agentUsername) return { content, routedAgent: null, podId: null };
  const routedPodId = hit.podId ? String(hit.podId) : null;
  const mention = `@${hit.agentUsername}`;
  return content.toLowerCase().includes(mention.toLowerCase())
    ? { content, routedAgent: hit.agentUsername, podId: routedPodId }
    : { content: `${mention} ${content}`, routedAgent: hit.agentUsername, podId: routedPodId };
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
      if (!sent.ok) {
        console.warn('[slack-bridge] card confirmation was not sent');
        await deliveryFailures.noteBoundChatDeliveryFailure(integration, config.chatId, sent);
      }
    } catch (error) {
      console.warn('[slack-bridge] card confirmation failed:', (error as Error).message);
    }
  }
  if (cardReply.handled && !cardReply.lateReply) return { relayed: false };
  if (!cardReply.lateReply && !integration.podId) {
    await replyNoActivePod(integration);
    return { relayed: false };
  }
  const routed = routeSlackReplyContent({
    content: rawText,
    threadTs: event.thread_ts,
    relayMap: cardReply.lateReply ? [] : config.relayMap,
  });
  // ADR-025 D11: a thread reply answers the line it quotes, so it belongs in THAT
  // pod — not in whichever pod is this connector's active destination. The quoted
  // pod is re-derived here rather than trusted from the map: the map is written
  // at send time and an entry can outlive its gate, its pod, or the owner's
  // membership (100-entry cap, owner-editable gates). Any failure refuses in the
  // chat and posts nothing. Falling back to the active pod is the defect this
  // rule exists for — the user's answer to B would be authored into A and the
  // agent it names would wake there without B's thread.
  //
  // An entry with no `podId` is not this case: it was written before multi-pod
  // routing shipped, carries no pod to check, and routes as it always has.
  //
  // The predicate is `isRoutedPodTarget` (gate + membership, one home in
  // connectorRelayPolicy): the same rule the outbound relay and decision-card
  // delivery read, so a fix to the rule reaches all of them. Note what it does
  // NOT bound — the ACTIVE pod is exempt from the gate by design (see
  // isInboundRelayableIntegration above), so this check applies only to the
  // quoted pod, and only when it differs from the active one. The shared
  // predicate answers gate + membership; the bridge's own predicate adds the
  // protocol-health conditions only Slack knows (liveRelay, chatType, teamId).
  let podId = cardReply.lateReply?.podId || String(integration.podId);
  if (routed.podId && String(routed.podId) !== String(podId)) {
    const routedPod = await Pod.findById(routed.podId).select('name type createdBy members').lean();
    if (!isRoutedPodTarget({
      integration,
      pod: routedPod,
      podId: routed.podId,
      userId: config.linkedUserId,
    }) || !isRelayableIntegration(integration, routed.podId)) {
      console.warn(
        `[slack-bridge] thread reply refused — quoted pod ${routed.podId} is no longer routed to this chat`,
      );
      await replyRoutedPodRefused(
        integration,
        routedPod?.name ? String(routedPod.name) : `pod ${routed.podId}`,
      );
      return { relayed: false };
    }
    podId = String(routed.podId);
  }
  const { content: routedText, routedAgent } = routed;
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
