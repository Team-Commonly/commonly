import crypto from 'crypto';
import type { DecisionCardOption, DecisionRelayCard } from './decisionCardRelay';
import { escapeRegExp } from '../utils/escape';

// eslint-disable-next-line global-require
const DecisionRequest = require('../models/DecisionRequest');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const AgentMessageService = require('./agentMessageService');
// eslint-disable-next-line global-require
const PGMessage = require('../models/pg/Message');
// eslint-disable-next-line global-require
const PGPod = require('../models/pg/Pod');
// eslint-disable-next-line global-require
const { syncPodFromMongo } = require('./pgPodSyncService');
// eslint-disable-next-line global-require
const { deliverMessageToAgents } = require('./messageAgentDeliveryService');
// eslint-disable-next-line global-require
const AgentEventService = require('./agentEventService');
// eslint-disable-next-line global-require
const { isListedPodMember } = require('../utils/isPodMember');
// eslint-disable-next-line global-require
const socketConfig = require('../config/socket');

const RULE_LOCK_MS = 2 * 60 * 1000;

export class DecisionRequestError extends Error {
  status: number;

  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type DecisionOptionInput = DecisionCardOption;

export type DecisionClass = 'strategy' | 'implementation' | 'prioritization';
const ADVISORY_DECISION_CLASSES: readonly DecisionClass[] = [
  'strategy', 'implementation', 'prioritization',
];

interface RequestDecisionOptions {
  podId: string;
  agentUserId: string;
  agentName: string;
  instanceId?: string;
  decisionClass: DecisionClass;
  displayName?: string;
  installationConfig?: Record<string, unknown> | null;
  title: string;
  question: string;
  options: DecisionOptionInput[];
  threadRootId?: string | null;
  context?: string;
  /** 1 to MAX_DECIDERS human members of the pod; only they may rule. */
  deciderUserIds?: unknown;
}

interface ChooseDecisionOptions {
  decisionId: string;
  callerUserId: string;
  value: string;
  /** Internal provenance; HTTP callers are forced to workspace below. */
  origin?: DecisionOrigin;
}

export interface DecisionOrigin {
  via: 'telegram' | 'slack' | 'workspace';
  integrationId?: unknown;
}

const cleanText = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string') {
    throw new DecisionRequestError(`${field} must be a string`, 400, `invalid_${field}`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new DecisionRequestError(`${field} is required`, 400, `${field}_required`);
  if (trimmed.length > max) {
    throw new DecisionRequestError(`${field} must be at most ${max} characters`, 400, `invalid_${field}`);
  }
  return trimmed;
};

export const normalizeDecisionClass = (value: unknown): DecisionClass => {
  const decisionClass = cleanText(value, 'decisionClass', 40).toLowerCase() as DecisionClass;
  if (!ADVISORY_DECISION_CLASSES.includes(decisionClass)) {
    throw new DecisionRequestError(
      'decisionClass must be strategy, implementation, or prioritization',
      400,
      'invalid_decision_class',
    );
  }
  return decisionClass;
};

export const normalizeOptions = (value: unknown): DecisionOptionInput[] => {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    throw new DecisionRequestError('options must contain 2 to 4 choices', 400, 'invalid_options');
  }
  let recommendedCount = 0;
  const labels = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new DecisionRequestError(`options[${index}] must be an object`, 400, 'invalid_options');
    }
    const option = raw as Record<string, unknown>;
    const label = cleanText(option.label, `options[${index}].label`, 80);
    const labelKey = label.toLocaleLowerCase();
    if (labels.has(labelKey)) {
      throw new DecisionRequestError('option labels must be unique', 400, 'duplicate_options');
    }
    labels.add(labelKey);
    if (option.recommended !== undefined && typeof option.recommended !== 'boolean') {
      throw new DecisionRequestError(`options[${index}].recommended must be a boolean`, 400, 'invalid_options');
    }
    if (option.recommended === true) recommendedCount += 1;
    if (recommendedCount > 1) {
      throw new DecisionRequestError('only one option may be recommended', 400, 'multiple_recommended');
    }
    let description: string | undefined;
    if (option.description !== undefined) {
      description = cleanText(option.description, `options[${index}].description`, 280);
    }
    return {
      label,
      ...(description ? { description } : {}),
      ...(option.recommended === true ? { recommended: true } : {}),
    };
  });
};

const MAX_DECIDERS = 5;

type Decider = { userId: string; username: string };

/**
 * The people an asker named to rule: 1 to MAX_DECIDERS distinct human members
 * of the pod, by user id. An agent that knows a username resolves it first.
 */
const resolveDeciders = async (podId: string, raw: unknown): Promise<Decider[] | null> => {
  if (raw === undefined || raw === null) return null;
  const malformed = () => new DecisionRequestError(
    `deciderUserIds must be 1 to ${MAX_DECIDERS} user ids`, 400, 'invalid_deciderUserIds',
  );
  // The limit counts distinct people, so a repeated id is one decider. The raw
  // list still has a ceiling, so a request can't carry an unbounded array.
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_DECIDERS * 4
    || raw.some((id) => typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id))) {
    throw malformed();
  }
  const ids = Array.from(new Set(raw.map((id) => String(id).toLowerCase())));
  if (ids.length > MAX_DECIDERS) throw malformed();
  const pod = await Pod.findById(podId).select('members').lean();
  if (!pod) throw new DecisionRequestError('Pod not found', 404, 'pod_not_found');
  const users = await User.find({ _id: { $in: ids } }).select('_id username isBot').lean() as Array<{
    _id: unknown; username?: string; isBot?: boolean;
  }>;
  const byId = new Map(users.map((user) => [String(user._id).toLowerCase(), user]));
  const refused = ids.filter((id) => {
    const user = byId.get(id);
    return !user || user.isBot || !user.username || !isListedPodMember(pod, id);
  });
  if (refused.length) {
    throw new DecisionRequestError(
      'Every decider must be a person in this pod', 400, 'decider_not_member',
    );
  }
  return ids.map((id) => ({ userId: id, username: String(byId.get(id)?.username) }));
};

const formatDecisionMessage = (
  title: string,
  question: string,
  options: DecisionOptionInput[],
  context?: string,
  deciders?: Decider[] | null,
): string => {
  const optionsText = options.map((option) => {
    const recommendation = option.recommended ? ' (recommended)' : '';
    const description = option.description ? ` — ${option.description}` : '';
    return `- ${option.label}${recommendation}${description}`;
  }).join('\n');
  // F593: the decision-fork cue tells an agent to include the person's real
  // @handle, so a question often already names its decider. Leave those out
  // of the For line rather than print the handle twice.
  const named = (username: string): boolean => new RegExp(
    // A trailing period counts as the end of a sentence unless a word follows it
    // (so 'sam@lily.com' and '@lily-bot' still don't name lily).
    `(^|[^\\w@.-])@${escapeRegExp(username)}(?![\\w-]|\\.\\w)`, 'i',
  ).test(question);
  const unnamed = (deciders || []).filter((decider) => !named(decider.username));
  const forLine = unnamed.length ? `For ${unnamed.map((decider) => `@${decider.username}`).join(', ')}` : '';
  return [title, forLine, question, context, `Options:\n${optionsText}`].filter(Boolean).join('\n\n');
};

const requirePgReply = async (podId: string, userId: string): Promise<void> => {
  const pgPod = await PGPod.findById(podId);
  if (!pgPod) {
    const synced = await syncPodFromMongo(podId, userId);
    if (!synced) throw new DecisionRequestError('Pod not found', 404, 'pod_not_found');
  }
};

/**
 * Store a fork and post the asker's own question into the pod. The source
 * message is created before the row becomes visible in the queue, so every
 * card has a reply target and a later ruling has a durable return path.
 */
export const requestDecision = async (input: RequestDecisionOptions): Promise<Record<string, unknown>> => {
  const podId = cleanText(input.podId, 'podId', 128);
  const agentUserId = cleanText(input.agentUserId, 'agentUserId', 128);
  const agentName = cleanText(input.agentName, 'agentName', 120).toLowerCase();
  const instanceId = String(input.instanceId || 'default').trim().toLowerCase() || 'default';
  const decisionClass = normalizeDecisionClass(input.decisionClass);
  const title = cleanText(input.title, 'title', 160);
  const question = cleanText(input.question, 'question', 1000);
  const options = normalizeOptions(input.options);
  const context = input.context === undefined ? undefined : cleanText(input.context, 'context', 2000);
  const threadRootId = input.threadRootId === undefined || input.threadRootId === null
    ? null
    : cleanText(input.threadRootId, 'threadRootId', 32);

  const deciders = await resolveDeciders(podId, input.deciderUserIds);

  // Thread replies require PostgreSQL. Check before posting the source: a
  // Mongo-only source could never receive the implicit reply that wakes the
  // asker, which would make the card appear to work while dropping its answer.
  try {
    await requirePgReply(podId, agentUserId);
  } catch (error) {
    if (error instanceof DecisionRequestError) throw error;
    throw new DecisionRequestError(
      'Decision requests need the message service to be available',
      503,
      'message_service_unavailable',
    );
  }

  // This envelope is server-composed from the request that passed validation.
  // It is dispatch-only: content remains the unchanged, canonical workspace
  // message, and bridges never need to infer an interrupt from prose.
  const relayCard: DecisionRelayCard = {
    title,
    question,
    options,
    ...(context ? { context } : {}),
    ...(deciders ? { deciders } : {}),
  };

  const posted = await AgentMessageService.postMessage({
    agentName,
    instanceId,
    displayName: input.displayName,
    podId,
    content: formatDecisionMessage(title, question, options, context, deciders),
    metadata: { source: 'decision-request' },
    relayCard,
    threadRootId,
    threadIsDeliberate: true,
    installationConfig: input.installationConfig || null,
  });
  if (!posted?.success || !posted?.message) {
    throw new DecisionRequestError('Decision request could not be posted', 503, 'message_not_posted');
  }
  const messageId = String(posted.message._id || posted.message.id || '');
  if (!/^\d+$/.test(messageId)) {
    throw new DecisionRequestError('Decision request needs a threaded message store', 503, 'message_not_threadable');
  }

  const row = await DecisionRequest.create({
    podId,
    agentUserId,
    agentName,
    instanceId,
    decisionClass,
    title,
    question,
    ...(context ? { context } : {}),
    options,
    status: 'pending',
    messageId,
    ...(threadRootId ? { threadRootId } : {}),
    ...(deciders ? { deciders } : {}),
  });
  // eslint-disable-next-line global-require
  const { recordDecision } = require('./attentionItemService');
  await recordDecision(row);
  return {
    decisionId: String(row._id),
    messageId,
    threadRootId: threadRootId || messageId,
    status: row.status,
    ...(deciders ? { deciders } : {}),
  };
};

const decisionPayload = (row: any): Record<string, unknown> => ({
  id: String(row._id),
  status: row.status,
  title: row.title,
  question: row.question,
  options: row.options,
  ...(row.deciders?.length ? {
    deciders: row.deciders.map((decider: any) => ({ userId: String(decider.userId), username: decider.username })),
  } : {}),
  ruling: row.ruling ? {
    value: row.ruling.value,
    by: row.ruling.byUsername,
    at: row.ruling.at,
    messageId: row.ruling.messageId,
  } : null,
});

// The ruled wake names what was asked, so an agent whose session was recycled,
// or that raised several cards, knows what the pick answers (F588). The caps
// are the model's own field limits (title 160, question 1000, 2–4 options of
// 80 chars); they are applied again here so an older or hand-written row can't
// bloat the event.
const RULED_TITLE_MAX = 160;
const RULED_QUESTION_MAX = 1000;
const RULED_OPTIONS_MAX = 4;
const RULED_OPTION_LABEL_MAX = 80;

const boundText = (value: unknown, max: number): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= max) return text;
  // Cut in UTF-16 units, but never keep half of a surrogate pair (an emoji).
  const cut = text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${cut}…`;
};

const ruledDecisionContext = (decision: any, pick: string): Record<string, unknown> => {
  const labels: string[] = (Array.isArray(decision?.options) ? decision.options : [])
    .map((option: any) => (typeof option?.label === 'string' ? option.label.trim() : ''))
    .filter(Boolean);
  const pickKey = pick.trim().toLocaleLowerCase();
  const threadRootId = decision?.threadRootId || decision?.messageId;
  return {
    title: boundText(decision?.title, RULED_TITLE_MAX),
    question: boundText(decision?.question, RULED_QUESTION_MAX),
    options: labels.slice(0, RULED_OPTIONS_MAX).map((label) => boundText(label, RULED_OPTION_LABEL_MAX)),
    // A ruling is free text (up to 2000 chars), not an option index: a person
    // can answer in their own words. Say which, against the full labels.
    pickIsOption: labels.some((label) => label.toLocaleLowerCase() === pickKey),
    ...(threadRootId ? { threadRootId: String(threadRootId) } : {}),
  };
};

const enqueueRuledDecisionEvent = async (decision: any): Promise<void> => {
  const ruling = decision?.ruling;
  if (!ruling?.value || !ruling?.byUserId || !ruling?.at || !ruling?.messageId) {
    throw new Error('Ruled decision is missing its delivery payload');
  }

  await AgentEventService.enqueue({
    agentName: String(decision.agentName),
    instanceId: String(decision.instanceId || 'default'),
    podId: String(decision.podId),
    type: 'decision.ruled',
    payload: {
      decisionId: String(decision._id),
      pick: String(ruling.value),
      ruledBy: {
        userId: String(ruling.byUserId),
        username: String(ruling.byUsername || 'Human'),
      },
      ruledAt: new Date(ruling.at).toISOString(),
      rulingMessageId: String(ruling.messageId),
      podId: String(decision.podId),
      ...ruledDecisionContext(decision, String(ruling.value)),
    },
  });
};

// The decision service bypasses messageController because it must make the
// decision-row CAS and the normal reply one operation. Preserve the ordinary
// human-message live contract here: without this broadcast, the ruling is
// durable but other open thread views do not see it until their next fetch.
const broadcastRulingReply = (podId: string, message: any): void => {
  try {
    const io = socketConfig.getIO();
    if (!io) return;
    const messageId = String(message._id || message.id || '');
    io.to(`pod_${podId}`).emit('newMessage', {
      _id: messageId,
      id: messageId,
      pod_id: podId,
      podId,
      content: message.content,
      messageType: message.messageType || 'text',
      userId: message.userId,
      username: message.username,
      profile_picture: message.profile_picture,
      createdAt: message.createdAt,
      replyTo: message.replyTo ?? null,
      thread_root_id: message.thread_root_id ?? null,
      reply_to_message_id: message.reply_to_message_id ?? null,
    });
  } catch (error) {
    // The ruling and the wake have already committed. Socket fan-out is a
    // best-effort projection, never a reason to retry and duplicate a reply.
    console.warn('[decision-request] ruling socket emit failed:', (error as Error).message);
  }
};

const postRulingReply = async (
  row: any,
  callerUserId: string,
  value: string,
): Promise<{ messageId: string; message: any }> => {
  await requirePgReply(String(row.podId), callerUserId);
  let resolvedThreadRootId: number | null = null;
  if (row.threadRootId) {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { resolveThreadRoot } = require('./threadRootResolver');
    resolvedThreadRootId = await resolveThreadRoot({
      podId: String(row.podId),
      replyToMessageId: String(row.messageId),
      threadRootId: String(row.threadRootId),
    });
  }

  // We intentionally require PG here rather than falling back to Mongo. A
  // ruling without reply_to_message_id cannot be tied back to the card —
  // failing is more honest than acknowledging it.
  const created = await PGMessage.create(
    String(row.podId),
    callerUserId,
    value,
    'text',
    String(row.messageId),
    null,
    resolvedThreadRootId,
  );
  const message = created?.id ? await PGMessage.findById(String(created.id)) : null;
  if (!message) throw new Error('Ruling reply could not be read after write');

  broadcastRulingReply(String(row.podId), message);
  return { messageId: String(message.id || message._id || created.id), message };
};

/**
 * First human member to claim the row posts the ruling. The short lock covers
 * the durable chat write, and is cleared on failure so a transient PG outage
 * cannot strand an undecided card.
 */
export const chooseDecision = async (
  input: ChooseDecisionOptions,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const decisionId = cleanText(input.decisionId, 'decisionId', 128);
  const callerUserId = cleanText(input.callerUserId, 'callerUserId', 128);
  const value = cleanText(input.value, 'value', 2000);

  const row = await DecisionRequest.findById(decisionId);
  if (!row) return { status: 404, body: { error: 'Decision request not found' } };
  if (row.status === 'ruled') {
    return { status: 409, body: { error: 'Decision already ruled', decision: decisionPayload(row) } };
  }

  const caller = await User.findById(callerUserId).select('username isBot').lean();
  if (!caller || caller.isBot) return { status: 403, body: { error: 'Only a human can rule on this decision' } };
  const pod = await Pod.findById(String(row.podId)).select('members type').lean();
  if (!pod) return { status: 404, body: { error: 'Pod not found' } };
  if (!isListedPodMember(pod, callerUserId)) {
    return { status: 403, body: { error: 'Only human pod members can rule on this decision' } };
  }
  // A card that names its deciders is theirs to rule; anyone else can read it.
  // Once none of them is still in the pod, any human member may rule, so the
  // card can't be stranded.
  const presentDeciders = (row.deciders || [])
    .filter((decider: any) => isListedPodMember(pod, String(decider.userId)));
  if (presentDeciders.length
    && !presentDeciders.some((decider: any) => String(decider.userId) === String(callerUserId))) {
    return {
      status: 403,
      body: { error: 'This decision is for someone else to rule', code: 'not_a_decider', decision: decisionPayload(row) },
    };
  }

  const now = new Date();
  const lockToken = crypto.randomUUID();
  const claimed = await DecisionRequest.findOneAndUpdate(
    {
      _id: row._id,
      status: 'pending',
      $or: [
        { rulingLock: { $exists: false } },
        { 'rulingLock.expiresAt': { $lt: now } },
      ],
    },
    { $set: { rulingLock: { token: lockToken, expiresAt: new Date(now.getTime() + RULE_LOCK_MS) } } },
    { new: true },
  );
  if (!claimed) {
    const current = await DecisionRequest.findById(decisionId);
    if (current?.status === 'ruled') {
      return { status: 409, body: { error: 'Decision already ruled', decision: decisionPayload(current) } };
    }
    return { status: 409, body: { error: 'Decision is being ruled; retry shortly' } };
  }

  let rulingReply: { messageId: string; message: any };
  try {
    rulingReply = await postRulingReply(claimed, callerUserId, value);
  } catch {
    await DecisionRequest.updateOne(
      { _id: claimed._id, status: 'pending', 'rulingLock.token': lockToken },
      { $unset: { rulingLock: 1 } },
    );
    throw new DecisionRequestError('Ruling could not be posted; the decision remains open', 503, 'ruling_not_posted');
  }

  const ruledAt = new Date();
  const ruled = await DecisionRequest.findOneAndUpdate(
    { _id: claimed._id, status: 'pending', 'rulingLock.token': lockToken },
    {
      $set: {
        status: 'ruled',
        ruling: {
          value,
          byUserId: callerUserId,
          byUsername: caller.username || 'Human',
          at: ruledAt,
          messageId: rulingReply.messageId,
        },
      },
      $unset: { rulingLock: 1 },
    },
    { new: true },
  );
  if (!ruled) {
    // The human reply is durable, but there is no final decision row to turn
    // into a typed event. Preserve the ordinary reply-edge wake instead of
    // leaving the asking agent unable to see a visible human response.
    try {
      await deliverMessageToAgents({
        podId: String(claimed.podId),
        podType: pod?.type,
        message: rulingReply.message,
        userId: callerUserId,
        replyToMessageId: String(claimed.messageId),
      });
    } catch (error) {
      console.warn('[decision-request] finalize-conflict reply delivery failed:', (error as Error).message);
    }
    // Do not manufacture a second reply trying to recover a rare lock-expiry
    // race.
    throw new DecisionRequestError(
      'Ruling posted but could not be finalized; refresh this decision',
      409,
      'ruling_finalize_conflict',
    );
  }
  // The row is settled. Fan-out is one best-effort projection immediately
  // after that confirmation, before attention/event delivery can fail. A
  // channel-originated ruling excludes its own integration because the
  // bridge sends the shorter "✓ Ruled" confirmation after this verb returns.
  const origin: DecisionOrigin = input.origin || { via: 'workspace' };
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { fanoutDecisionClosure } = require('./decisionCardReconcileService');
    await fanoutDecisionClosure(ruled, origin);
  } catch (error) {
    // This is deliberately a projection failure. The ruling and typed return
    // remain durable, and the five-minute sweep repairs receipts.
    console.warn('[decision-request] card closure fan-out failed:', (error as Error).message);
  }
  // eslint-disable-next-line global-require
  const { resolve } = require('./attentionItemService');
  await resolve('decision_request', ruled._id);
  try {
    await enqueueRuledDecisionEvent(ruled);
  } catch (error) {
    // Keep the pre-TASK-130 chat.mention delivery as a failure-only fallback.
    // The typed event is the normal return contract; the fallback prevents a
    // transient queue outage from turning a durable human ruling into an
    // invisible one. It is deliberately not emitted on success, so a normal
    // ruling never costs the asking agent two turns.
    console.warn(
      '[decision-request] typed ruling delivery failed; using implicit-reply fallback:',
      (error as Error).message,
    );
    await deliverMessageToAgents({
      podId: String(ruled.podId),
      podType: pod?.type,
      message: rulingReply.message,
      userId: callerUserId,
      replyToMessageId: String(ruled.messageId),
    });
    return { status: 200, body: { ok: true, decision: decisionPayload(ruled) } };
  }
  // The typed event is the asking agent's one return turn. Still run the
  // normal message-delivery seam so explicit mentions in the human ruling
  // and opt-in wake behavior retain their usual meaning; suppress only the
  // generic implicit reply edge and its ambient duplicate. This projection is
  // best effort: its failure must not cause a second generic event after the
  // typed return event is already durable.
  try {
    await deliverMessageToAgents({
      podId: String(ruled.podId),
      podType: pod?.type,
      message: rulingReply.message,
      userId: callerUserId,
      replyToMessageId: String(ruled.messageId),
      suppressImplicitReply: true,
      suppressImplicitReplyTarget: {
        agentName: String(ruled.agentName),
        instanceId: String(ruled.instanceId || 'default'),
      },
    });
  } catch (error) {
    console.warn('[decision-request] supplementary ruling delivery failed:', (error as Error).message);
  }
  return { status: 200, body: { ok: true, decision: decisionPayload(ruled) } };
};

/**
 * The decision behind an agent card's acting Buttons: opened on the first
 * click, keyed to the card's message, and ruled through chooseDecision so the
 * person's choice reaches the agent as the same `decision.ruled` turn a
 * decision card sends. It is never queued as an attention item: the card in
 * the thread is the ask.
 */
const CARD_DECISION_TITLE_MAX = 160;
const CARD_DECISION_QUESTION_MAX = 1000;

const loadActingCard = async (
  messageId: string,
  callerUserId: string,
): Promise<{ status: number; body: Record<string, unknown> } | {
  message: any; pod: any; choices: Array<{ label: string; value: string }>;
}> => {
  if (!/^\d{1,18}$/.test(messageId)) return { status: 404, body: { error: 'Card not found' } };
  const message = await PGMessage.findById(messageId);
  if (!message) return { status: 404, body: { error: 'Card not found' } };
  // Who may choose is settled before anything about the message is revealed.
  const caller = await User.findById(callerUserId).select('username isBot').lean();
  if (!caller || caller.isBot) return { status: 403, body: { error: 'Only a person can choose on this card' } };
  const pod = await Pod.findById(String(message.pod_id)).select('members type').lean();
  if (!pod || !isListedPodMember(pod, callerUserId)) {
    return { status: 403, body: { error: 'Only pod members can choose on this card' } };
  }
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { cardChoices } = require('./uiCardValidation');
  const choices = message.message_type === 'card' && message.payload?.kind === 'ui'
    ? cardChoices(message.payload, message.content) as Array<{ label: string; value: string }> : [];
  if (!choices.length) return { status: 404, body: { error: 'Card has no choices' } };
  return { message, pod, choices };
};

/** Whether a card's choice is made, and what it was. */
export const cardChoiceState = async (
  input: { messageId: unknown; callerUserId: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const loaded = await loadActingCard(String(input.messageId || ''), String(input.callerUserId || ''));
  if ('status' in loaded) return loaded;
  const row = await DecisionRequest.findOne({ messageId: String(loaded.message.id) })
    .sort({ createdAt: 1, _id: 1 }).lean();
  return { status: 200, body: { decision: row?.status === 'ruled' ? decisionPayload(row) : null } };
};

export const chooseCardButton = async (
  input: { messageId: unknown; callerUserId: unknown; value: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const messageId = String(input.messageId || '');
  const callerUserId = String(input.callerUserId || '');
  const loaded = await loadActingCard(messageId, callerUserId);
  if ('status' in loaded) return loaded;
  const { message, choices } = loaded;
  // Only a value the stored card offers: the browser sends it, the card decides it.
  const value = typeof input.value === 'string' ? input.value : '';
  if (!choices.some((choice) => choice.value === value)) {
    return { status: 400, body: { error: 'Not one of this card\'s choices', code: 'not_a_card_choice' } };
  }
  const agent = await User.findById(String(message.user_id)).select('isBot botMetadata').lean();
  const agentName = String(agent?.botMetadata?.agentName || '').toLowerCase();
  if (!agent?.isBot || !agentName) return { status: 404, body: { error: 'Card has no agent to answer' } };

  const content = String(message.content || '').trim();
  const firstLine = content.split('\n')[0] || 'Card';
  // Two first clicks can both reach here. Each upserts on the message, then all
  // rule the oldest row, whose compare-and-set lets exactly one of them win.
  await DecisionRequest.findOneAndUpdate(
    { messageId: String(message.id) },
    {
      $setOnInsert: {
        podId: String(message.pod_id),
        agentUserId: String(message.user_id),
        agentName,
        instanceId: String(agent.botMetadata?.instanceId || 'default').toLowerCase(),
        decisionClass: 'implementation',
        title: firstLine.slice(0, CARD_DECISION_TITLE_MAX),
        question: content.slice(0, CARD_DECISION_QUESTION_MAX),
        options: choices.map((choice) => ({ label: choice.value })),
        status: 'pending',
        messageId: String(message.id),
        ...(message.thread_root_id ? { threadRootId: String(message.thread_root_id) } : {}),
      },
    },
    { upsert: true, new: true },
  );
  const row = await DecisionRequest.findOne({ messageId: String(message.id) }).sort({ createdAt: 1, _id: 1 }).lean();
  return chooseDecision({
    decisionId: String(row._id), callerUserId, value, origin: { via: 'workspace' },
  });
};

export default {
  requestDecision, chooseDecision, chooseCardButton, cardChoiceState, normalizeOptions, normalizeDecisionClass, DecisionRequestError,
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  requestDecision, chooseDecision, chooseCardButton, cardChoiceState, normalizeOptions, normalizeDecisionClass, DecisionRequestError,
};
