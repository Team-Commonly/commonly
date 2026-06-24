export const CONTEXT_CONTINUITY_PACKET_SCHEMA = 'commonly.ccp.v1';

export type ContinuityFreshnessStatus = 'valid' | 'stale' | 'unknown';

export interface ContextContinuityPacketV1 {
  schema: typeof CONTEXT_CONTINUITY_PACKET_SCHEMA;
  contextId: string;
  owner: {
    agentName: string;
    instanceId: string;
    podId?: string;
  };
  provenance: {
    source: 'cap.event';
    eventId?: string;
    eventType?: string;
    trigger?: string;
    createdAt?: string;
    deliveredAt?: string;
  };
  freshness?: {
    memoryRevision?: number;
    memoryRevisionAtDelivery?: number;
    lastSeenRevision?: number;
    status: ContinuityFreshnessStatus;
  };
  refs?: {
    messageId?: string;
    replyToMessageId?: string;
    threadId?: string;
    taskId?: string;
    requestId?: string;
    summaryId?: string;
    integrationId?: string;
    memorySections?: string[];
  };
}

interface EventLike {
  _id?: unknown;
  type?: string;
  podId?: unknown;
  agentName?: string;
  instanceId?: string;
  createdAt?: Date | string;
  deliveredAt?: Date | string;
  payload?: Record<string, unknown>;
  memoryRevisionAtDelivery?: number | null;
}

export interface BuildContextContinuityPacketArgs {
  event: EventLike;
  memoryRevision?: number;
  lastSeenRevision?: number;
  memoryRevisionAtDelivery?: number | null;
  memorySections?: string[];
}

const toStringValue = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === 'string'
    ? value
    : (value as { toString?: () => string })?.toString?.();
  const trimmed = String(s || '').trim();
  return trimmed || undefined;
};

const toIsoString = (value: unknown): string | undefined => {
  if (!value) return undefined;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return undefined;
};

const toNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
};

const pickPayloadRef = (
  payload: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined => {
  if (!payload) return undefined;
  for (const key of keys) {
    const value = toStringValue(payload[key]);
    if (value) return value;
  }
  return undefined;
};

export const memorySectionsFromDigestBundle = (
  digestBundle: Record<string, unknown> = {},
): string[] => {
  const sections: string[] = [];
  if (Array.isArray(digestBundle.memoryDigest) && digestBundle.memoryDigest.length > 0) {
    sections.push('system_exchanges');
  }
  if (Array.isArray(digestBundle.cyclesDigest) && digestBundle.cyclesDigest.length > 0) {
    sections.push('cycles');
  }
  if (typeof digestBundle.longTermDigest === 'string' && digestBundle.longTermDigest.trim()) {
    sections.push('long_term');
  }
  if (Array.isArray(digestBundle.recentDailyDigest) && digestBundle.recentDailyDigest.length > 0) {
    sections.push('daily');
  }
  return sections;
};

const buildFreshnessStatus = (
  memoryRevision: number | undefined,
  memoryRevisionAtDelivery: number | undefined,
): ContinuityFreshnessStatus => {
  if (memoryRevision === undefined || memoryRevisionAtDelivery === undefined) return 'unknown';
  return memoryRevisionAtDelivery >= memoryRevision ? 'valid' : 'stale';
};

export function buildContextContinuityPacket({
  event,
  memoryRevision,
  lastSeenRevision,
  memoryRevisionAtDelivery,
  memorySections = [],
}: BuildContextContinuityPacketArgs): ContextContinuityPacketV1 {
  const eventId = toStringValue(event?._id);
  const agentName = toStringValue(event?.agentName)?.toLowerCase() || 'unknown';
  const instanceId = toStringValue(event?.instanceId) || 'default';
  const podId = toStringValue(event?.podId);
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const capturedRevision = toNumber(memoryRevisionAtDelivery ?? event?.memoryRevisionAtDelivery);
  const currentRevision = toNumber(memoryRevision);
  const seenRevision = toNumber(lastSeenRevision);

  const refs: ContextContinuityPacketV1['refs'] = {};
  const messageId = pickPayloadRef(payload, ['messageId', 'message_id']);
  const replyToMessageId = pickPayloadRef(payload, ['replyToMessageId', 'replyToId', 'reply_to_message_id']);
  const threadId = pickPayloadRef(payload, ['threadId', 'thread_id']);
  const taskId = pickPayloadRef(payload, ['taskId', 'task_id']);
  const requestId = pickPayloadRef(payload, ['requestId', 'request_id']);
  const summaryId = pickPayloadRef(payload, ['summaryId', 'summary_id']);
  const integrationId = pickPayloadRef(payload, ['integrationId', 'integration_id']);

  if (messageId) refs.messageId = messageId;
  if (replyToMessageId) refs.replyToMessageId = replyToMessageId;
  if (threadId) refs.threadId = threadId;
  if (taskId) refs.taskId = taskId;
  if (requestId) refs.requestId = requestId;
  if (summaryId) refs.summaryId = summaryId;
  if (integrationId) refs.integrationId = integrationId;
  const uniqueMemorySections = Array.from(new Set((memorySections || []).filter(Boolean)));
  if (uniqueMemorySections.length > 0) refs.memorySections = uniqueMemorySections;

  const packet: ContextContinuityPacketV1 = {
    schema: CONTEXT_CONTINUITY_PACKET_SCHEMA,
    contextId: eventId
      ? `cap-event:${eventId}`
      : `cap-event:${agentName}:${instanceId}:${podId || 'no-pod'}`,
    owner: {
      agentName,
      instanceId,
      ...(podId ? { podId } : {}),
    },
    provenance: {
      source: 'cap.event',
      ...(eventId ? { eventId } : {}),
      ...(event?.type ? { eventType: event.type } : {}),
      ...(typeof payload.trigger === 'string' && payload.trigger.trim() ? { trigger: payload.trigger.trim() } : {}),
      ...(toIsoString(event?.createdAt) ? { createdAt: toIsoString(event?.createdAt) } : {}),
      ...(toIsoString(event?.deliveredAt) ? { deliveredAt: toIsoString(event?.deliveredAt) } : {}),
    },
  };

  if (
    currentRevision !== undefined
    || capturedRevision !== undefined
    || seenRevision !== undefined
  ) {
    packet.freshness = {
      ...(currentRevision !== undefined ? { memoryRevision: currentRevision } : {}),
      ...(capturedRevision !== undefined ? { memoryRevisionAtDelivery: capturedRevision } : {}),
      ...(seenRevision !== undefined ? { lastSeenRevision: seenRevision } : {}),
      status: buildFreshnessStatus(currentRevision, capturedRevision),
    };
  }

  if (Object.keys(refs).length > 0) {
    packet.refs = refs;
  }

  return packet;
}

export default {
  CONTEXT_CONTINUITY_PACKET_SCHEMA,
  buildContextContinuityPacket,
  memorySectionsFromDigestBundle,
};

// CJS compat: let require() consume the named helpers from TS-transpiled output.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports;
