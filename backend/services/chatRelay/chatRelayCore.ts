// Chat-relay core — the platform-neutral half of every chat connector bridge.
//
// Telegram and Slack grew as near-copies: the same hold/mute/escalate ladder
// before an outbound send, the same relayMap and verdict writes after it, the
// same /mode /status /mute /unmute state changes, and the same "write the
// inbound line into the pod as the linked user" tail. This module owns those
// once. What stays per platform is what only the platform knows, supplied as an
// adapter (ChatRelayAdapter) by its bridge service:
//   - how to find and health-check a live row (chat type, token shape);
//   - how to render and send, and what id the send returned;
//   - how a command is spelled and how its reply reads;
//   - how an inbound sender is proven to be the linked user.
//
// The last two are deliberately not abstracted here: reply text is
// byte-pinned per platform, and attribution proof is a security argument each
// bridge makes in its own terms (a private chat on Telegram, a matched DM user
// on Slack). The core takes the semantic outcome; the adapter writes the words.
//
// Adding a platform is one adapter in its bridge plus one entry in
// ./adapters.ts — the dispatcher's selector reads the registry's keys.

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const IntegrationModel = require('../../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const deliveryFailures = require('../connectorDeliveryFailureService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const relayPolicy = require('../connectorRelayPolicy');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const channelVerdictService = require('../channelVerdictService');
import { publicAppUrl } from '../../utils/publicAppUrl';
import type { DecisionRelayCard } from '../decisionCardRelay';

const RELAY_MAP_CAP = 100;

export interface ChatRelayIntegration {
  _id: unknown;
  installationId?: unknown;
  podId?: unknown;
  scope?: 'pod' | 'user';
  type?: string;
  config?: {
    chatId?: string;
    liveRelay?: boolean;
    relayAllAgentMessages?: boolean;
    relayMutedUntil?: Date | string;
    leadAgentUsername?: string;
    adminPause?: unknown;
    gates?: Record<string, { enabled?: boolean; mode?: 'attention' | 'mirror'; lead?: string }>;
  };
}

// ---------------------------------------------------------------------------
// Mode and mute — the two owner-set switches on a connector.
// ---------------------------------------------------------------------------

export type RelayMode = 'mirror' | 'attention';

// The two relay modes are one stored flag: mirror ⇔ config.relayAllAgentMessages.
// This is the connector-wide reading the commands report; the per-pod override
// in `config.gates[podId].mode` is connectorRelayPolicy.shouldEscalate's to read.
export const relayModeOf = (integration: ChatRelayIntegration): RelayMode => (
  integration.config?.relayAllAgentMessages === true ? 'mirror' : 'attention'
);

// /mute pauses ALL outbound relay to the chat, escalations and decision cards
// included — mute means mute; /status shows it, and it self-expires.
export const activeMuteUntil = (
  integration: ChatRelayIntegration,
  now: Date = new Date(),
): Date | null => {
  const mutedUntil = integration.config?.relayMutedUntil;
  if (!mutedUntil) return null;
  const until = new Date(mutedUntil);
  return until > now ? until : null;
};

export const isRelayMuted = (
  integration: ChatRelayIntegration,
  now: Date = new Date(),
): boolean => activeMuteUntil(integration, now) !== null;

// ---------------------------------------------------------------------------
// Commands — shared semantics, per-platform spelling and wording.
// ---------------------------------------------------------------------------

export type RelayCommand =
  | { name: 'mode'; arg?: string }
  | { name: 'status' }
  | { name: 'mute'; arg?: string }
  | { name: 'unmute' }
  | { name: 'help' };

export type RelayConfigUpdate =
  | { $set: Record<string, unknown> }
  | { $unset: Record<string, ''> };

export type RelayCommandOutcome =
  | { kind: 'not-linked' }
  | { kind: 'help' }
  | { kind: 'mode-show'; mode: RelayMode }
  | { kind: 'mode-usage' }
  | { kind: 'mode-set'; mode: RelayMode; update: RelayConfigUpdate }
  | {
    kind: 'status';
    mode: RelayMode;
    liveRelay: boolean;
    mutedUntil: Date | null;
    lead: string | null;
  }
  | { kind: 'mute'; minutes: number; until: Date; update: RelayConfigUpdate }
  | { kind: 'unmute'; update: RelayConfigUpdate };

const DEFAULT_MUTE_MINUTES = 60;
const MAX_MUTE_MINUTES = 24 * 60;

/**
 * Pure: what a command means for this connector, and the config write it
 * needs. The caller applies `update` with its own model call and renders the
 * outcome in its platform's words. `arg` is compared as given — a platform that
 * accepts `/mode Mirror` lowercases before calling, one that does not, doesn't.
 */
export const applyRelayCommand = (
  command: RelayCommand,
  integration: ChatRelayIntegration | null | undefined,
  now: Date = new Date(),
): RelayCommandOutcome => {
  if (command.name === 'help') return { kind: 'help' };
  if (!integration) return { kind: 'not-linked' };
  if (command.name === 'mode') {
    if (!command.arg) return { kind: 'mode-show', mode: relayModeOf(integration) };
    if (command.arg !== 'mirror' && command.arg !== 'attention') return { kind: 'mode-usage' };
    return {
      kind: 'mode-set',
      mode: command.arg,
      update: { $set: { 'config.relayAllAgentMessages': command.arg === 'mirror' } },
    };
  }
  if (command.name === 'mute') {
    const minutes = Math.min(
      Math.max(parseInt(command.arg || String(DEFAULT_MUTE_MINUTES), 10) || DEFAULT_MUTE_MINUTES, 1),
      MAX_MUTE_MINUTES,
    );
    const until = new Date(now.getTime() + minutes * 60_000);
    return { kind: 'mute', minutes, until, update: { $set: { 'config.relayMutedUntil': until } } };
  }
  if (command.name === 'unmute') {
    // Only the owner's mute. An admin pause is a separate key and stays put.
    return { kind: 'unmute', update: { $unset: { 'config.relayMutedUntil': '' } } };
  }
  const lead = integration.config?.leadAgentUsername;
  return {
    kind: 'status',
    mode: relayModeOf(integration),
    liveRelay: Boolean(integration.config?.liveRelay),
    mutedUntil: activeMuteUntil(integration, now),
    lead: lead ? String(lead) : null,
  };
};

// ---------------------------------------------------------------------------
// Outbound — one agent message to one bound connector.
// ---------------------------------------------------------------------------

export interface OutboundRelayOptions<I extends ChatRelayIntegration> {
  podId: string;
  agentUsername: string;
  displayName: string;
  content: string;
  podMessageId?: string | null;
  card?: DecisionRelayCard;
  integration?: I;
}

export interface OutboundSendResult {
  /** The bound chat the send targeted; the failure classifier only flips that one. */
  chatId: unknown;
  /** The platform's id for the sent line, or null when the send did not land. */
  externalMessageId: string | null;
  /** The provider's raw result, handed as-is to connectorDeliveryFailureService. */
  result: unknown;
}

export interface ChatRelayAdapter<I extends ChatRelayIntegration = ChatRelayIntegration> {
  /** Integration.type, ChannelVerdict.provider, and the `<provider>.relay` handler name. */
  provider: string;
  /** The relayMap / cards key the inbound reply router reads back. */
  relayMapKey: string;
  findLiveIntegration: (podId: string) => Promise<I | null>;
  isRelayableIntegration: (integration: I, podId: string) => boolean;
  /** Render and send. Return null to skip without a send (e.g. no bot token). */
  send: (opts: OutboundRelayOptions<I> & { integration: I; link: string }) => Promise<OutboundSendResult | null>;
  /** When set, a send that did not land also throws this after it is classified. */
  deliveryFailureError?: (result: unknown) => Error;
  logOutboundFailure: (error: Error, opts: OutboundRelayOptions<I>) => void;
}

// TASK-160: the "why is this held" label reads the gate through the same
// predicate the relay itself uses, so a change to gate semantics cannot leave
// the reason a user is shown stale. The scope test stays because it asks a
// different question than the gate read does: the label means "this person's
// gate for that pod is off", not "this connector owns that pod", which is what
// the predicate's pod-scoped arm answers.
export const cardHoldReasonFor = (
  integration: ChatRelayIntegration,
  podId: string,
): 'paused' | 'gate_off' | null => {
  if (integration.config?.adminPause) return 'paused';
  if (integration.scope === 'user' && !relayPolicy.isGatedPodTarget(integration, podId)) return 'gate_off';
  return null;
};

const recordCardVerdict = async (
  adapter: ChatRelayAdapter<any>,
  integration: ChatRelayIntegration,
  podId: string,
  podMessageId: string,
  verdict: 'hold' | 'interrupt',
  reason: string,
): Promise<void> => {
  await channelVerdictService.record({
    integrationId: integration._id,
    ...(integration.installationId ? { installationId: integration.installationId } : {}),
    podId,
    provider: adapter.provider,
    event: { kind: 'decision_request', podMessageId },
    verdict,
    reason,
  });
};

export const podLinkFor = (podId: string, podMessageId?: string | null, card?: DecisionRelayCard): string => {
  const base = publicAppUrl();
  return card && podMessageId
    ? `${base}/v2/pods/${encodeURIComponent(podId)}?message=${encodeURIComponent(podMessageId)}`
    : `${base}/v2/pods/${podId}`;
};

/**
 * Agent message → one external chat. Fire-and-forget from the dispatcher: a
 * bridge failure must never fail the post itself, so every error ends in the
 * adapter's log line and nothing is rethrown.
 *
 * The ladder, in order: a card withheld by pause or gate records `hold`; a row
 * that is not relayable sends nothing; a mute holds everything (cards record
 * why); ordinary chat must pass the escalation policy; then send, classify a
 * failed send against the bound chat, and remember the sent line so a
 * quote-reply can route back to its agent and pod.
 */
export const relayAgentMessageThroughAdapter = async <I extends ChatRelayIntegration>(
  adapter: ChatRelayAdapter<I>,
  opts: OutboundRelayOptions<I>,
): Promise<void> => {
  const {
    podId, agentUsername, content, podMessageId, card,
  } = opts;
  try {
    // The dispatcher selects each subscription. Its row is the authority for
    // this send; the fallback preserves legacy direct rows.
    const integration = opts.integration ?? await adapter.findLiveIntegration(podId);
    if (!integration) return;
    const holdReason = card ? cardHoldReasonFor(integration, podId) : null;
    if (holdReason) {
      if (podMessageId) await recordCardVerdict(adapter, integration, podId, podMessageId, 'hold', holdReason);
      return;
    }
    if (!adapter.isRelayableIntegration(integration, podId)) return;
    if (isRelayMuted(integration)) {
      if (card && podMessageId) await recordCardVerdict(adapter, integration, podId, podMessageId, 'hold', 'muted');
      return;
    }
    if (!card && !relayPolicy.shouldEscalate({
      content, agentUsername, integration, podId,
    })) return;

    const sent = await adapter.send({ ...opts, integration, link: podLinkFor(podId, podMessageId, card) });
    if (!sent) return;
    if (!sent.externalMessageId) {
      // Bound chat. Only a permanent, classified failure flips the connector; a
      // missing id on its own says nothing about reachability.
      await deliveryFailures.noteBoundChatDeliveryFailure(integration, sent.chatId, sent.result);
      if (adapter.deliveryFailureError) throw adapter.deliveryFailureError(sent.result);
      return;
    }

    const externalMessageId = sent.externalMessageId;
    await IntegrationModel.findByIdAndUpdate(integration._id, {
      $push: {
        'config.relayMap': {
          $each: [{
            [adapter.relayMapKey]: externalMessageId, agentUsername, podMessageId: podMessageId || null, podId,
          }],
          $slice: -RELAY_MAP_CAP,
        },
        ...(card && podMessageId ? {
          'config.cards': { podMessageId, [adapter.relayMapKey]: externalMessageId, sentAt: new Date() },
        } : {}),
      },
    });
    if (card && podMessageId) await recordCardVerdict(adapter, integration, podId, podMessageId, 'interrupt', 'card');
  } catch (error) {
    adapter.logOutboundFailure(error as Error, opts);
  }
};

// ---------------------------------------------------------------------------
// Inbound — write an external line into the pod as the linked user.
// ---------------------------------------------------------------------------

export interface InboundAuthor {
  pod: { type?: string; members?: unknown[] };
  linkedUser: { username?: string; profilePicture?: string };
}

/**
 * The membership half of inbound authorship: the linked user must still be a
 * listed member of the pod the line lands in. `onRefused` is the adapter's
 * in-chat notice. The other half — that the external sender IS the linked user
 * — each bridge proves before calling, in its platform's terms.
 */
export const loadInboundAuthor = async (opts: {
  podId: string;
  linkedUserId: string;
  logPrefix: string;
  onNotMember: () => Promise<void>;
}): Promise<InboundAuthor | null> => {
  const {
    podId, linkedUserId, logPrefix, onNotMember,
  } = opts;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const Pod = require('../../models/Pod');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const User = require('../../models/User');
  const pod = await Pod.findById(podId).select('type createdBy members').lean();
  if (!pod || !relayPolicy.isListedPodMember(pod, linkedUserId)) {
    console.warn(`${logPrefix} inbound dropped — linked user is no longer a pod member`);
    await onNotMember();
    return null;
  }
  const linkedUser = await User.findById(linkedUserId).select('username profilePicture').lean();
  if (!linkedUser) {
    console.warn(`${logPrefix} inbound dropped — linked user missing`);
    return null;
  }
  return { pod, linkedUser };
};

/**
 * Persist and fan out one inbound line, through the same seam both human routes
 * use so mentions and wake behave identically.
 *
 * Failures BEFORE the PG write propagate: the platform's redelivery is the
 * repair, and nothing exists yet to duplicate. Failures AFTER it are swallowed:
 * a throw would reach the webhook, return non-2xx, and the platform would
 * redeliver — re-running the write and duplicating the message and every wake
 * it triggers, because nothing dedupes on the platform's message id.
 */
export const writeInboundAsLinkedUser = async (opts: {
  podId: string;
  podType?: string;
  linkedUserId: string;
  linkedUser: { username?: string; profilePicture?: string };
  content: string;
  replyToMessageId: string | null;
  lateReplyThreadRootId?: number | string | null;
  logPrefix: string;
}): Promise<void> => {
  const {
    podId, podType, linkedUserId, linkedUser, content, replyToMessageId, lateReplyThreadRootId, logPrefix,
  } = opts;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const PGMessage = require('../../models/pg/Message');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { deliverMessageToAgents } = require('../messageAgentDeliveryService');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const socketConfig = require('../../config/socket');

  // Same heal the human routes perform: Mongo-only pods have no PG row and
  // the insert would FK-fail.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const PGPod = require('../../models/pg/Pod');
    if (!await PGPod.findById(podId)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const { syncPodFromMongo } = require('../pgPodSyncService');
      await syncPodFromMongo(podId, linkedUserId);
    }
  } catch (syncErr) {
    console.warn(`${logPrefix} PG pod backfill skipped:`, (syncErr as Error).message);
  }

  let threadRootId: number | null = null;
  if (lateReplyThreadRootId) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { resolveThreadRoot } = require('../threadRootResolver');
    threadRootId = await resolveThreadRoot({ podId, replyToMessageId, threadRootId: lateReplyThreadRootId });
  }
  const created = await PGMessage.create(podId, linkedUserId, content, 'text', replyToMessageId, null, threadRootId);
  let message: Record<string, unknown> = created;
  try {
    const populated = created?.id ? await PGMessage.findById(created.id) : null;
    if (populated) message = populated;
  } catch (readErr) {
    console.warn(`${logPrefix} post-write read failed:`, (readErr as Error).message);
  }

  try {
    await deliverMessageToAgents({
      podId,
      podType,
      message,
      userId: linkedUserId,
      requestUser: { username: linkedUser.username },
      replyToMessageId,
    });
  } catch (deliverErr) {
    console.error(`${logPrefix} agent delivery failed after pod write:`, (deliverErr as Error).message);
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
  } catch (socketErr) {
    console.warn(`${logPrefix} socket emit failed:`, (socketErr as Error).message);
  }
};
