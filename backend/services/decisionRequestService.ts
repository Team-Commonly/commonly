import crypto from 'crypto';

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
const isPodMember = require('../utils/isPodMember');
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

export interface DecisionOptionInput {
  label: string;
  description?: string;
  recommended?: boolean;
}

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
}

interface ChooseDecisionOptions {
  decisionId: string;
  callerUserId: string;
  value: string;
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

const formatDecisionMessage = (
  title: string,
  question: string,
  options: DecisionOptionInput[],
  context?: string,
): string => {
  const optionsText = options.map((option) => {
    const recommendation = option.recommended ? ' (recommended)' : '';
    const description = option.description ? ` — ${option.description}` : '';
    return `- ${option.label}${recommendation}${description}`;
  }).join('\n');
  return [title, question, context, `Options:\n${optionsText}`].filter(Boolean).join('\n\n');
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
 * card has a reply target and human rulings always have a normal wake path.
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

  const posted = await AgentMessageService.postMessage({
    agentName,
    instanceId,
    displayName: input.displayName,
    podId,
    content: formatDecisionMessage(title, question, options, context),
    metadata: { source: 'decision-request' },
    threadRootId,
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
  });
  // eslint-disable-next-line global-require
  const { recordDecision } = require('./attentionItemService');
  await recordDecision(row);
  return {
    decisionId: String(row._id),
    messageId,
    threadRootId: threadRootId || messageId,
    status: row.status,
  };
};

const decisionPayload = (row: any): Record<string, unknown> => ({
  id: String(row._id),
  status: row.status,
  title: row.title,
  question: row.question,
  options: row.options,
  ruling: row.ruling ? {
    value: row.ruling.value,
    by: row.ruling.byUsername,
    at: row.ruling.at,
    messageId: row.ruling.messageId,
  } : null,
});

// The decision service bypasses messageController because it must make the
// decision-row CAS and the normal reply one operation. Preserve the ordinary
// human-message live contract here: without this broadcast, the ruling is
// durable and wakes the agent but other open thread views do not see it until
// their next fetch.
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

const postRulingReply = async (row: any, callerUserId: string, value: string): Promise<string> => {
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
  // ruling without reply_to_message_id is not an implicit reply and would not
  // wake the asking agent — failing is more honest than acknowledging it.
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

  const pod = await Pod.findById(String(row.podId)).select('type').lean();
  await deliverMessageToAgents({
    podId: String(row.podId),
    podType: pod?.type,
    message,
    userId: callerUserId,
    replyToMessageId: String(row.messageId),
  });
  broadcastRulingReply(String(row.podId), message);
  return String(message.id || message._id || created.id);
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
  const pod = await Pod.findById(String(row.podId)).select('members createdBy type').lean();
  if (!pod) return { status: 404, body: { error: 'Pod not found' } };
  if (!isPodMember(pod, callerUserId)) {
    return { status: 403, body: { error: 'Only human pod members can rule on this decision' } };
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

  let rulingMessageId: string;
  try {
    rulingMessageId = await postRulingReply(claimed, callerUserId, value);
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
          messageId: rulingMessageId,
        },
      },
      $unset: { rulingLock: 1 },
    },
    { new: true },
  );
  if (!ruled) {
    // The human reply is durable and will wake the agent. Do not manufacture
    // a second reply trying to recover a rare lock-expiry race.
    throw new DecisionRequestError(
      'Ruling posted but could not be finalized; refresh this decision',
      409,
      'ruling_finalize_conflict',
    );
  }
  // eslint-disable-next-line global-require
  const { resolve } = require('./attentionItemService');
  await resolve('decision_request', ruled._id);
  return { status: 200, body: { ok: true, decision: decisionPayload(ruled) } };
};

export default {
  requestDecision, chooseDecision, normalizeOptions, normalizeDecisionClass, DecisionRequestError,
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  requestDecision, chooseDecision, normalizeOptions, normalizeDecisionClass, DecisionRequestError,
};
