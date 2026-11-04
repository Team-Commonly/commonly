// Telegram live bridge — the channel-as-attention-surface relay.
//
// Design (2026-08-26): the pod is the workspace, the messaging channel is the
// human's attention surface. Only two things cross the bridge outward:
//   1. escalations — an agent is blocked, asks the human a question, or a
//      message passes the escalation rules below;
//   2. attributed reports from the designated lead agent.
// Everything else stays in the pod. Inbound, a Telegram message from a linked
// chat lands in the pod as a real message (attributed to the linked user) and
// rides the normal mention pipeline; a Telegram *quote-reply* to a relayed
// agent line is routed back to that specific agent as an @mention.
//
// Scope guard: the bridge only fires for Integration rows with
// `config.liveRelay === true`. Every other telegram integration keeps the
// legacy buffer/summary behaviour untouched.
//
// The escalation policy is rule-based today (see shouldEscalate). The LLM
// judge — an agent in the pod deciding what deserves the channel — is the
// designed next step; these rules are its floor, not its replacement.

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const IntegrationModel = require('../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const telegramSend = require('./telegramService');
const deliveryFailures = require('./connectorDeliveryFailureService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const {
  shouldEscalate, isGatedPodTarget, isRoutedPodTarget,
} = require('./connectorRelayPolicy');
import type { DecisionRelayCard } from './decisionCardRelay';
import { resolveDecisionCardReply } from './decisionCardReply';
import type { ChannelCardEntry } from './decisionCardReply';
import {
  loadInboundAuthor,
  relayAgentMessageThroughAdapter,
  writeInboundAsLinkedUser,
} from './chatRelay/chatRelayCore';
import type { ChatRelayAdapter, OutboundRelayOptions } from './chatRelay/chatRelayCore';
const OUTBOUND_TEXT_CAP = 900;
const CARD_OUTBOUND_TEXT_CAP = 1_900;

export interface RelayMapEntry {
  tgMessageId: string;
  agentUsername: string;
  podMessageId?: string | null;
  // ADR-025 D11: which pod's line this was. Absent on entries written before
  // multi-pod routing shipped, and absent is not "the active pod" — it is
  // "unknown", and unknown routes as it always has (see relayTelegramMessageToPod).
  podId?: string | null;
}

interface TelegramIntegrationDoc {
  _id: unknown;
  installationId?: unknown;
  podId: unknown;
  scope?: 'pod' | 'user';
  type?: string;
  isActive?: boolean;
  status?: 'connected' | 'disconnected' | 'error' | 'pending';
  config?: {
    chatId?: string;
    chatType?: string;
    liveRelay?: boolean;
    linkedUserId?: string;
    leadAgentUsername?: string;
    relayMap?: RelayMapEntry[];
    cards?: ChannelCardEntry[];
    relayAllAgentMessages?: boolean;
    gates?: Record<string, { enabled?: boolean }>;
    adminPause?: { reason?: string; at?: Date | string; adminId?: string };
  };
}

// This escape moved into telegramService, beside the `parse_mode: 'HTML'` it
// exists for, and is imported back: one Telegram escape for the whole backend
// rather than a copy per module (wren 73790).
const { escapeHtml } = telegramSend;

export { shouldEscalate };

const truncateWithEllipsis = (value: string, limit: number): string => {
  if (value.length <= limit) return value;
  if (limit <= 1) return '…'.slice(0, limit);
  return `${value.slice(0, limit - 1)}…`;
};

/**
 * Decision cards have their own cap: ordinary relay messages remain bounded
 * at 900 characters. Keep the title, question, and option labels intact; if
 * a valid maximum-size card needs space, descriptions yield first.
 */
export const renderTelegramDecisionCard = (opts: {
  card: DecisionRelayCard;
  displayName: string;
  agentUsername: string;
  link: string;
}): string => {
  const { card, displayName, agentUsername, link } = opts;
  const title = escapeHtml(card.title);
  const question = escapeHtml(card.question);
  const agent = escapeHtml(displayName || agentUsername);
  const footer = '\n\nReply to this message with a number, or write your ruling.\n'
    + `<a href="${link}">open in Commonly</a>`;
  const optionLines = card.options.map((option, index) => (
    `\n${index + 1}. <b>${escapeHtml(option.label)}</b>${option.recommended ? ' ★ recommended' : ''}`
  ));
  const header = `<b>${agent} needs a ruling · ${title}</b>\n${question}\n`;
  let remaining = CARD_OUTBOUND_TEXT_CAP - header.length - footer.length
    - optionLines.reduce((sum, line) => sum + line.length, 0);
  const descriptions = card.options.map((option) => (
    option.description ? escapeHtml(truncateWithEllipsis(option.description, 100)) : ''
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

// Prefix an inbound Telegram quote-reply with the @mention of the agent whose
// relayed line was quoted, so the normal mention pipeline routes it. Pure —
// unit-tested without any I/O.
//
// It also returns the pod the quoted line came from (ADR-025 D11). The caller
// owns the decision — the map is data, and this function does no lookups — so a
// `podId` here means "the quoted entry names a pod", not "routing to it is
// allowed".
export const routeReplyContent = (opts: {
  content: string;
  replyToTgMessageId?: string | null;
  relayMap?: RelayMapEntry[];
}): { content: string; routedAgent: string | null; podId: string | null } => {
  const { content, replyToTgMessageId, relayMap } = opts;
  if (!replyToTgMessageId || !Array.isArray(relayMap)) {
    return { content, routedAgent: null, podId: null };
  }
  const hit = relayMap.find((e) => String(e.tgMessageId) === String(replyToTgMessageId));
  if (!hit || !hit.agentUsername) return { content, routedAgent: null, podId: null };
  const routedPodId = hit.podId ? String(hit.podId) : null;
  const mention = `@${hit.agentUsername}`;
  if (content.toLowerCase().includes(mention.toLowerCase())) {
    return { content, routedAgent: hit.agentUsername, podId: routedPodId };
  }
  return { content: `${mention} ${content}`, routedAgent: hit.agentUsername, podId: routedPodId };
};

const findLiveIntegration = async (podId: unknown): Promise<TelegramIntegrationDoc | null> => {
  if (!podId) return null;
  try {
    return await IntegrationModel.findOne({
      type: 'telegram',
      isActive: true,
      status: { $ne: 'error' },
      podId,
      'config.liveRelay': true,
      'config.chatId': { $exists: true, $ne: null },
      // Same gate as inbound: a code redeemed into a group must not stream the
      // pod's escalations to that group (connector-verify F2, 2026-08-26).
      'config.chatType': 'private',
      'config.adminPause': { $exists: false },
    }).lean();
  } catch (error) {
    // Fail CLOSED (no relay) but never silently: `null` is also what a pod with
    // no live bridge returns, which is the overwhelmingly common case, so an
    // unlogged swallow made a Mongo failure indistinguishable from the modal
    // success value. Callers are fire-and-forget, so rethrowing here would only
    // land on a floating promise — the log is the whole remedy.
    console.error('[telegram-bridge] findLiveIntegration failed, treating pod as unbridged:', (error as Error).message);
    return null;
  }
};

const isRelayableIntegration = (
  integration: TelegramIntegrationDoc,
  podId: string,
): boolean => (
  isGatedPodTarget(integration, podId)
  && (integration.type === undefined || integration.type === 'telegram')
  && integration.isActive !== false
  && integration.status !== 'error'
  && integration.config?.liveRelay === true
  && integration.config?.chatType === 'private'
  && !integration.config?.adminPause
  && Boolean(integration.config?.chatId)
);

// Gates select outbound subscriptions. A connector has one active inbound
// destination, held by podId; do not let a disabled or pruned outbound gate
// silently disconnect the owner's messages from that active pod.
const isInboundRelayableIntegration = (
  integration: TelegramIntegrationDoc,
  podId: string,
): boolean => (
  String(integration.podId) === String(podId)
  && (integration.type === undefined || integration.type === 'telegram')
  && integration.isActive !== false
  && integration.config?.liveRelay === true
  && integration.config?.chatType === 'private'
  && !integration.config?.adminPause
  && Boolean(integration.config?.chatId)
);

const NO_ACTIVE_POD_REPLY = 'This connector has no active pod. Choose one in Commonly first.';

// ADR-025 D11: a quote-reply whose pod is no longer reachable is refused in the
// chat and posted nowhere. Naming the pod is the whole point — "your reply did
// not go through" is unactionable, while "that line came from Launch" tells the
// user which pod the fix is in. The label is escaped because this send is
// `parse_mode: 'HTML'` and a pod name is agent-choosable.
const routedPodRefusal = (podLabel: string): string => (
  `⚠️ That line came from “${escapeHtml(podLabel)}”, which this chat no longer reaches. `
  + 'Nothing was posted — open Commonly to reply there.'
);

const replyNoActivePod = async (integration: TelegramIntegrationDoc): Promise<void> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = integration.config?.chatId;
  if (!botToken || !chatId) return;
  try {
    // Bound chat, so this is one of the four sends that may flip the connector.
    const sent = await telegramSend.sendMessage(botToken, chatId, NO_ACTIVE_POD_REPLY);
    await deliveryFailures.noteBoundChatDeliveryFailure(integration, chatId, sent);
  } catch (error) {
    console.warn('[tg-bridge] could not send no-active-pod reply:', (error as Error).message);
  }
};

// Same trust level as replyNoActivePod: a refusal that never reaches the chat
// leaves the user believing their message was relayed.
const replyRoutedPodRefused = async (
  integration: TelegramIntegrationDoc,
  podLabel: string,
): Promise<void> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = integration.config?.chatId;
  if (!botToken || !chatId) return;
  try {
    const sent = await telegramSend.sendMessage(botToken, chatId, routedPodRefusal(podLabel));
    await deliveryFailures.noteBoundChatDeliveryFailure(integration, chatId, sent);
  } catch (error) {
    console.warn('[tg-bridge] could not send routed-pod refusal:', (error as Error).message);
  }
};

// The pod tag is cosmetic (ADR-025 D10): it tells a reader which pod a line came
// from once more than one pod reaches this chat. Slack has carried it since its
// bridge shipped; Telegram did not, which is half of what D10 names. A lookup
// failure must not cost the relay, so it degrades to the id rather than to a
// name that was never read — never to silence.
const podNameForTag = async (podId: string): Promise<string> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const Pod = require('../models/Pod');
    const pod = await Pod.findById(podId).select('name').lean();
    return String(pod?.name || podId);
  } catch (error) {
    console.warn('[tg-bridge] pod name lookup failed, tagging with the id:', (error as Error).message);
    return podId;
  }
};

// Outbound: agent message → Telegram, attributed, with a deep link back into
// the pod. The hold/mute/escalate ladder and the relayMap write are the shared
// core's (chatRelay/chatRelayCore); this adapter owns what only Telegram knows:
// its row shape, its HTML rendering, and the send.
export const telegramRelayAdapter: ChatRelayAdapter<TelegramIntegrationDoc> = {
  provider: 'telegram',
  relayMapKey: 'tgMessageId',
  findLiveIntegration,
  isRelayableIntegration,
  send: async ({
    integration, podId, agentUsername, displayName, content, card, link,
  }) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = integration.config?.chatId;
    if (!botToken || !chatId) return null;
    const body = escapeHtml(String(content).slice(0, OUTBOUND_TEXT_CAP));
    const text = card
      ? renderTelegramDecisionCard({ card, displayName, agentUsername, link })
      : `[${escapeHtml(await podNameForTag(podId))}] <b>${escapeHtml(displayName || agentUsername)}</b>: ${body}`
        + `\n\n<a href="${link}">open in Commonly</a>`;
    const result = await telegramSend.sendMessage(botToken, chatId, text);
    // A missing id used to return with no trace at all, so a blocked bot left
    // the connector looking healthy while replies vanished (row D). The core
    // now classifies it against the bound chat.
    const tgMessageId = result && result.messageId != null ? String(result.messageId) : null;
    return { chatId, externalMessageId: tgMessageId, result };
  },
  logOutboundFailure: (err) => {
    console.warn('[tg-bridge] outbound relay failed:', err.message);
  },
};

// Fire-and-forget from AgentMessageService.postMessage — a bridge failure must
// never fail the post itself.
export const relayAgentMessageToTelegram = async (
  opts: OutboundRelayOptions<TelegramIntegrationDoc>,
): Promise<void> => relayAgentMessageThroughAdapter(telegramRelayAdapter, opts);

// Inbound: Telegram message from a linked live-relay chat → pod message,
// attributed to the integration's linked user, delivered through the same
// seam both human routes use so mentions and wake behave identically.
export const relayTelegramMessageToPod = async (opts: {
  integration: TelegramIntegrationDoc;
  telegramMessage: {
    text?: string;
    caption?: string;
    chat?: { type?: string };
    message_id?: number;
    from?: { first_name?: string; last_name?: string };
    reply_to_message_id?: number;
    reply_to_message?: { message_id?: number };
  };
}): Promise<{ relayed: boolean; routedAgent?: string | null }> => {
  const { integration, telegramMessage } = opts;
  const rawText = (telegramMessage.text || telegramMessage.caption || '').trim();
  if (!rawText) return { relayed: false };
  if (rawText.startsWith('/')) return { relayed: false }; // commands keep legacy handling
  if (!integration.podId && !integration.config?.cards?.length) {
    // `podId` is optional for user-scoped rows, but inbound has one active
    // destination. Never stringify null into a query or author into a pod the
    // connector cannot name.
    console.warn('[tg-bridge] inbound dropped — connector has no active pod');
    await replyNoActivePod(integration);
    return { relayed: false };
  }

  let podId = String(integration.podId);
  const linkedUserId = integration.config?.linkedUserId;
  if (!linkedUserId || !isInboundRelayableIntegration(integration, podId)) {
    console.warn('[tg-bridge] live relay without linkedUserId — inbound dropped');
    return { relayed: false };
  }

  // The gate proves the Telegram sender IS the chat's counterpart. It does NOT
  // prove the counterpart is `linkedUserId` — that half is held one layer out,
  // by the guard in `routes/integrations.ts` (PATCH /:id), which derives
  // `config.linkedUserId` from the authenticated caller when `liveRelay` flips
  // on and rejects any client-supplied value. Relax that guard and this gate
  // still passes while authoring under an identity the caller chose. No test
  // joins the two: both bridge suites hand-build `config`, so a mutation to the
  // route guard turns nothing here red.
  //
  // Attribution gate. Every relayed message is authored as `linkedUserId`, so
  // relaying is only honest where Telegram itself guarantees the sender IS that
  // person: a `private` chat is 1:1 between the bot and one user. In a group,
  // supergroup or channel, any member's message would land in the pod under the
  // linked user's name — and nothing downstream carries `from.id` to contradict
  // it, not the pod row, not the socket payload, not the agent wake. The
  // display prefix built below is cosmetic; the authorship is not.
  //
  // Fails closed on an unknown chatType, and no existing row needs migrating.
  // `handleEnableCommand` (routes/webhooks/telegram.ts) is the only writer of
  // `config.chatId` in the tree, and it `$set`s `config.chatType` in the SAME
  // update — both keys were introduced by one commit (72c9a1e6, 2026-01-27),
  // so no document has ever carried a chatId without a chatType. Since
  // `findLiveIntegration` requires `config.chatId` to exist, every integration
  // the bridge can reach already answers this question.
  //
  // The guard is still not decorative: that writer stores `chat?.type || null`,
  // so a Telegram update omitting `chat.type` yields an explicit null, and null
  // is not "private". The invariant is also held by nothing but the co-location
  // of those two keys in one `$set` — split them and legacy-shaped rows become
  // reachable again.
  //
  // Widening this needs a real Telegram-sender → Commonly-user mapping, not a
  // longer list of accepted chat types.
  const chatType = integration.config?.chatType;
  if (chatType !== 'private' || (telegramMessage.chat && telegramMessage.chat.type !== 'private')) {
    console.warn(
      `[tg-bridge] inbound dropped — relay authors as the linked user and chatType=${chatType || 'unknown'} `
        + 'cannot guarantee the sender is them',
    );
    return { relayed: false };
  }

  const replyToTgMessageId = telegramMessage.reply_to_message?.message_id
    ?? telegramMessage.reply_to_message_id
    ?? null;
  const cardReply = await resolveDecisionCardReply({
    integrationId: integration._id,
    linkedUserId: String(linkedUserId),
    cards: integration.config?.cards,
    provider: 'telegram',
    text: rawText,
    replyToExternalId: replyToTgMessageId != null ? String(replyToTgMessageId) : undefined,
  });
  if (cardReply.confirmation) {
    try {
      const sent = await telegramSend.sendMessage(
        process.env.TELEGRAM_BOT_TOKEN, integration.config?.chatId, cardReply.confirmation,
        { replyToMessageId: cardReply.externalMessageId, plainText: true },
      );
      if (!sent?.success) {
        console.warn('[tg-bridge] card confirmation was not sent');
        await deliveryFailures.noteBoundChatDeliveryFailure(integration, integration.config?.chatId, sent);
      }
    } catch (error) {
      console.warn('[tg-bridge] card confirmation failed:', (error as Error).message);
    }
  }
  if (cardReply.handled && !cardReply.lateReply) return { relayed: false };
  if (!cardReply.lateReply && !integration.podId) {
    await replyNoActivePod(integration);
    return { relayed: false };
  }
  if (cardReply.lateReply) podId = cardReply.lateReply.podId;
  const replyToMessageId = cardReply.lateReply?.messageId || null;
  const routed = routeReplyContent({
    content: rawText,
    replyToTgMessageId: replyToTgMessageId != null ? String(replyToTgMessageId) : null,
    relayMap: cardReply.lateReply ? [] : integration.config?.relayMap,
  });
  // ADR-025 D11: a quote-reply answers the line it quotes, so it belongs in THAT
  // pod — not in whichever pod is this connector's active destination. The quoted
  // pod is re-derived here rather than trusted from the map: the map is written
  // at send time and an entry can outlive its gate, its pod, or the owner's
  // membership (100-entry cap, owner-editable gates). Any failure refuses in the
  // chat and posts nothing. Falling back to the active pod is the defect this
  // rule exists for — the user's answer to B would be authored into A and the
  // agent it names would wake there without B's thread.
  //
  // An entry with no `podId` is not this case. It was written before multi-pod
  // routing shipped, carries no pod to check, and routes as it always has.
  //
  // The predicate is `isRoutedPodTarget` (gate + membership, one home in
  // connectorRelayPolicy): the same rule the outbound relay and decision-card
  // delivery read, so a fix to the rule reaches all of them. Note what it does
  // NOT bound — the ACTIVE pod is exempt from the gate by design (see
  // isInboundRelayableIntegration above), so this check applies only to the
  // quoted pod, and only when it differs from the active one. The shared
  // predicate answers gate + membership; the bridge's own predicate adds the
  // protocol-health conditions only Telegram knows (liveRelay, chatType, chatId).
  if (routed.podId && String(routed.podId) !== String(podId)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const PodModel = require('../models/Pod');
    const routedPod = await PodModel.findById(routed.podId).select('name type createdBy members').lean();
    if (!isRoutedPodTarget({
      integration,
      pod: routedPod,
      podId: routed.podId,
      userId: linkedUserId,
    }) || !isRelayableIntegration(integration, routed.podId)) {
      console.warn(
        `[tg-bridge] quote-reply refused — quoted pod ${routed.podId} is no longer routed to this chat`,
      );
      await replyRoutedPodRefused(integration, routedPod?.name ? String(routedPod.name) : `pod ${routed.podId}`);
      return { relayed: false };
    }
    podId = String(routed.podId);
  }
  const { content: routedText, routedAgent } = routed;

  const senderName = [
    telegramMessage.from?.first_name,
    telegramMessage.from?.last_name,
  ].filter(Boolean).join(' ').trim();
  const content = senderName
    ? `📱 ${senderName} (via Telegram): ${routedText}`
    : `📱 (via Telegram): ${routedText}`;

  const author = await loadInboundAuthor({
    podId,
    linkedUserId: String(linkedUserId),
    logPrefix: '[tg-bridge]',
    onNotMember: () => replyNoActivePod(integration),
  });
  if (!author) return { relayed: false };

  // Past the PG write, failures are swallowed by the core: nothing dedupes on
  // telegramMessage.message_id, so a non-2xx here would make Telegram redeliver
  // and duplicate both the message and every wake it triggers.
  await writeInboundAsLinkedUser({
    podId,
    podType: author.pod.type,
    linkedUserId: String(linkedUserId),
    linkedUser: author.linkedUser,
    content,
    replyToMessageId,
    lateReplyThreadRootId: cardReply.lateReply?.threadRootId,
    logPrefix: '[tg-bridge]',
  });

  return { relayed: true, routedAgent };
};

module.exports = {
  shouldEscalate,
  routeReplyContent,
  isRelayableIntegration,
  isInboundRelayableIntegration,
  renderTelegramDecisionCard,
  relayAgentMessageToTelegram,
  relayTelegramMessageToPod,
  telegramRelayAdapter,
};

export {};
