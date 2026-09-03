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
const telegramSend = require('./telegramService');

const RELAY_MAP_CAP = 100;
const OUTBOUND_TEXT_CAP = 900;

export interface RelayMapEntry {
  tgMessageId: string;
  agentUsername: string;
  podMessageId?: string | null;
}

interface TelegramIntegrationDoc {
  _id: unknown;
  podId: unknown;
  config?: {
    chatId?: string;
    chatType?: string;
    liveRelay?: boolean;
    linkedUserId?: string;
    leadAgentUsername?: string;
    relayMap?: RelayMapEntry[];
    relayAllAgentMessages?: boolean;
  };
}

const escapeHtml = (raw: string): string => String(raw)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// Rule-based escalation gate. Deliberately structural and cheap — the same
// shape as the cascade cap: no model call decides whether to interrupt a
// human. A message crosses to the channel when it:
//   - carries an explicit escalation/blocked/decision marker, or
//   - asks the human something (question addressed at a person), or
//   - comes from the designated lead agent (their reports are the digest), or
//   - the integration opts into relay-everything (demo/verbose mode).
const ESCALATION_MARKERS = /\[(BLOCKED|ESCALATE|DECISION|NEEDS[-_ ]?HUMAN|APPROVAL)\]/i;
const QUESTION_AT_HUMAN = /@[a-z0-9_.-]+[^\n]{0,200}\?/i;

export const shouldEscalate = (opts: {
  content: string;
  agentUsername: string;
  integration: TelegramIntegrationDoc;
}): boolean => {
  const { content, agentUsername, integration } = opts;
  const cfg = integration.config || {};
  if (cfg.relayAllAgentMessages) return true;
  if (cfg.leadAgentUsername
    && agentUsername.toLowerCase() === String(cfg.leadAgentUsername).toLowerCase()) {
    return true;
  }
  if (ESCALATION_MARKERS.test(content)) return true;
  if (QUESTION_AT_HUMAN.test(content)) return true;
  return false;
};

// Prefix an inbound Telegram quote-reply with the @mention of the agent whose
// relayed line was quoted, so the normal mention pipeline routes it. Pure —
// unit-tested without any I/O.
export const routeReplyContent = (opts: {
  content: string;
  replyToTgMessageId?: string | null;
  relayMap?: RelayMapEntry[];
}): { content: string; routedAgent: string | null } => {
  const { content, replyToTgMessageId, relayMap } = opts;
  if (!replyToTgMessageId || !Array.isArray(relayMap)) {
    return { content, routedAgent: null };
  }
  const hit = relayMap.find((e) => String(e.tgMessageId) === String(replyToTgMessageId));
  if (!hit || !hit.agentUsername) return { content, routedAgent: null };
  const mention = `@${hit.agentUsername}`;
  if (content.toLowerCase().includes(mention.toLowerCase())) {
    return { content, routedAgent: hit.agentUsername };
  }
  return { content: `${mention} ${content}`, routedAgent: hit.agentUsername };
};

const findLiveIntegration = async (podId: unknown): Promise<TelegramIntegrationDoc | null> => {
  if (!podId) return null;
  try {
    return await IntegrationModel.findOne({
      type: 'telegram',
      isActive: true,
      podId,
      'config.liveRelay': true,
      'config.chatId': { $exists: true, $ne: null },
      // Same gate as inbound: a code redeemed into a group must not stream the
      // pod's escalations to that group (connector-verify F2, 2026-08-26).
      'config.chatType': 'private',
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

// Outbound: agent message → Telegram, attributed, with a deep link back into
// the pod. Fire-and-forget from AgentMessageService.postMessage — a bridge
// failure must never fail the post itself.
export const relayAgentMessageToTelegram = async (opts: {
  podId: string;
  agentUsername: string;
  displayName: string;
  content: string;
  podMessageId?: string | null;
}): Promise<void> => {
  const {
    podId, agentUsername, displayName, content, podMessageId,
  } = opts;
  try {
    const integration = await findLiveIntegration(podId);
    if (!integration) return;
    // /mute pauses ALL outbound relay to the chat, escalations included —
    // mute means mute; /status shows it, and it self-expires.
    const mutedUntil = (integration.config as { relayMutedUntil?: Date | string })?.relayMutedUntil;
    if (mutedUntil && new Date(mutedUntil) > new Date()) return;
    if (!shouldEscalate({ content, agentUsername, integration })) return;

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = integration.config?.chatId;
    if (!botToken || !chatId) return;

    const base = (process.env.PUBLIC_APP_URL || 'https://commonly.me').replace(/\/$/, '');
    const link = `${base}/v2/pods/${podId}`;
    const body = escapeHtml(String(content).slice(0, OUTBOUND_TEXT_CAP));
    const text = `<b>${escapeHtml(displayName || agentUsername)}</b>: ${body}`
      + `\n\n<a href="${link}">open in Commonly</a>`;

    const result = await telegramSend.sendMessage(botToken, chatId, text);
    const tgMessageId = result && result.messageId != null ? String(result.messageId) : null;
    if (!tgMessageId) return;

    await IntegrationModel.findByIdAndUpdate(integration._id, {
      $push: {
        'config.relayMap': {
          $each: [{ tgMessageId, agentUsername, podMessageId: podMessageId || null }],
          $slice: -RELAY_MAP_CAP,
        },
      },
    });
  } catch (err) {
    console.warn('[tg-bridge] outbound relay failed:', (err as Error).message);
  }
};

// Inbound: Telegram message from a linked live-relay chat → pod message,
// attributed to the integration's linked user, delivered through the same
// seam both human routes use so mentions and wake behave identically.
export const relayTelegramMessageToPod = async (opts: {
  integration: TelegramIntegrationDoc;
  telegramMessage: {
    text?: string;
    caption?: string;
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

  const podId = String(integration.podId);
  const linkedUserId = integration.config?.linkedUserId;
  if (!linkedUserId) {
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
  if (chatType !== 'private') {
    console.warn(
      `[tg-bridge] inbound dropped — relay authors as the linked user and chatType=${chatType || 'unknown'} cannot guarantee the sender is them`,
    );
    return { relayed: false };
  }

  const replyToTgMessageId = telegramMessage.reply_to_message?.message_id
    ?? telegramMessage.reply_to_message_id
    ?? null;
  const { content: routedText, routedAgent } = routeReplyContent({
    content: rawText,
    replyToTgMessageId: replyToTgMessageId != null ? String(replyToTgMessageId) : null,
    relayMap: integration.config?.relayMap,
  });

  const senderName = [
    telegramMessage.from?.first_name,
    telegramMessage.from?.last_name,
  ].filter(Boolean).join(' ').trim();
  const content = senderName
    ? `📱 ${senderName} (via Telegram): ${routedText}`
    : `📱 (via Telegram): ${routedText}`;

  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const User = require('../models/User');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const Pod = require('../models/Pod');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const PGMessage = require('../models/pg/Message');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { deliverMessageToAgents } = require('./messageAgentDeliveryService');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const socketConfig = require('../config/socket');

  const [linkedUser, pod] = await Promise.all([
    User.findById(linkedUserId).select('username profilePicture').lean(),
    Pod.findById(podId).select('type').lean(),
  ]);
  if (!linkedUser || !pod) {
    console.warn('[tg-bridge] inbound dropped — linked user or pod missing');
    return { relayed: false };
  }

  // Same heal the human routes perform: Mongo-only pods have no PG row and
  // the insert would FK-fail.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const PGPod = require('../models/pg/Pod');
    const pgPodExists = await PGPod.findById(podId);
    if (!pgPodExists) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const { syncPodFromMongo } = require('./pgPodSyncService');
      await syncPodFromMongo(podId, String(linkedUserId));
    }
  } catch (syncErr) {
    console.warn('[tg-bridge] PG pod backfill skipped:', (syncErr as Error).message);
  }

  const created = await PGMessage.create(podId, String(linkedUserId), content, 'text', null, null, null);
  let message: Record<string, unknown> = created;
  try {
    const populated = created?.id ? await PGMessage.findById(created.id) : null;
    if (populated) message = populated;
  } catch (readErr) {
    console.warn('[tg-bridge] post-write read failed:', (readErr as Error).message);
  }

  // Past this point the pod row exists. A throw here would reach the webhook
  // route, return non-2xx, and Telegram would redeliver — re-running
  // PGMessage.create and duplicating both the message and every wake it
  // triggers, because nothing dedupes on telegramMessage.message_id. Swallow
  // instead: the record survives and a human can re-poke. Failures BEFORE the
  // write are left to propagate, where the same redelivery is the repair.
  try {
    await deliverMessageToAgents({
      podId,
      podType: pod.type,
      message,
      userId: String(linkedUserId),
      requestUser: { username: linkedUser.username },
      replyToMessageId: null,
    });
  } catch (deliverErr) {
    console.error('[tg-bridge] agent delivery failed after pod write:', (deliverErr as Error).message);
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
        userId: {
          _id: linkedUserId,
          username: linkedUser.username,
          profilePicture: linkedUser.profilePicture,
        },
        username: linkedUser.username,
        profile_picture: linkedUser.profilePicture,
        createdAt: (message as { created_at?: unknown }).created_at || new Date(),
        replyTo: null,
        thread_root_id: null,
        payload: null,
      });
    }
  } catch (socketErr) {
    console.warn('[tg-bridge] socket emit failed:', (socketErr as Error).message);
  }

  return { relayed: true, routedAgent };
};

module.exports = {
  shouldEscalate,
  routeReplyContent,
  relayAgentMessageToTelegram,
  relayTelegramMessageToPod,
};

export {};
