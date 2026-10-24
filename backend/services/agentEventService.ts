import crypto from 'crypto';
import { Types } from 'mongoose';
import Task from '../models/Task';
import { foldExpiredDigests, readFoldedDigest, settleFoldedDigest } from './agentDigestFoldService';
import { postToPublicAddress } from './outboundUrlGuard';
import { hostedRunsNative, IN_PROCESS_RUNTIME_FILTER } from './hostedEngine';

// eslint-disable-next-line global-require
const AgentEvent = require('../models/AgentEvent');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const Gateway = require('../models/Gateway');
// eslint-disable-next-line global-require
const AgentIdentityService = require('./agentIdentityService');
// eslint-disable-next-line global-require
const {
  getAgentSessionSizes,
  clearAgentRuntimeSessions,
  restartAgentRuntime,
  resolveOpenClawAccountId,
} = require('./agentProvisionerService');
// eslint-disable-next-line global-require
const AgentMemory = require('../models/AgentMemory');
// eslint-disable-next-line global-require
const {
  buildMemoryDigestBundle,
} = require('./agentMemoryService');

// At the 10–30 minute heartbeat cadence, cycles' 40-entry retention window
// represents roughly 7–20 hours of normal activity. A day-old cursor is not
// a useful delta boundary: it would turn a recovered agent's next heartbeat
// into an accidental count of historical board churn.
const TASK_UPDATE_CUE_MAX_CURSOR_AGE_MS = 24 * 60 * 60 * 1000;

// ADR-026 D6. Every CLAIM mints one — the list() claim and the
// native-runtime create, which is born 'delivered'. The value comes from one
// function rather than two literals that have to agree forever; the design
// doc listed three writers of `status: 'delivered'`, and reading the third
// (markPosted) closely corrected that: it annotates the delivery already in
// flight rather than starting a new one, so minting there would invalidate
// the nonce held by the very child that just posted.
//
// Opaque and unguessable on purpose: a client that never received a delivery
// cannot fabricate its nonce, which also closes a smaller hole the race work
// exposed — `acknowledge` authorizes on the token's agentName/instanceId, so
// before this any holder of an agent's token could ack ANY of that agent's
// events by id, delivered to it or not.
const mintDeliveryNonce = (): string => crypto.randomBytes(16).toString('hex');

const OBJECT_ID_HEX = /^[a-f\d]{24}$/i;

// A wake advertises unread conversations, not message text. The seat can
// choose which threads to pull with commonly_get_messages after it wakes.
const digestConversationFrame = (
  rows: Array<{ payload?: Record<string, unknown> }>,
  olderCount = 0,
): string => {
  const counts = new Map<string, number>();
  if (olderCount > 0) counts.set('older pod activity', olderCount);
  const seen = new Set<string>();
  for (const row of rows) {
    const payload = row.payload || {};
    const sourceId = payload.messageId != null ? `message:${payload.messageId}`
      : (typeof payload.taskId === 'string'
        ? `task:${payload.taskId}:${String(payload.taskKind || '')}:${String(payload.content || '')}` : null);
    if (sourceId && seen.has(sourceId)) continue;
    if (sourceId) seen.add(sourceId);
    const thread = payload.threadRootId;
    const task = payload.taskId;
    const label = typeof thread === 'number' && Number.isInteger(thread) && thread > 0
      ? `thread ${thread}`
      : (typeof task === 'string' && /^TASK-\d+$/.test(task) ? task : 'pod conversation');
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const lines = [...counts].slice(0, 8).map(([label, count]) => `- ${label}: ${count} unread`);
  const omitted = Math.max(0, counts.size - 8);
  if (omitted) lines.push(`- ${omitted} more conversations omitted`);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return `[Since you last looked: ${total} ambient update${total === 1 ? '' : 's'} in ${counts.size} conversation${counts.size === 1 ? '' : 's'}; context only, no reply needed.]\n`
    + `${lines.join('\n')}\nPull relevant messages with commonly_get_messages. On resume, read oldest unread first; at most 8 conversations, 5 messages each, 20 messages total.`;
};

// TASK-264: how many stuck in-process events one sweep re-runs, and how long a
// 'queued'/'running' AgentRun may sit before it counts as abandoned.
const STUCK_REDISPATCH_BATCH = 50;
const ABANDONED_RUN_MINUTES = 30;

// TASK-265 (Rhea on #2236): an in-process event is born 'delivered', so one
// left 'pending' for an agent that now runs in-process was routed before the
// agent moved in-process (the hosted migration: enqueue decides routing before
// the insert) and nothing polls it. The sweep runs those once they are a
// minute old, so it never races an enqueue, and closes ones older than half
// an hour as 'failed' with a reason: a reply that late is no longer an answer,
// and a closed event says so where a pending one says nothing.
const STRANDED_PENDING_MIN_AGE_MS = 60 * 1000;
const STRANDED_PENDING_MAX_AGE_MS = 30 * 60 * 1000;

// The migration on acknowledge() runs in two phases, and BOTH are in this
// build so the compatibility mode has an end rather than an intention.
//
// Phase A (default): a presented nonce must match; an absent one is accepted
// and counted. Phase B: an absent nonce is refused.
//
// **Phase B flips PER CONSUMER, not globally** (Sam, 2026-08-30). The first
// draft gated the flip on `withoutNonce` reaching zero across everything,
// which hands a veto to whichever consumer is slowest — and one of them, the
// openclaw extension, has been parked since 2026-08-20. A parked runtime
// cannot be the long pole on a live kernel change, so enforcement is keyed on
// HOW THE ACK ARRIVED:
//
//   AGENT_EVENT_REQUIRE_DELIVERY_NONCE=ws,cli,hosted   → those three enforce
//   AGENT_EVENT_REQUIRE_DELIVERY_NONCE=true  (or `*`)  → everything enforces
//   unset                                              → Phase A everywhere
//
// A consumer key that is not listed stays on Phase A indefinitely, which is
// the point: migrated paths get the guarantee now, unmigrated ones keep
// working, and neither waits on the other.
//
// Read the counter precisely (review on #1347): it counts ack CALLS, not
// distinct deliveries — a retry against a vanished event still increments —
// and it is per-process and resets on restart. With multiple replicas, "zero
// for this consumer" means zero on EVERY replica since its last restart.
const ackNonceStats: {
  withNonce: number;
  withoutNonce: number;
  withoutNonceByConsumer: Record<string, number>;
} = { withNonce: 0, withoutNonce: 0, withoutNonceByConsumer: {} };

const enforcedAckConsumers = (): Set<string> => new Set(
  String(process.env.AGENT_EVENT_REQUIRE_DELIVERY_NONCE || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
);

// No consumer argument = "is it required for everyone?" — which is what the
// service-internal check asks, since acknowledge() cannot see the transport.
// The per-consumer refusal happens at the ack sites, where the key is known.
const requireDeliveryNonce = (consumer?: string): boolean => {
  const enforced = enforcedAckConsumers();
  if (enforced.has('true') || enforced.has('*')) return true;
  return consumer ? enforced.has(consumer.toLowerCase()) : false;
};

interface EventDoc {
  _id?: unknown;
  type?: string;
  podId?: unknown;
  agentName?: string;
  instanceId?: string;
  createdAt?: Date;
  payload?: Record<string, unknown>;
  status?: string;
  deliveryMode?: 'wake' | 'digest';
  attempts?: number;
  delivery?: DeliveryMeta;
  memoryRevisionAtDelivery?: number | null;
  deliveryNonce?: string | null;
  digestRollupRevision?: number | null;
  digestEventIds?: unknown[];
}

interface InstallationDoc {
  _id?: unknown;
  agentName?: string;
  instanceId?: string;
  podId?: unknown;
  status?: string;
  scopes?: string[];
  config?: Record<string, unknown> | Map<string, unknown>;
}

interface GatewayDoc {
  _id?: unknown;
  status?: string;
  baseUrl?: string;
}

interface DeliveryMeta {
  outcome?: string;
  reason?: string;
  messageId?: string;
  details?: Record<string, unknown>;
  updatedAt?: Date;
}

interface GarbageCollectOptions {
  deliveredRetentionHours?: number;
  failedRetentionHours?: number;
  requeueDeliveredMinutes?: number;
  requeueMaxAttempts?: number;
}

interface GarbageCollectResult {
  deletedPending: number;
  deletedDelivered: number;
  deletedFailed: number;
  totalDeleted: number;
  foldedDigest?: number;
  deliveredRetentionHours: number;
  failedRetentionHours: number;
  requeuedDelivered?: number;
  requeueDeliveredMinutes?: number;
  // Events that hit the requeue cap and were retired to the terminal 'failed'
  // state. Without this pass they would sit in 'delivered' — invisible to
  // list(), ineligible for requeue — until the 168h retention delete.
  expiredDelivered?: number;
  // TASK-264: in-process events whose turn died with the process, re-run
  // (or acked, when the run had finished and only the ack was lost), and
  // AgentRuns left 'queued'/'running' by a dead turn, marked 'interrupted'.
  redispatchedInProcess?: number;
  ackedInProcess?: number;
  interruptedRuns?: number;
  // TASK-265: pending events of agents that now run in-process, run once, or
  // closed with a reason once past the ceiling.
  rescuedPendingInProcess?: number;
  closedPendingInProcess?: number;
}

interface SessionSizeEntry {
  accountId: string;
  bytes: number;
}

interface ClearSessionsOptions {
  source?: string;
  restart?: boolean;
}

interface ClearSessionsResult {
  source: string;
  scannedInstallations: number;
  targetedInstances: number;
  clearedCount: number;
  failedCount: number;
  processed: unknown[];
}

interface ClearOversizedResult {
  source: string;
  checked: number;
  thresholdKb?: number;
  oversized?: Array<{ accountId: string; kb: number }>;
  cleared: number;
  failed: number;
  skipped: number;
}

interface EnqueueOptions {
  agentName: string;
  podId: unknown;
  type: string;
  payload?: Record<string, unknown>;
  instanceId?: string;
  deliveryMode?: 'wake' | 'digest';
}

interface ListOptions {
  agentName: string;
  podId?: unknown;
  podIds?: unknown[];
  limit?: number;
  instanceId?: string;
}

interface InboxPage {
  events: EventDoc[];
  inboxCount: number;
}

interface AvailableIntegration {
  id?: string;
  type?: string;
  channelId?: string;
  channelName?: string;
  groupId?: string;
  groupName?: string;
}

// Normalize Mongoose Map config to plain object
const normalizeConfig = (config: unknown): Record<string, unknown> => {
  if (!config) return {};
  if (config instanceof Map) return Object.fromEntries(config.entries());
  return config as Record<string, unknown>;
};

const deliverEventViaWebhook = async (installation: InstallationDoc, event: EventDoc): Promise<void> => {
  const runtimeConfig = (normalizeConfig(installation.config)?.runtime || {}) as Record<string, unknown>;
  const { webhookUrl, webhookSecret } = runtimeConfig as { webhookUrl?: string; webhookSecret?: string };
  if (!webhookUrl) return;

  // Webhook drivers never poll the inbox. Carry ambient context on their next
  // waking POST, then settle it only after the endpoint accepts that POST.
  await AgentEventService.attachLegacyDigest(event).catch((err: Error) => {
    console.warn('[webhook] digest attachment failed:', err.message);
  });

  const payload = JSON.stringify({
    _id: event._id,
    type: event.type,
    podId: event.podId,
    agentName: event.agentName,
    instanceId: event.instanceId,
    createdAt: event.createdAt,
    payload: event.payload,
  });

  const signature = webhookSecret
    ? `sha256=${crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex')}`
    : undefined;

  try {
    // The URL is whatever the installer registered, so delivery goes through
    // the open-destination guard: public addresses only, connection pinned to
    // the address that was checked, redirects re-checked, 10s deadline.
    const res = await postToPublicAddress(webhookUrl, {
      headers: {
        'Content-Type': 'application/json',
        'X-Commonly-Event': event.type || '',
        'X-Commonly-Delivery': String(event._id),
        ...(signature ? { 'X-Commonly-Signature': signature } : {}),
      },
      body: payload,
    });

    if (!res.ok) {
      console.warn(`[webhook] ${event.agentName} ${webhookUrl} → HTTP ${res.status}`);
      return;
    }

    let response: Record<string, unknown> = {};
    try { response = JSON.parse(res.text) as Record<string, unknown>; } catch (_) { /* no body is fine */ }

    const { outcome = 'acknowledged', content, reason } = response as {
      outcome?: string; content?: string; reason?: string;
    };

    if (outcome === 'posted' && content) {
      try {
        // eslint-disable-next-line global-require
        const agentMessageService = require('./agentMessageService');
        await agentMessageService.postAgentMessage({
          agentName: event.agentName,
          instanceId: event.instanceId,
          podId: event.podId,
          content: String(content),
        });
      } catch (postErr) {
        console.warn(`[webhook] Failed to post message for ${event.agentName}:`, (postErr as Error).message);
      }
    }

    // Terminal, not 'delivered'. The webhook has returned 2xx and its outcome
    // is recorded — there is no later ack coming, because ADR-006 drivers do
    // not poll and cannot call POST /events/:id/ack. Leaving these 'delivered'
    // put every successfully-handled webhook event into the garbageCollect()
    // requeue population, which has no `delivery` exclusion: ~10-20 min after
    // a successful POST the row flipped back to 'pending' and the endpoint was
    // called AGAIN with the same event. That is duplicate delivery across the
    // whole webhook driver class, not queue hygiene — and it is exactly the
    // at-least-once behaviour ADR-004 permits, arriving for a reason the
    // driver has no way to distinguish from a real retry.
    await AgentEvent.findByIdAndUpdate(event._id, {
      status: 'acked',
      deliveredAt: new Date(),
      'delivery.outcome': outcome,
      'delivery.updatedAt': new Date(),
    });
    if (outcome === 'posted' || outcome === 'acknowledged' || (outcome === 'no_action' && !reason)) {
      await AgentEventService.settleLegacyDigest(event).catch((err: Error) => {
        console.warn('[webhook] digest settle failed:', err.message);
      });
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.warn(`[webhook] ${event.agentName} ${webhookUrl} timed out after 10s`);
    } else {
      console.warn(`[webhook] ${event.agentName} ${webhookUrl} error:`, (err as Error).message);
    }
  }
};

// Lazy-loaded to avoid circular dependency
let agentWebSocketService: { pushEvent: (event: unknown) => void } | null = null;
const getWebSocketService = (): { pushEvent: (event: unknown) => void } | null => {
  if (!agentWebSocketService) {
    try {
      // eslint-disable-next-line global-require
      agentWebSocketService = require('./agentWebSocketService') as { pushEvent: (event: unknown) => void };
    } catch {
      agentWebSocketService = null;
    }
  }
  return agentWebSocketService;
};

// Lazy-loaded typing service — avoids any circular dep and makes the
// signalling optional when not wired (e.g., in tests).
let agentTypingService: {
  emitAgentTypingStart: (agent: {
    podId: unknown;
    agentName: string;
    instanceId?: string;
    displayName: string;
    avatar?: string;
  }) => void;
} | null = null;
const getTypingService = (): typeof agentTypingService => {
  if (!agentTypingService) {
    try {
      // eslint-disable-next-line global-require
      agentTypingService = require('./agentTypingService');
    } catch {
      agentTypingService = null;
    }
  }
  return agentTypingService;
};

// Event types that should surface a typing indicator in the target pod.
// Background/broadcast events (e.g., global heartbeats with no pod) are
// already filtered out upstream by requiring a concrete podId, but we also
// gate by type so that non-response events (e.g., delivery audits) never
// light up the UI.
const TYPING_EVENT_TYPES = new Set<string>([
  'heartbeat',
  'chat.mention',
  'summary.request',
  'discord.summary',
  'integration.summary',
  'ensemble.turn',
]);

const signalAgentTyping = async (event: EventDoc): Promise<void> => {
  try {
    const typing = getTypingService();
    if (!typing) return;
    if (!event?.podId || !event?.agentName || !event?.type) return;
    if (!TYPING_EVENT_TYPES.has(event.type)) return;

    let displayName = event.agentName;
    let avatar: string | undefined;
    try {
      // Events are delivered to a concrete pod. Prefer that installation's
      // label over the shared User label so the typing indicator follows the
      // same scope rule as a posted message.
      const installation = await AgentInstallation.findOne({
        agentName: event.agentName,
        instanceId: event.instanceId || 'default',
        podId: event.podId,
        status: 'active',
      }).select('displayName').lean() as { displayName?: string } | null;
      const agentUser = await AgentIdentityService.getOrCreateAgentUser(event.agentName, {
        instanceId: event.instanceId || 'default',
      }) as {
        username?: string;
        profilePicture?: string;
        botMetadata?: { displayName?: string };
      };
      displayName = installation?.displayName
        || agentUser?.botMetadata?.displayName
        || agentUser?.username
        || event.agentName;
      avatar = agentUser?.profilePicture || undefined;
    } catch (identityError) {
      // Fall back to the raw agent name — typing indicator is cosmetic, not load-bearing.
      console.warn('[agent-typing] identity lookup failed:', (identityError as Error).message);
    }

    typing.emitAgentTypingStart({
      podId: event.podId,
      agentName: event.agentName,
      instanceId: event.instanceId || 'default',
      displayName,
      avatar,
    });
  } catch (err) {
    console.warn('[agent-typing] signal failed:', (err as Error).message);
  }
};

class AgentEventService {
  static getContextOverflowRetryLimit(): number {
    const parsed = Number.parseInt(process.env.AGENT_CONTEXT_OVERFLOW_RETRY_LIMIT || '', 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 1;
    return parsed;
  }

  static shouldRestartAfterSessionClear(): boolean {
    const raw = String(process.env.AGENT_CONTEXT_OVERFLOW_RESTART_AFTER_CLEAR || '1').trim().toLowerCase();
    return raw !== '0' && raw !== 'false' && raw !== 'no';
  }

  static getSessionResetIntervalHours(): number {
    const parsed = Number.parseInt(process.env.AGENT_RUNTIME_SESSION_RESET_HOURS || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 24;
    return Math.max(1, Math.min(168, Math.trunc(parsed)));
  }

  static isSessionResetDue(now = new Date()): boolean {
    const intervalHours = this.getSessionResetIntervalHours();
    const hourBucket = Math.floor(now.getTime() / (60 * 60 * 1000));
    return hourBucket % intervalHours === 0;
  }

  static parseOverflowRetryCount(payload: Record<string, unknown> = {}): number {
    const parsed = Number.parseInt(String(payload?._contextOverflowRetryCount ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
  }

  static detectContextOverflowText(value: unknown): boolean {
    const text = String(value || '').trim();
    if (!text) return false;
    return /context overflow|prompt too large|context length|max(imum)? context|token limit|too many tokens/i
      .test(text);
  }

  static shouldAttemptContextOverflowRecovery(delivery: DeliveryMeta = {}): boolean {
    if (!delivery || delivery.outcome !== 'error') return false;
    if (this.detectContextOverflowText(delivery.reason)) return true;
    return this.detectContextOverflowText(delivery?.details?.message)
      || this.detectContextOverflowText(delivery?.details?.error)
      || this.detectContextOverflowText(delivery?.details?.description);
  }

  static buildContextOverflowRetryPayload(
    payload: Record<string, unknown> = {},
    delivery: DeliveryMeta = {},
  ): Record<string, unknown> {
    const retryCount = this.parseOverflowRetryCount(payload) + 1;
    return {
      ...payload,
      _contextOverflowRetryCount: retryCount,
      _contextOverflowRecoveredAt: new Date().toISOString(),
      _contextOverflowReason: delivery.reason || delivery?.details?.message || 'context overflow',
      trigger: payload?.trigger ? `${payload.trigger}:context-overflow-retry` : 'context-overflow-retry',
    };
  }

  static async resolveGatewayFromInstallation(installation: InstallationDoc): Promise<GatewayDoc | null> {
    const runtimeConfig = (normalizeConfig(installation?.config)?.runtime || {}) as Record<string, unknown>;
    const gatewayId = runtimeConfig?.gatewayId;
    if (!gatewayId) return null;
    const gateway = await Gateway.findById(gatewayId).lean() as GatewayDoc | null;
    if (!gateway) return null;
    if (gateway.status && gateway.status !== 'active') return null;
    return gateway;
  }

  static async recoverContextOverflow(event: EventDoc, delivery: DeliveryMeta): Promise<Record<string, unknown>> {
    const typeConfig = AgentIdentityService.getAgentTypeConfig(event?.agentName) as { runtime?: string } | null;
    if (typeConfig?.runtime !== 'moltbot') {
      return { recovered: false, reason: 'runtime_not_openclaw' };
    }

    const retryLimit = this.getContextOverflowRetryLimit();
    const retryCount = this.parseOverflowRetryCount(event?.payload);
    if (retryCount >= retryLimit) {
      return { recovered: false, reason: 'retry_limit_reached', retryCount, retryLimit };
    }

    const installation = await AgentInstallation.findOne({
      agentName: event.agentName,
      instanceId: event.instanceId || 'default',
      podId: event.podId,
      status: 'active',
    }).select('config.runtime.gatewayId').lean() as InstallationDoc | null;

    const gateway = await this.resolveGatewayFromInstallation(installation || {});
    const accountId = resolveOpenClawAccountId({
      agentName: event.agentName,
      instanceId: event.instanceId || 'default',
    }) as string;

    const cleared = await clearAgentRuntimeSessions('moltbot', event.instanceId || 'default', {
      gateway,
      accountId,
    });
    let restarted = null;
    if (this.shouldRestartAfterSessionClear()) {
      restarted = await restartAgentRuntime('moltbot', event.instanceId || 'default', { gateway });
    }

    const retryEvent = await this.enqueue({
      agentName: event.agentName!,
      instanceId: event.instanceId || 'default',
      podId: event.podId,
      type: event.type!,
      payload: this.buildContextOverflowRetryPayload(event.payload || {}, delivery),
    });

    return {
      recovered: true,
      retryEventId: (retryEvent as EventDoc)?._id?.toString?.() || null,
      retryCount: retryCount + 1,
      retryLimit,
      cleared,
      restarted,
    };
  }

  static async clearOpenClawSessionsForActiveInstallations({
    source = 'scheduled',
    restart = true,
  }: ClearSessionsOptions = {}): Promise<ClearSessionsResult> {
    const installations = await AgentInstallation.find({
      status: 'active',
    }).select('agentName instanceId config.runtime.gatewayId').lean() as InstallationDoc[];

    const byInstance = new Map<string, { agentName: string; instanceId: string; gatewayId: string | null }>();
    installations.forEach((installation) => {
      const typeConfig = AgentIdentityService.getAgentTypeConfig(installation?.agentName) as { runtime?: string } | null;
      if (typeConfig?.runtime !== 'moltbot') return;
      const agentName = String(installation.agentName || '').toLowerCase();
      const instanceId = String(installation.instanceId || 'default');
      const runtimeConfig = (normalizeConfig(installation?.config)?.runtime || {}) as Record<string, unknown>;
      const gatewayId = runtimeConfig?.gatewayId ? String(runtimeConfig.gatewayId) : '';
      const key = `${agentName}:${instanceId}:${gatewayId}`;
      if (!byInstance.has(key)) {
        byInstance.set(key, { agentName, instanceId, gatewayId: gatewayId || null });
      }
    });

    const targets = Array.from(byInstance.values());
    const processed = await Promise.all(targets.map(async (target) => {
      const accountId = resolveOpenClawAccountId({
        agentName: target.agentName,
        instanceId: target.instanceId,
      }) as string;

      try {
        const gateway = target.gatewayId
          ? await Gateway.findById(target.gatewayId).lean() as GatewayDoc | null
          : null;
        const cleared = await clearAgentRuntimeSessions('moltbot', target.instanceId, {
          gateway: gateway && (!gateway.status || gateway.status === 'active') ? gateway : null,
          accountId,
        });
        let restarted = null;
        if (restart) {
          restarted = await restartAgentRuntime('moltbot', target.instanceId, {
            gateway: gateway && (!gateway.status || gateway.status === 'active') ? gateway : null,
          });
        }
        return { ...target, accountId, source, status: 'cleared', cleared, restarted };
      } catch (error) {
        return { ...target, accountId, source, status: 'failed', error: (error as Error).message };
      }
    }));

    const clearedCount = processed.filter((item) => item.status === 'cleared').length;
    const failedCount = processed.filter((item) => item.status === 'failed').length;

    return {
      source,
      scannedInstallations: installations.length,
      targetedInstances: targets.length,
      clearedCount,
      failedCount,
      processed,
    };
  }

  static async clearOversizedAgentSessions({
    source = 'size-check',
    restart = false,
  }: ClearSessionsOptions = {}): Promise<ClearOversizedResult> {
    const thresholdKb = Math.max(
      64,
      Number.parseInt(process.env.AGENT_SESSION_MAX_SIZE_KB || '', 10) || 400,
    );
    const thresholdBytes = thresholdKb * 1024;

    let sizes: SessionSizeEntry[];
    try {
      sizes = await getAgentSessionSizes() as SessionSizeEntry[];
    } catch (error) {
      console.error('[session-size-check] Failed to get session sizes:', (error as Error).message);
      return { source, checked: 0, cleared: 0, failed: 0, skipped: 0 };
    }

    const oversized = sizes.filter((s) => s.bytes >= thresholdBytes);
    let cleared = 0;
    let failed = 0;
    const skipped = sizes.length - oversized.length;

    await Promise.all(oversized.map(async (entry) => {
      try {
        await clearAgentRuntimeSessions('moltbot', entry.accountId, { accountId: entry.accountId });
        console.log(
          `[session-size-check] Cleared sessions for ${entry.accountId} `
          + `(${Math.round(entry.bytes / 1024)} KB > ${thresholdKb} KB threshold)`,
        );
        if (restart) {
          await restartAgentRuntime('moltbot', entry.accountId, {}).catch(() => null);
        }
        cleared += 1;
      } catch (error) {
        console.error(`[session-size-check] Failed to clear ${entry.accountId}:`, (error as Error).message);
        failed += 1;
      }
    }));

    return {
      source,
      checked: sizes.length,
      thresholdKb,
      oversized: oversized.map((s) => ({ accountId: s.accountId, kb: Math.round(s.bytes / 1024) })),
      cleared,
      failed,
      skipped,
    };
  }

  static normalizeDeliveryMeta(input: unknown = {}): DeliveryMeta | null {
    if (!input || typeof input !== 'object') return null;
    const allowedOutcomes = new Set(['acknowledged', 'posted', 'no_action', 'skipped', 'error']);
    const inp = input as Record<string, unknown>;
    const rawOutcome = typeof inp.outcome === 'string' ? inp.outcome.trim().toLowerCase() : '';
    const outcome = allowedOutcomes.has(rawOutcome) ? rawOutcome : 'acknowledged';
    const reason = typeof inp.reason === 'string' ? inp.reason.trim() : '';
    const messageId = typeof inp.messageId === 'string' ? inp.messageId.trim() : '';
    const details = inp.details && typeof inp.details === 'object' ? inp.details as Record<string, unknown> : undefined;
    return {
      outcome,
      reason: reason || undefined,
      messageId: messageId || undefined,
      details,
      updatedAt: new Date(),
    };
  }

  // Phase B on? The routes need this BEFORE calling acknowledge: with the
  // flag set, a nonce-less ack returns null, and null is indistinguishable
  // from "already gone" — so the route would answer 200 and the driver would
  // believe it acked while the event rolled into the requeue with no signal
  // (found in review). A refused ack has to say so.
  static isDeliveryNonceRequired(consumer?: string): boolean {
    return requireDeliveryNonce(consumer);
  }

  // Reads the Phase A migration counter. The flip to a required nonce is
  // gated on `withoutNonce` being zero at the consumers, so the number has to
  // be reachable by something other than a grep of the logs.
  static getAckNonceStats(): {
    withNonce: number;
    withoutNonce: number;
    withoutNonceByConsumer: Record<string, number>;
  } {
    return { ...ackNonceStats, withoutNonceByConsumer: { ...ackNonceStats.withoutNonceByConsumer } };
  }

  static logEventLifecycle(action: string, details: Record<string, unknown> = {}): void {
    const parts = [
      `[agent-event] ${action}`,
      `agent=${details.agentName || 'unknown'}`,
      `instance=${details.instanceId || 'default'}`,
      `pod=${details.podId || 'n/a'}`,
      `type=${details.type || 'n/a'}`,
      `id=${details.eventId || 'n/a'}`,
    ];
    if (details.trigger) parts.push(`trigger=${details.trigger}`);
    if (details.deliveryMode) parts.push(`deliveryMode=${details.deliveryMode}`);
    if (details.status) parts.push(`status=${details.status}`);
    if (typeof details.attempts === 'number') parts.push(`attempts=${details.attempts}`);
    if (details.error) parts.push(`error="${details.error}"`);
    console.log(parts.join(' '));
  }

  static async garbageCollect({
    deliveredRetentionHours = Number(process.env.AGENT_EVENT_DELIVERED_RETENTION_HOURS || 168),
    failedRetentionHours = Number(process.env.AGENT_EVENT_FAILED_RETENTION_HOURS || 168),
    requeueDeliveredMinutes = Number(process.env.AGENT_EVENT_REQUEUE_DELIVERED_MINUTES || 10),
    requeueMaxAttempts = Number(process.env.AGENT_EVENT_REQUEUE_MAX_ATTEMPTS || 3),
  }: GarbageCollectOptions = {}): Promise<GarbageCollectResult> {
    const now = Date.now();
    const deliveredThreshold = new Date(now - (Math.max(deliveredRetentionHours, 1) * 60 * 60 * 1000));
    const failedThreshold = new Date(now - (Math.max(failedRetentionHours, 1) * 60 * 60 * 1000));
    const requeueThreshold = new Date(now - (Math.max(requeueDeliveredMinutes, 1) * 60 * 1000));

    // Task #67: requeue events stuck in 'delivered' status whose poller
    // crashed/errored before processing. The /events endpoint only returns
    // `status: 'pending'` events, so an unhandled 'delivered' event becomes
    // invisible to the agent forever — neither retried nor surfaced.
    // Saw this 2026-05-18: Cody's old pod marked 2 chat.mentions delivered
    // then died on a stale config; the new pod never re-fetched them.
    //
    // Requeue rule: status === 'delivered' AND deliveredAt is older than
    // 10 min (env-tunable) AND attempts < 3 (prevent infinite loops on
    // poison events). The 10-min default accommodates legitimately-long-
    // running tool calls — codex exec for multi-slide LLM generation can
    // take 3-5 min — without re-firing while the agent is still processing.
    //
    // Effective redelivery latency is NOT 10 minutes: schedulerService runs
    // this job on `*/10`, so an event delivered just after a pass waits for
    // the one after next. Period P and threshold T give [T, T+P) — uniform
    // over 10-20 min here, mean ~15. Change both numbers together.
    //
    // The predicate previously also required `ackedAt: {$in: [null, undefined]}`.
    // There is no `ackedAt` field on AgentEvent — not in IAgentEvent, not in
    // the schema, never written — so Mongoose stripped it and the clause
    // matched every document. Dropped rather than "fixed": `status: 'delivered'`
    // already excludes acked events, since ack moves the row to 'acked'.
    let requeuedDelivered = 0;
    let expiredDelivered = 0;
    const attemptCap = Math.max(requeueMaxAttempts, 1);

    // TASK-264: an in-process (native) turn that died with its process — a
    // deploy, a crash — leaves its event 'delivered' with no ack. The requeue
    // below would hand it to 'pending', which no native agent polls, so the
    // person would never get an answer. Re-run those first, through the path
    // enqueue uses; a re-run refreshes deliveredAt, so the requeue skips it.
    // Its own try: a failure here must not cost the requeue its pass.
    let redispatchedInProcess = 0;
    let ackedInProcess = 0;
    let interruptedRuns = 0;
    let rescuedPendingInProcess = 0;
    let closedPendingInProcess = 0;
    try {
      ({ redispatched: redispatchedInProcess, acked: ackedInProcess } = await this.redispatchStuckInProcess(
        requeueThreshold,
        attemptCap,
      ));
      ({ rescued: rescuedPendingInProcess, closed: closedPendingInProcess } = await this.rescueStrandedPendingInProcess(
        new Date(now),
        attemptCap,
      ));
      interruptedRuns = await this.interruptAbandonedRuns(new Date(now - ABANDONED_RUN_MINUTES * 60 * 1000));
      if (redispatchedInProcess || ackedInProcess || interruptedRuns || rescuedPendingInProcess || closedPendingInProcess) {
        console.log(
          `[agent-event] in-process restart sweep: re-ran ${redispatchedInProcess}, acked ${ackedInProcess}, `
          + `ran ${rescuedPendingInProcess} stranded pending, closed ${closedPendingInProcess} past the ceiling, `
          + `marked ${interruptedRuns} abandoned runs interrupted`,
        );
      }
    } catch (err: unknown) {
      console.warn('[agent-event] in-process restart sweep failed:', (err as Error).message);
    }

    try {
      const requeueResult = await AgentEvent.updateMany(
        {
          status: 'delivered',
          deliveredAt: { $lt: requeueThreshold },
          $or: [{ attempts: { $lt: attemptCap } }, { attempts: { $exists: false } }],
        },
        {
          // ADR-026 D6: clearing the nonce IS the invalidation. The child
          // whose delivery this was can no longer ack it, whether or not a
          // replacement has claimed yet — so a supervisor restart can no
          // longer let a stale child terminate the new child's delivery
          // mid-turn.
          $set: { status: 'pending', deliveredAt: null, deliveryNonce: null },
        },
      ) as { modifiedCount?: number };
      requeuedDelivered = requeueResult?.modifiedCount || 0;
      if (requeuedDelivered > 0) {
        console.log(`[agent-event] requeued ${requeuedDelivered} stuck 'delivered' events older than ${requeueDeliveredMinutes}min`);
      }

      // D6 rollout coverage, on the pass that already runs on a schedule —
      // no new surface, and it lands next to the requeue it is about. This is
      // the number Phase B is gated on; `without=0` sustained past one requeue
      // window is the signal to set AGENT_EVENT_REQUIRE_DELIVERY_NONCE.
      console.log(
        `[agent-event] ack deliveryId coverage (ack CALLS this process since restart, not distinct deliveries): `
        + `with=${ackNonceStats.withNonce} without=${ackNonceStats.withoutNonce} `
        // Naming the holdouts is the whole point of a per-consumer flip: the
        // operator needs to see WHICH consumer is still nonce-less, not just
        // that something is.
        + `withoutBy=${JSON.stringify(ackNonceStats.withoutNonceByConsumer)} `
        + `enforced=${JSON.stringify([...enforcedAckConsumers()])}`,
      );

      // Retire events that have exhausted the cap. This pass is what makes the
      // cap a bound rather than a leak: `attempts >= cap` fails the requeue
      // predicate, and a 'delivered' row is invisible to list(), so without a
      // terminal transition a poison event silently reproduces the exact Task
      // #67 symptom above — stuck, unretried, unsurfaced — for the full 168h
      // retention window. Disjoint from the requeue by `attempts` alone, so
      // the two passes cannot touch the same document in one run.
      const expireResult = await AgentEvent.updateMany(
        {
          status: 'delivered',
          deliveredAt: { $lt: requeueThreshold },
          attempts: { $gte: attemptCap },
        },
        {
          $set: {
            status: 'failed',
            deliveryNonce: null,
            error: `requeue cap exhausted after ${attemptCap} delivery attempts without an ack`,
          },
        },
      ) as { modifiedCount?: number };
      expiredDelivered = expireResult?.modifiedCount || 0;
      if (expiredDelivered > 0) {
        console.warn(`[agent-event] retired ${expiredDelivered} 'delivered' events that exhausted the ${attemptCap}-attempt requeue cap`);
      }
    } catch (err: unknown) {
      console.warn('[agent-event] requeue pass failed:', (err as Error).message);
    }

    // ADR-012 §3: 'delivered' is now an intermediate state (claimed, awaiting ack)
    // and 'acked' is the new terminal state. Both age out on the same retention
    // schedule — once an event is past the `delivered` threshold it's stale
    // whether the agent ever explicitly acked or not.
    let foldedDigest = 0;
    try {
      foldedDigest = await foldExpiredDigests(deliveredThreshold);
    } catch (err) {
      // The fold is fail-closed: its `folding` rows remain retryable and the
      // pending delete below excludes digest. Other event retention can run.
      console.warn('[agent-event] digest fold failed:', (err as Error).message);
    }
    const [pendingResult, ackedResult, deliveredResult, failedResult] = await Promise.all([
      // #993: this used to run on a 30-minute `stalePendingThreshold`, which put
      // it AHEAD of the retry lifecycle rather than after it. The requeue pass
      // above sets `status` but not `createdAt`, so an event it had just rescued
      // walked straight into this delete carrying its original age — rescue and
      // destruction in the same Promise.all, keyed on different fields. Measured
      // over one hour: 38 pending events destroyed, with the log pairing the two
      // per run (11:00 requeued 17, then deleted 17).
      //
      // Pending now ages out on the same horizon as everything else. That is not
      // just "longer": it has to be the SAME instant, because any shorter pending
      // window re-opens the race — against an 18-minute retry ceiling, against a
      // seat restart, against a quota outage that resets at a wall-clock hour.
      // Giving the lifecycle room also makes the cap reachable for the first
      // time, so cap-exhausted events reach `failed` with a reason instead of
      // vanishing (which is the dead-letter surface this had no other way to get).
      //
      // AGENT_EVENT_STALE_PENDING_MINUTES is deliberately NOT read here any more.
      // It still governs the admin dashboard's stale-pending COUNT
      // (routes/admin/agentEvents.ts), where "pending for over 30 minutes" is a
      // useful thing to look at — and is now actionable, because seeing it no
      // longer means the row is about to be destroyed.
      // Digest rows are unread state. Retiring them without folding into a
      // durable per-seat summary would silently erase the notification.
      AgentEvent.deleteMany({
        status: 'pending', deliveryMode: { $ne: 'digest' }, createdAt: { $lt: deliveredThreshold },
      }),
      AgentEvent.deleteMany({
        status: 'acked', createdAt: { $lt: deliveredThreshold },
      }),
      AgentEvent.deleteMany({
        status: 'delivered', deliveryMode: { $ne: 'digest' }, createdAt: { $lt: deliveredThreshold },
      }),
      AgentEvent.deleteMany({
        status: 'failed', deliveryMode: { $ne: 'digest' }, createdAt: { $lt: failedThreshold },
      }),
    ]) as Array<{ deletedCount?: number }>;

    const deletedPending = pendingResult?.deletedCount || 0;
    const deletedDelivered = (ackedResult?.deletedCount || 0) + (deliveredResult?.deletedCount || 0);
    const deletedFailed = failedResult?.deletedCount || 0;

    return {
      deletedPending,
      deletedDelivered,
      deletedFailed,
      totalDeleted: deletedPending + deletedDelivered + deletedFailed + foldedDigest,
      foldedDigest,
      deliveredRetentionHours: Math.max(deliveredRetentionHours, 1),
      failedRetentionHours: Math.max(failedRetentionHours, 1),
      requeuedDelivered,
      requeueDeliveredMinutes: Math.max(requeueDeliveredMinutes, 1),
      expiredDelivered,
      redispatchedInProcess,
      ackedInProcess,
      interruptedRuns,
      rescuedPendingInProcess,
      closedPendingInProcess,
    };
  }

  /**
   * TASK-264. Re-runs in-process events whose turn died with the process.
   * Each is claimed by swapping its delivery nonce, so two sweeps (two
   * replicas, or a sweep racing a late settle) cannot both run it, and the
   * claim counts as a delivery, so the requeue cap still bounds a poison
   * event. An event whose run already succeeded and only lost its ack is
   * acked, not answered twice. Either way the dead turn's AgentRun, if it was
   * left 'queued' or 'running', is marked 'interrupted'.
   */
  static async redispatchStuckInProcess(
    threshold: Date,
    attemptCap: number,
  ): Promise<{ redispatched: number; acked: number }> {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const AgentRun = require('../models/AgentRun');
    const stuck = await AgentEvent.find({
      status: 'delivered',
      deliveryMode: { $ne: 'digest' },
      deliveredAt: { $lt: threshold },
      $or: [{ attempts: { $lt: attemptCap } }, { attempts: { $exists: false } }],
    }).sort({ deliveredAt: 1 }).limit(STUCK_REDISPATCH_BATCH).lean() as EventDoc[];
    let redispatched = 0;
    let acked = 0;
    for (const stale of stuck) {
      const agentName = String(stale.agentName || '');
      const instanceId = String(stale.instanceId || 'default');
      // eslint-disable-next-line no-await-in-loop -- one lookup per stuck event; the set is the crashed turns only
      const installation = await this.resolveInProcessInstallation(agentName, instanceId, stale.podId)
        .catch(() => null);
      // Not in-process: an external poller's event, which the requeue handles.
      if (!installation) continue;
      const runKey = { podId: stale.podId, agentName, instanceId, triggerEventId: stale._id };
      // eslint-disable-next-line no-await-in-loop
      const finished = await AgentRun.exists({ ...runKey, status: 'succeeded' });
      const deliveryNonce = mintDeliveryNonce();
      // eslint-disable-next-line no-await-in-loop
      const claimed = await AgentEvent.findOneAndUpdate(
        { _id: stale._id, status: 'delivered', deliveryNonce: stale.deliveryNonce ?? null },
        { $set: { deliveredAt: new Date(), deliveryNonce }, $inc: { attempts: 1 } },
        { new: true },
      ) as EventDoc | null;
      if (!claimed) continue;
      // eslint-disable-next-line no-await-in-loop
      await AgentRun.updateMany(
        { ...runKey, status: { $in: ['queued', 'running'] } },
        { $set: { status: 'interrupted', completedAt: new Date() } },
      );
      if (finished) {
        // eslint-disable-next-line no-await-in-loop
        await this.acknowledge(
          String(stale._id),
          agentName,
          instanceId,
          { outcome: 'acknowledged', reason: 'native-runtime-completed' },
          deliveryNonce,
          'native',
        ).catch((ackErr: Error) => {
          console.warn('[native-runtime] restart-sweep ack failed:', ackErr?.message || ackErr);
        });
        acked += 1;
        continue;
      }
      this.dispatchInProcess(claimed, installation, agentName, instanceId, String(claimed.type || stale.type || ''));
      redispatched += 1;
    }
    return { redispatched, acked };
  }

  /**
   * The (agent, instance, pod) targets whose events enqueue would run
   * in-process right now. Starts from identities with a stored in-process
   * install (the token issuer's filter), loads every active row of those
   * identities (projections included), and keeps only the rows the routing
   * rule itself runs, with the engine in effect. An unfinished migration's
   * rows are therefore not targets, so their events can never fill the
   * sweep's batch and starve a runnable agent's event (Rhea on #2236).
   */
  static async inProcessEventTargets(): Promise<{ agentName: string; instanceId: string; podId: unknown }[]> {
    const identities = await AgentInstallation.find({ status: 'active', ...IN_PROCESS_RUNTIME_FILTER })
      .select('agentName instanceId').lean() as { agentName?: string; instanceId?: string }[];
    const pairs = [...new Map(identities.map((row) => {
      const pair = { agentName: String(row.agentName || '').toLowerCase(), instanceId: String(row.instanceId || 'default') };
      return [`${pair.agentName}:${pair.instanceId}`, pair] as const;
    })).values()];
    if (!pairs.length) return [];
    const rows = await AgentInstallation.find({ status: 'active', $or: pairs })
      .sort({ createdAt: -1 }).lean() as InstallationDoc[];
    const identityKey = (row: InstallationDoc) => `${String(row.agentName || '').toLowerCase()}:${String(row.instanceId || 'default')}`;
    // The sibling a projection inherits from: the identity's most recent row
    // that has a runtime (rows are newest first), as resolveInProcessInstallation finds it.
    const siblings = new Map<string, InstallationDoc>();
    for (const row of rows) {
      const runtime = normalizeConfig(row.config)?.runtime as Record<string, unknown> | undefined;
      if (runtime?.runtimeType !== undefined && !siblings.has(identityKey(row))) siblings.set(identityKey(row), row);
    }
    return rows
      .filter((row) => this.inProcessInstallationFrom({ ...row }, siblings.get(identityKey(row)) || null))
      .map((row) => ({
        agentName: String(row.agentName || '').toLowerCase(),
        instanceId: String(row.instanceId || 'default'),
        podId: row.podId,
      }));
  }

  /**
   * Pending events whose agent now runs in-process, which nothing polls (see
   * STRANDED_PENDING_*). One past the ceiling is closed 'failed' with a
   * reason, so the dropped question is visible rather than parked (sprint
   * review on #2236). A recent one is run once: the claim is a
   * compare-and-set from 'pending', so two sweeps (two replicas) or a late
   * external poll run it at most once, and it counts as a delivery, so the
   * attempt cap bounds a poison event. Only targets that would run are
   * selected, and each is re-checked by enqueue's own routing before it runs.
   */
  static async rescueStrandedPendingInProcess(
    now: Date,
    attemptCap: number,
  ): Promise<{ rescued: number; closed: number }> {
    const targets = await this.inProcessEventTargets();
    if (!targets.length) return { rescued: 0, closed: 0 };
    const targetFilter = { $or: targets };
    const ceiling = new Date(now.getTime() - STRANDED_PENDING_MAX_AGE_MS);
    const closedResult = await AgentEvent.updateMany(
      { status: 'pending', deliveryMode: { $ne: 'digest' }, createdAt: { $lt: ceiling }, ...targetFilter },
      {
        $set: {
          status: 'failed',
          error: 'stranded: this agent runs in-process and the event was not run within 30 minutes of being '
            + 'enqueued; closed so it does not sit pending unanswered',
        },
      },
    ) as { modifiedCount?: number };
    const stranded = await AgentEvent.find({
      status: 'pending',
      deliveryMode: { $ne: 'digest' },
      createdAt: {
        $lt: new Date(now.getTime() - STRANDED_PENDING_MIN_AGE_MS),
        $gte: ceiling,
      },
      $and: [
        targetFilter,
        { $or: [{ attempts: { $lt: attemptCap } }, { attempts: { $exists: false } }] },
      ],
    }).sort({ createdAt: 1 }).limit(STUCK_REDISPATCH_BATCH).lean() as EventDoc[];
    let rescued = 0;
    for (const event of stranded) {
      const agentName = String(event.agentName || '');
      const instanceId = String(event.instanceId || 'default');
      // eslint-disable-next-line no-await-in-loop -- one lookup per stranded event
      const installation = await this.resolveInProcessInstallation(agentName, instanceId, event.podId)
        .catch(() => null);
      // Changed since the targets were read (a deprovision, an install removed).
      if (!installation) continue;
      const deliveryNonce = mintDeliveryNonce();
      // eslint-disable-next-line no-await-in-loop
      const claimed = await AgentEvent.findOneAndUpdate(
        { _id: event._id, status: 'pending' },
        { $set: { status: 'delivered', deliveredAt: new Date(), deliveryNonce }, $inc: { attempts: 1 } },
        { new: true },
      ) as EventDoc | null;
      if (!claimed) continue;
      this.dispatchInProcess(claimed, installation, agentName, instanceId, String(claimed.type || event.type || ''));
      rescued += 1;
    }
    return { rescued, closed: closedResult?.modifiedCount || 0 };
  }

  /**
   * AgentRuns still 'queued' or 'running' long after any turn could have
   * ended (a native turn is bounded at about two minutes) belong to a turn
   * whose process died. Marking them 'interrupted' keeps run history honest.
   * The daily caps count runs by start time, so this changes no budget.
   */
  static async interruptAbandonedRuns(startedBefore: Date): Promise<number> {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const AgentRun = require('../models/AgentRun');
    const result = await AgentRun.updateMany(
      { status: { $in: ['queued', 'running'] }, startedAt: { $lt: startedBefore } },
      { $set: { status: 'interrupted', completedAt: new Date() } },
    ) as { modifiedCount?: number };
    return result?.modifiedCount || 0;
  }

  static hasIntegrationReadScope(installation: InstallationDoc): boolean {
    const scopes = installation?.scopes || [];
    return scopes.includes('integration:read') || scopes.includes('integrations:read');
  }

  static mergeAvailableIntegrations(
    existing: AvailableIntegration[] | unknown,
    incoming: AvailableIntegration[],
  ): AvailableIntegration[] {
    const byKey = new Map<string, AvailableIntegration>();
    (Array.isArray(existing) ? existing as AvailableIntegration[] : []).forEach((item) => {
      const key = `${item?.id || ''}:${item?.type || ''}`;
      byKey.set(key, item);
    });
    (Array.isArray(incoming) ? incoming : []).forEach((item) => {
      const key = `${item?.id || ''}:${item?.type || ''}`;
      byKey.set(key, item);
    });
    return Array.from(byKey.values());
  }

  static async enrichHeartbeatPayload({
    agentName, instanceId, podId, payload,
  }: {
    agentName: string;
    instanceId: string;
    podId: unknown;
    payload: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const installation = await AgentInstallation.findOne({
      agentName: agentName.toLowerCase(),
      podId,
      instanceId,
      status: 'active',
    }).select('scopes').lean() as InstallationDoc | null;

    if (!installation || !this.hasIntegrationReadScope(installation)) {
      return payload;
    }

    const integrations = await Integration.find({
      podId,
      isActive: true,
      status: 'connected',
      'config.agentAccessEnabled': true,
    }).select('type config.channelId config.channelName config.groupId config.groupName')
      .lean() as Array<Record<string, unknown>>;

    const availableIntegrations: AvailableIntegration[] = integrations.map((integration) => {
      const cfg = integration.config as Record<string, unknown> | undefined;
      return {
        id: String(integration._id || ''),
        type: String(integration.type || ''),
        channelId: cfg?.channelId as string | undefined,
        channelName: cfg?.channelName as string | undefined,
        groupId: cfg?.groupId as string | undefined,
        groupName: cfg?.groupName as string | undefined,
      };
    });

    return {
      ...payload,
      availableIntegrations: this.mergeAvailableIntegrations(
        payload?.availableIntegrations,
        availableIntegrations,
      ),
    };
  }

  // ADR-012 Phase 4: short "memory changed" cue prepended to events that
  // carry an inline `payload.content` to the model (chat.mention,
  // thread.mention, agent-dm). Surfaces the FACT of a memory delta — never
  // the content. Agent decides whether to call `commonly_read_agent_memory`
  // based on relevance. Costs ~25 tokens; the digest itself is NEVER inlined
  // (per `feedback-not-building-agents.md`: memory as a tool, not a prefix).
  //
  // Skipped silently on lookup error or when there's no delta. Heartbeat
  // events use the HEARTBEAT.md trailer instead — that's the runtime-aware
  // path; this cue is for the message-driven path only.
  private static async prependMemoryCue(
    agentName: string,
    instanceId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const content = payload?.content;
    if (typeof content !== 'string' || content.length === 0) return payload;
    try {
      const memDoc = await AgentMemory.findOne({
        agentName: agentName.toLowerCase(),
        instanceId,
      })
        .select({ revision: 1, lastSeenRevision: 1 })
        .lean() as { revision?: number; lastSeenRevision?: number } | null;
      const revision = memDoc?.revision ?? 0;
      const lastSeen = memDoc?.lastSeenRevision ?? 0;
      const delta = revision - lastSeen;
      if (delta <= 0) return payload;
      const cue = `[memory: ${delta} new system_exchange ${delta === 1 ? 'entry' : 'entries'} since your last cycle — call commonly_read_agent_memory if relevant.]`;
      return { ...payload, content: `${cue}\n\n${content}` };
    } catch (err) {
      // Defensive: any lookup failure skips the cue rather than blocking
      // enqueue. The cue is a hint, not a correctness primitive.
      console.warn('[agent-event] memory-cue prepend skipped:', (err as Error).message);
      return payload;
    }
  }

  // Task-board delta cue: use the agent's own most recent `cycles` entry as
  // the cursor, then surface only the number of audit updates in this pod.
  // Like the ADR-012 memory cue, this is deliberately a tool hint, not an
  // inline summary: task bodies can be stale by the time an event is claimed
  // and can be far larger than a heartbeat budget.
  //
  // No prior cycle means no trustworthy "since" boundary. Skip rather than
  // turning an agent's first heartbeat into a request to re-read every task
  // update the pod has ever recorded.
  private static async prependTaskUpdateCue(
    agentName: string,
    instanceId: string,
    podId: unknown,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const content = payload?.content;
    if (typeof content !== 'string' || content.length === 0) return payload;

    try {
      const memDoc = await AgentMemory.findOne({
        agentName: agentName.toLowerCase(),
        instanceId,
      })
        .select({ 'sections.cycles.entries.ts': 1 })
        .lean() as { sections?: { cycles?: { entries?: Array<{ ts?: unknown }> } } } | null;

      const cycleDates = memDoc?.sections?.cycles?.entries
        ?.map((entry) => new Date(entry?.ts as string | number | Date))
        .filter((ts) => !Number.isNaN(ts.getTime())) || [];
      const lastCycleAt = cycleDates.reduce<Date | null>(
        (latest, ts) => (!latest || ts > latest ? ts : latest),
        null,
      );
      if (!lastCycleAt) return payload;
      if (Date.now() - lastCycleAt.getTime() > TASK_UPDATE_CUE_MAX_CURSOR_AGE_MS) {
        return payload;
      }

      // `podId` reaches scheduled heartbeats as the Pod document's ObjectId.
      // Keep that value intact: Mongoose does not cast aggregation pipelines,
      // so stringifying it here would turn a real delta into a false zero.
      const result = await Task.aggregate([
        { $match: { podId } },
        { $unwind: '$updates' },
        { $match: { 'updates.createdAt': { $gt: lastCycleAt } } },
        { $count: 'count' },
      ]) as Array<{ count?: number }>;
      const delta = Number(result[0]?.count || 0);
      if (delta <= 0) return payload;

      const cue = `[tasks: ${delta} task ${delta === 1 ? 'update' : 'updates'} since your last cycle — call commonly_get_tasks if relevant.]`;
      return { ...payload, content: `${cue}\n\n${content}` };
    } catch (err) {
      // The cue is observational only. A board query failure must never
      // suppress a heartbeat or make task delivery depend on analytics.
      console.warn('[agent-event] task-update-cue prepend skipped:', (err as Error).message);
      return payload;
    }
  }

  /**
   * The installation an event for (agentName, instanceId, podId) runs on
   * in-process, or null when it belongs to an external poller. One decision,
   * shared by enqueue and the restart sweep (TASK-264), so the two cannot
   * disagree about which events the native runtime owns.
   */
  static async resolveInProcessInstallation(
    agentName: string,
    instanceId: string,
    podId: EnqueueOptions['podId'],
  ): Promise<InstallationDoc | null> {
    // Plain strings and a validated id, never a caller-shaped value: a podId of
    // `{ $ne: null }` would otherwise match some other pod's installation.
    const podKey = String(podId ?? '');
    if (typeof agentName !== 'string' || typeof instanceId !== 'string' || !OBJECT_ID_HEX.test(podKey)) {
      return null;
    }
    const installationDoc = await AgentInstallation.findOne({
      agentName: agentName.toLowerCase(),
      instanceId,
      podId: new Types.ObjectId(podKey),
      status: 'active',
    }).lean() as InstallationDoc | null;
    if (!installationDoc) return null;
    const ownRuntime = (normalizeConfig(installationDoc.config)?.runtime || {}) as Record<string, unknown>;
    // A projection written without its runtime (agent-room installs before
    // 2026-09-03 did this) routes like the agent it projects: the identity's
    // most recent row that has one.
    const sibling = ownRuntime.runtimeType ? null : await AgentInstallation.findOne({
      agentName: agentName.toLowerCase(),
      instanceId,
      status: 'active',
      'config.runtime.runtimeType': { $exists: true },
    }).sort({ createdAt: -1 }).lean() as InstallationDoc | null;
    return this.inProcessInstallationFrom(installationDoc, sibling);
  }

  /**
   * The routing rule itself, without the lookups: the install doc the native
   * runtime runs for `installationDoc` (merged with `sibling`'s config when the
   * row is a projection with no runtime of its own), or null. Shared by
   * `resolveInProcessInstallation` and the stranded-event sweep, so the sweep
   * can never select an event that enqueue would not run (Rhea on #2236).
   */
  static inProcessInstallationFrom(
    installationDoc: InstallationDoc,
    sibling: InstallationDoc | null,
  ): InstallationDoc | null {
    let installationRuntimeCfg = (normalizeConfig(installationDoc.config)?.runtime || {}) as Record<string, unknown>;
    if (!installationRuntimeCfg.runtimeType) {
      const siblingCfg = (sibling && normalizeConfig(sibling.config)) || null;
      const siblingRuntime = siblingCfg?.runtime as Record<string, unknown> | undefined;
      if (siblingRuntime?.runtimeType) {
        // Inherit everything the native runtime reads (runtime, model,
        // systemPrompt, tools, budgets), keeping the projection's own keys
        // on top. A room install written before #1524/#1527 has only
        // {heartbeat, autoJoinSource}; runtime alone made it route, but
        // the run then fell to the default model with no system prompt.
        const own = normalizeConfig(installationDoc.config) || {};
        const { heartbeat: _h, autoJoinSource: _a, ...inheritable } = siblingCfg as Record<string, unknown>;
        installationRuntimeCfg = siblingRuntime;
        installationDoc.config = { ...inheritable, ...own, runtime: siblingRuntime } as InstallationDoc['config'];
      }
    }
    const installationRuntimeType = String(installationRuntimeCfg.runtimeType || '').toLowerCase();
    // A provisioned hosted install on the native engine runs in-process too
    // (services/hostedEngine.ts); one on the Durable Object polls.
    return installationRuntimeType === 'native' || hostedRunsNative(installationDoc) ? installationDoc : null;
  }

  /** Persist the folded digest snapshot carried by this waking delivery. */
  static async attachFoldedDigest(event: EventDoc): Promise<{
    unreadCount: number; lastEventIds: string[];
  } | null> {
    const scope = {
      agentName: String(event.agentName || '').toLowerCase(),
      instanceId: String(event.instanceId || 'default'),
      podId: event.podId,
    };
    if (!scope.agentName || !scope.podId || !event._id) return null;
    const state = await readFoldedDigest(scope);
    if (!state) return null;
    // A retry may show the same rollup. Only the winning ack with this exact
    // state snapshot clears it; a newer fold must remain unread.
    const updated = await AgentEvent.updateOne(
      { _id: event._id, status: 'delivered', deliveryMode: { $ne: 'digest' },
        ...(event.deliveryNonce ? { deliveryNonce: event.deliveryNonce } : {}) },
      { $set: { digestRollupRevision: state.revision } },
    );
    if (!updated.modifiedCount) return null;
    return { unreadCount: state.unreadCount, lastEventIds: state.lastEventIds };
  }

  /** Add one bounded ambient frame to a wake consumed by an older poller or webhook. */
  static async attachLegacyDigest(event: EventDoc): Promise<void> {
    if (!event._id || !event.podId || !event.agentName || event.deliveryMode === 'digest') return;
    const scope = {
      agentName: String(event.agentName).toLowerCase(),
      instanceId: String(event.instanceId || 'default'),
      podId: event.podId,
    };
    const [raw, rollup] = await Promise.all([
      AgentEvent.find({ ...scope, status: 'pending', deliveryMode: 'digest' })
        .sort({ createdAt: 1 }).limit(8).lean() as Promise<EventDoc[]>,
      readFoldedDigest(scope),
    ]);
    if (!raw.length && !rollup?.unreadCount) return;
    const ids = raw.map((row) => row._id);
    const saved = await AgentEvent.updateOne(
      {
        _id: event._id,
        status: { $in: ['pending', 'delivered'] },
        deliveryMode: { $ne: 'digest' },
        ...(event.deliveryNonce ? { deliveryNonce: event.deliveryNonce } : {}),
      },
      { $set: {
        digestEventIds: ids,
        digestRollupRevision: rollup?.revision ?? null,
      } },
    );
    if (!saved.matchedCount) return;
    event.digestEventIds = ids;
    event.digestRollupRevision = rollup?.revision ?? null;
    const summary = digestConversationFrame(raw, rollup?.unreadCount || 0);
    const baseContent = typeof event.payload?.content === 'string' ? event.payload.content : '';
    event.payload = {
      ...(event.payload || {}),
      // Existing drivers consume content; the additive field also lets a new
      // driver render the frame separately without parsing the wake text.
      content: baseContent ? `${baseContent}\n\n${summary}` : summary,
      ...(typeof event.payload?.prompt === 'string'
        ? { prompt: `${event.payload.prompt}\n\n${summary}` } : {}),
      digestSummary: summary,
    };
  }

  static async settleLegacyDigest(event: EventDoc): Promise<void> {
    if (!event.agentName || !event.podId) return;
    const scope = {
      agentName: String(event.agentName).toLowerCase(),
      instanceId: String(event.instanceId || 'default'),
      podId: event.podId,
    };
    if (event.digestEventIds?.length) {
      await AgentEvent.updateMany(
        { ...scope, _id: { $in: event.digestEventIds }, status: 'pending', deliveryMode: 'digest' },
        { $set: { status: 'acked', deliveredAt: new Date() } },
      );
    }
    if (event.digestRollupRevision) await settleFoldedDigest(scope, event.digestRollupRevision);
  }

  /** Run a claimed native event and settle it without blocking enqueue. */
  static dispatchInProcess(
    event: EventDoc,
    nativeInstallation: InstallationDoc,
    agentName: string,
    instanceId: string,
    type: string,
  ): void {
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const { runAgent } = require('./nativeRuntimeService');
      const eventIdStr = String((event._id as { toString?: () => string })?.toString?.() || '');
      // D6: the native path claims at creation, so THIS is its delivery
      // nonce — and the settle handlers below are its ack. Without carrying
      // it, a native run that outlives the requeue threshold settles
      // nonce-less and terminates whatever replacement has since claimed the
      // event: the D6 race, on the one path that never polls.
      const nativeDeliveryId = event.deliveryNonce || null;
      // Fire-and-forget — callers of enqueue() must never block on the
      // loop. Errors are logged but never rethrown.
      // Settle the event on the run's actual outcome. nativeRuntimeService
      // contains no ack or recordFailure call of its own, so before this the
      // native lifecycle had no terminal state at all: every native event
      // stayed 'delivered' forever and was structurally unackable. Doing it
      // here rather than inside runAgent keeps the terminal transition next
      // to the non-terminal state that created it.
      const runWithDigest = async () => {
        const folded = await this.attachFoldedDigest(event).catch((digestErr: Error) => {
          console.warn('[native-runtime] folded digest lookup failed:', digestErr.message);
          return null;
        });
        let digest: EventDoc[] = [];
        try {
          digest = await AgentEvent.find({
            agentName: agentName.toLowerCase(), instanceId, podId: event.podId,
            status: 'pending', deliveryMode: 'digest',
          }).sort({ createdAt: 1 }).limit(8).lean() as EventDoc[];
        } catch (digestErr) {
          console.warn('[native-runtime] digest lookup failed:', (digestErr as Error).message);
        }
        const baseContent = String(event.payload?.content || event.payload?.prompt || event.payload?.text || '');
        const summary = digest.length || folded?.unreadCount
          ? digestConversationFrame(digest, folded?.unreadCount || 0) : null;
        const payload = summary ? {
          ...event.payload,
          content: `${baseContent}\n\n${summary}`,
        } : event.payload;
        const result = await runAgent(nativeInstallation, { type, eventId: eventIdStr, payload });
        // Leave digest unread when the native turn fails. On a successful turn,
        // mark only the rows actually included; older backlog remains pending.
        const modelTurnRan = result?.status === 'succeeded'
          && Boolean(result.runId) && Number(result.totalTurns) > 0;
        if (modelTurnRan && digest.length) {
          await AgentEvent.updateMany(
            { _id: { $in: digest.map((item) => item._id) }, status: 'pending', deliveryMode: 'digest' },
            { $set: { status: 'acked' } },
          ).catch((digestErr: Error) => {
            console.warn('[native-runtime] digest settle failed:', digestErr.message);
          });
        }
        return result;
      };
      Promise.resolve(runWithDigest()).then(
      // Two-argument .then, deliberately, NOT .then().catch(): a chained
      // .catch would also catch a rejection thrown by the success handler,
      // so a failing acknowledge() would fall through and mark a run that
      // actually succeeded as 'failed'. The rejection handler here is scoped
      // to runAgent alone. Both terminal calls swallow their own errors so
      // this stays fire-and-forget for the caller.
        (runResult: { status?: string; error?: string; runId?: string; totalTurns?: number }) => (runResult?.status === 'failed'
          ? this.recordFailure(
            eventIdStr,
            agentName,
            instanceId,
            `native runtime failed: ${runResult.error || 'turn failed'}`,
            nativeDeliveryId,
          ).catch(() => undefined)
          : this.acknowledge(
          eventIdStr,
          agentName,
          instanceId,
          runResult?.runId && Number(runResult.totalTurns) > 0
            ? { outcome: 'acknowledged', reason: 'native-runtime-completed' }
            : { outcome: 'no_action', reason: 'native-no-turn' },
          nativeDeliveryId,
          'native',
        ).catch((ackErr: Error) => {
          console.warn('[native-runtime] ack after successful run failed:', ackErr?.message || ackErr);
        })),
        (err: Error) => {
          console.error('[native-runtime] runAgent failed:', err?.message || err);
          // Terminal on failure too — a native event that errored must not
          // be left for the requeue to hand to an external poller that
          // cannot run it.
          return this.recordFailure(
            eventIdStr,
            agentName,
            instanceId,
            `native runtime error: ${err?.message || String(err)}`,
            nativeDeliveryId,
          ).catch(() => undefined);
        },
      );
    } catch (dispatchErr) {
      console.warn(
        '[native-runtime] dispatch error:',
        (dispatchErr as Error).message,
      );
    }
  }

  static async enqueue({
    agentName, podId, type, payload = {}, instanceId = 'default', deliveryMode = 'wake',
  }: EnqueueOptions): Promise<EventDoc> {
    if (!agentName || !podId || !type) {
      throw new Error('agentName, podId, and type are required');
    }

    const baseEventPayload = type === 'heartbeat'
      ? await this.enrichHeartbeatPayload({
        agentName,
        instanceId,
        podId,
        payload: { ...payload, podId: String(podId) },
      })
      : payload;

    // Memory-changed cue applies to message-driven events only. Heartbeat
    // already has the HEARTBEAT.md trailer (Phase 2.J) telling agents to
    // pull memory; double-cueing inflates the prompt for no benefit.
    const memoryCuedPayload = (type === 'chat.mention' || type === 'thread.mention')
      ? await this.prependMemoryCue(agentName, instanceId, baseEventPayload)
      : baseEventPayload;
    const eventPayload = type === 'heartbeat'
      ? await this.prependTaskUpdateCue(agentName, instanceId, podId, memoryCuedPayload)
      : memoryCuedPayload;

    // Pre-resolve the installation to decide routing. Native-runtime
    // installations skip the external event queue entirely and run the agent
    // loop in-process instead. Non-native installations continue to land in
    // the pending queue exactly as before.
    let nativeInstallation: InstallationDoc | null = null;
    try {
      nativeInstallation = await this.resolveInProcessInstallation(agentName, instanceId, podId);
    } catch (lookupErr) {
      console.warn(
        '[native-runtime] routing lookup failed, falling back to external queue:',
        (lookupErr as Error).message,
      );
    }
    // A digest is data for a later turn, not a turn on its own. Native
    // installations must leave it pending just like external installations.
    const routedToNative = Boolean(nativeInstallation) && deliveryMode === 'wake';

    const event = await AgentEvent.create({
      agentName: agentName.toLowerCase(),
      instanceId,
      podId,
      type,
      payload: eventPayload,
      ...(deliveryMode === 'digest' ? { deliveryMode } : {}),
      // Native runs resolve in-process, so the event is claimed at creation
      // rather than polled. `attempts: 1` because this IS its one delivery —
      // the claim in list() never runs for native events, and a native event
      // reaching a driver with attempts: 0 would misreport the same way an
      // external redelivery used to.
      //
      // This used to read "never sits in the pending queue polled by external
      // runtimes." That was true when written and false from the moment the
      // Task #67 requeue shipped: 'delivered' with no terminal transition is
      // precisely the requeue's target population, so every native event
      // entered the pending queue ~10-20 min after creation, guaranteed. The
      // settle handlers below close it — success acks, failure records.
      ...(routedToNative
        ? {
          status: 'delivered',
          deliveredAt: new Date(),
          attempts: 1,
          deliveryNonce: mintDeliveryNonce(),
        }
        : {}),
    }) as EventDoc;

    if (routedToNative && nativeInstallation) {
      this.dispatchInProcess(event, nativeInstallation, agentName, instanceId, type);
    }

    this.logEventLifecycle('enqueued', {
      eventId: String((event._id as { toString?: () => string })?.toString?.() || ''),
      agentName: event.agentName || '',
      instanceId: event.instanceId || '',
      podId: String((event.podId as { toString?: () => string })?.toString?.() || ''),
      type: event.type || '',
      deliveryMode: event.deliveryMode || 'wake',
      trigger: event.payload?.trigger,
      status: event.status,
      attempts: event.attempts,
    });

    const wsService = getWebSocketService();
    if (wsService && deliveryMode === 'wake') {
      wsService.pushEvent({
        _id: event._id,
        agentName: event.agentName,
        instanceId: event.instanceId,
        podId: event.podId,
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt,
        // D6: present only for a native event, which is born 'delivered' and
        // therefore already claimed. For every other route this push fires
        // while the event is still 'pending' — no claim has happened, so no
        // nonce exists and none can be invented here. The push is a wake
        // signal, not a delivery: a WS driver still fetches through list(),
        // and that claim is what hands it the deliveryId to ack with.
        ...(event.deliveryNonce ? { deliveryId: event.deliveryNonce } : {}),
      });
    }

    // (Typing indicator no longer fires at enqueue-time. It now fires
    // when the gateway actually fetches the event via GET /events —
    // a much closer signal to "the agent is really processing this
    // right now" instead of "an event is queued and may sit forever
    // if the gateway is dead." Typing_stop is still emitted when
    // AgentMessageService.postMessage runs.)

    // Query from the persisted event and coerce the identifier to a scalar
    // before it reaches Mongo. Callers of enqueue may supply a runtime payload.
    const webhookPodId = String(event.podId || '');
    if (deliveryMode === 'wake' && Types.ObjectId.isValid(webhookPodId)) AgentInstallation.find({
      agentName: String(event.agentName || ''),
      instanceId: String(event.instanceId || 'default'),
      podId: new Types.ObjectId(webhookPodId),
      status: 'active',
    }).lean().then((installations: InstallationDoc[]) => {
      for (const inst of installations) {
        const runtimeConfig = (normalizeConfig(inst.config)?.runtime || {}) as Record<string, unknown>;
        if (runtimeConfig.webhookUrl) {
          deliverEventViaWebhook(inst, event);
        }
      }
    }).catch((err: Error) => {
      console.warn('[webhook] Failed to look up webhook installations:', err.message);
    });

    return event;
  }

  // ADR-012 §3 + §10.2: fetch is mutate-on-claim. Today's `pending → delivered`
  // transition happens here at fetch time (was at acknowledge); the caller
  // confirms processing later via `acknowledge`, which now transitions
  // `delivered → acked`. This three-state lifecycle is what makes the
  // memoryRevisionAtDelivery snapshot survive the fetch→ack window without
  // trusting the client to echo it.
  //
  // Concurrency: if two pollers race the same event, only one wins the
  // `pending → delivered` flip on findOneAndUpdate; the loser sees `null`
  // and moves on. AgentMemory.revision is read once per fetch batch (the
  // revision captured per event reflects the moment of claim, not the moment
  // of fetch-batch-start; bounded staleness — see ADR-012 §3 last paragraph).
  static async list(options: ListOptions): Promise<EventDoc[]> {
    // Legacy consumers intentionally replay across every pod in their access
    // scope. The one-pod partition is opt-in through listInboxPage(), for any
    // HTTP poller whose batch becomes one pod-contextual model turn.
    const events = (await this.claimPage(options)).events;
    const seenPods = new Set<string>();
    for (const event of events) {
      const podKey = String(event.podId || '');
      if (!podKey || seenPods.has(podKey)) continue;
      seenPods.add(podKey);
      // eslint-disable-next-line no-await-in-loop -- attach once per distinct pod
      await this.attachLegacyDigest(event).catch((err: Error) => {
        console.warn('[agent-event] legacy digest attachment failed:', err.message);
      });
    }
    return events;
  }

  // The HTTP poller needs the true pending count for its inbox header even
  // when it copies only a bounded number of event bodies into one turn.
  static async listInboxPage(options: ListOptions): Promise<InboxPage> {
    return this.claimPage(options, { onePod: true, includeInboxCount: true });
  }

  private static async claimPage({
    agentName, podId, podIds, limit = 20, instanceId = 'default',
  }: ListOptions, { onePod = false, includeInboxCount = false } = {}): Promise<InboxPage> {
    // Coerce caller-supplied identifiers to plain strings before they reach
    // any Mongo query — guards against NoSQL-injection-shaped inputs (e.g.
    // `{$ne: null}`) sneaking through. CodeQL flags any data flow from
    // `agentName`/`instanceId` (declared as `string` in ListOptions but
    // origin-tracked from req.params) into a query without an explicit
    // sanitizer; the String() casts are that sanitizer.
    const safeAgentName = String(agentName || '').toLowerCase();
    const safeInstanceId = String(instanceId || 'default');
    // An explicit empty access set means the caller has no currently visible
    // pods. It must not fall through to an identity-wide inbox query after an
    // installation or pod membership was removed between enqueue and drain.
    if (Array.isArray(podIds) && podIds.length === 0 && !podId) {
      return { events: [], inboxCount: 0 };
    }
    const query: Record<string, unknown> = {
      agentName: safeAgentName,
      instanceId: safeInstanceId,
      status: 'pending',
    };

    if (podIds && Array.isArray(podIds) && podIds.length > 0) {
      query.podId = { $in: podIds };
    } else if (podId) {
      query.podId = podId;
    }

    let batchQuery = query;
    let inboxCount = 0;
    if (onePod) {
      // An agent's inbox is scoped to a place. Pick its oldest pending event,
      // then claim a batch from THAT pod only. Returning a mixed-pod batch
      // would force a driver to either leak one pod's context into another or
      // launch multiple turns after having marked all of them delivered — the
      // over-claim/requeue failure ADR-024 D3 was written to remove.
      //
      // This first read is deliberately non-mutating. The conditional updates
      // below remain the claim: a sibling poller may still win either the head
      // or any later candidate, in which case it is filtered out normally.
      // `podId` is required by the schema, but legacy/corrupt rows can still
      // exist in Mongo. Never let one become the chronological head: it has
      // no safe one-pod partition and would otherwise strand this inbox
      // behind a row no poller can process. Keep the caller's scope inside
      // the same `$and` so this exclusion only narrows access.
      const headQuery = {
        $and: [query, { podId: { $exists: true, $ne: null } }, { deliveryMode: { $ne: 'digest' } }],
      };
      const [head] = await AgentEvent.find(headQuery)
        .sort({ createdAt: 1 })
        .limit(1)
        .select({ _id: 1, podId: 1 })
        .lean() as Array<{ _id: unknown, podId?: unknown }>;

      if (!head) return { events: [], inboxCount: 0 };

      // `head` came from the already-access-checked and pod-qualified query
      // above, so replacing a possible `$in` pod filter with its stored pod id
      // narrows rather than widens the caller's scope.
      batchQuery = { ...query, podId: head.podId };
      // Count before this driver's conditional claims. The number is advisory
      // metadata (other pollers may win a race immediately after it), but it
      // is truthful at the batch boundary and never crosses pod boundaries.
      inboxCount = await AgentEvent.countDocuments(batchQuery);
    }

    const wakeQuery = { ...batchQuery, deliveryMode: { $ne: 'digest' } };
    const wakeCandidates = await AgentEvent.find(wakeQuery)
      .sort({ createdAt: 1 })
      .limit(limit)
      .select({ _id: 1 })
      .lean() as Array<{ _id: unknown }>;
    // Digest rows are only claimed alongside a wake in the same pod. Reserve
    // a slot for wake work so a long digest backlog cannot starve the turn.
    const digestCandidates = onePod && wakeCandidates.length > 0 && wakeCandidates.length < limit
      ? await AgentEvent.find({ ...batchQuery, deliveryMode: 'digest' })
        .sort({ createdAt: 1 })
        .limit(limit - wakeCandidates.length)
        .select({ _id: 1 })
        .lean() as Array<{ _id: unknown }>
      : [];
    const candidates = [...wakeCandidates, ...digestCandidates];

    // A sibling poller can claim every candidate after our pre-claim count.
    // The page is empty, but the count still describes what this reader saw
    // at the batch boundary; returning zero would falsely say the inbox was
    // empty under contention.
    if (candidates.length === 0) return { events: [], inboxCount };

    // Read AgentMemory once for the digest bundle. The envelope captured here
    // reflects the state at the moment of claim — close enough to the per-doc
    // claim moments that drift is bounded. memoryRevisionAtDelivery written
    // onto each AgentEvent doc captures the revision at THIS read; the ack
    // path bumps lastSeenRevision via $max to that captured value.
    const memoryDoc = await AgentMemory.findOne({
      agentName: safeAgentName,
      instanceId: safeInstanceId,
    })
      .select({ revision: 1, lastSeenRevision: 1, sections: 1 })
      .lean() as { revision?: number; lastSeenRevision?: number; sections?: unknown } | null;
    const currentRevision = memoryDoc?.revision ?? 0;
    const lastSeenRevision = memoryDoc?.lastSeenRevision ?? 0;
    const digestBundle = buildMemoryDigestBundle(memoryDoc || {}, lastSeenRevision);

    const claimed: EventDoc[] = [];
    for (const [index, candidate] of candidates.entries()) {
      // Another poller may win every wake after our read. In that race the
      // digest must remain pending instead of being claimed on its own.
      if (onePod && index >= wakeCandidates.length && claimed.length === 0) break;
      // Coerce candidate _id to string before it lands in the query — Mongo
      // accepts both string and ObjectId, and `unknown`-typed values are the
      // CodeQL trip wire. The find() above scopes by agentName + instanceId
      // so even if the _id were tampered with, the query is bounded.
      const safeId = candidate._id != null ? String(candidate._id) : '';
      if (!safeId) continue;
      // ADR-004 §Event model: "Unacked events stay in the queue and re-deliver
      // on next poll, with `attempts` incremented." The claim IS the delivery,
      // so this is the only site that can honour that sentence — and until it
      // did, `attempts` was a frozen 0 on every payload the kernel has ever
      // served. CAP obliges drivers to be idempotent using what we send them;
      // a counter that never moves tells a driver every redelivery is a first
      // delivery. It also made `attempts < cap` in garbageCollect() a guard on
      // a variable nothing wrote — structurally unable to fire.
      //
      // `attempts` therefore counts DELIVERIES, not lifecycle transitions:
      // first claim is 1, a requeued redelivery is 2. `{new: true}` means the
      // value the driver receives in the payload is the post-increment one.
      const updated = await AgentEvent.findOneAndUpdate(
        { _id: safeId, status: 'pending' },
        {
          $set: {
            status: 'delivered',
            memoryRevisionAtDelivery: currentRevision,
            deliveredAt: new Date(),
            // D6: this claim's identity. A requeue clears it, so the child
            // this delivery belongs to is the only one whose ack can land.
            deliveryNonce: mintDeliveryNonce(),
          },
          // Digest is context for another turn. A refused wake can attach the
          // same digest repeatedly without consuming it, so charging those
          // attachments against the poison-event attempt cap would lose it.
          ...(index < wakeCandidates.length ? { $inc: { attempts: 1 } } : {}),
        },
        { new: true },
      ).lean() as EventDoc | null;
      if (updated) claimed.push(updated);
    }

    const firstWake = claimed.find((event) => event.deliveryMode !== 'digest');
    const foldedRollup = onePod && firstWake
      ? await this.attachFoldedDigest(firstWake).catch((err: Error) => {
        console.warn('[agent-event] folded digest attachment failed:', err.message);
        return null;
      })
      : null;
    const events = claimed.map((event) => {
      const messageId = event?.payload?.messageId;
      const basePayload = event?.payload || {};
      // Spread digest bundle into payload. Each sub-field is undefined when
      // empty so JSON.stringify omits it — agents on un-adopted runtimes see
      // a payload that's structurally unchanged.
      const enrichedPayload: Record<string, unknown> = {
        ...basePayload,
        ...digestBundle,
        ...(foldedRollup && event._id === firstWake?._id ? { digestRollup: foldedRollup } : {}),
        // ADR-026 D6: the driver echoes this back on ack. Additive — a driver
        // that ignores it still acks successfully during the migration window
        // described on acknowledge().
        ...(event?.deliveryNonce ? { deliveryId: event.deliveryNonce } : {}),
      };
      if (messageId !== undefined && messageId !== null && typeof messageId !== 'string') {
        enrichedPayload.messageId = String(messageId);
      }
      return { ...event, payload: enrichedPayload };
    });
    return { events, inboxCount: includeInboxCount ? inboxCount : events.length };
  }

  // ADR-012 §3: acknowledge is status-gated. Lifecycle:
  //   pending → delivered (on `list()` claim)
  //   delivered → acked (here)
  //   pending → acked  is also accepted (legacy callers that ack before
  //                     fetching, e.g. summary/system flows that synthesize
  //                     events and immediately mark them done)
  // Acked is terminal; double-ack short-circuits without re-bumping
  // lastSeenRevision (idempotent by status-gate).
  static async acknowledge(
    eventId: unknown,
    agentName: string,
    instanceId = 'default',
    delivery: DeliveryMeta | null = null,
    deliveryId: unknown = null,
    consumer: string | null = null,
  ): Promise<EventDoc | null> {
    // Same NoSQL-injection guard as list() — coerce all caller-supplied query
    // inputs to plain primitives before they reach Mongo.
    const safeEventId = eventId != null ? String(eventId) : '';
    if (!safeEventId) return null;
    const safeAgentName = String(agentName || '').toLowerCase();
    const safeInstanceId = String(instanceId || 'default');
    const normalizedDelivery = this.normalizeDeliveryMeta(delivery || {});
    // ADR-026 D6 — WHICH delivery is being acked.
    //
    // Until this existed the filter below identified an event but not a
    // delivery, so after the 10-minute requeue a stale child's late ack
    // matched the NEW child's delivery: both had already spawned, both ran
    // the turn, and the lastSeenRevision bump used the stale child's
    // snapshot. Daemon restart (ADR-026) makes that sequence routine.
    //
    // Migration, deliberately two-phase: every driver in the fleet acks
    // without a nonce today — the openclaw extension, @commonlyai/mcp,
    // cloud-codex, the webhook SDK, the wrapper CLI. Requiring it on day one
    // breaks all of them at once. So a presented nonce MUST match, and an
    // absent one is accepted and counted. Phase B flips `absent` to a refusal
    // only once that counter is zero AT THE CONSUMERS — publishing a client
    // is not deploying one (AX 34).
    const safeDeliveryId = typeof deliveryId === 'string' && deliveryId ? deliveryId : null;
    const safeConsumer = String(consumer || 'unknown').toLowerCase();
    if (safeDeliveryId) {
      ackNonceStats.withNonce += 1;
    } else {
      ackNonceStats.withoutNonce += 1;
      ackNonceStats.withoutNonceByConsumer[safeConsumer] = (ackNonceStats.withoutNonceByConsumer[safeConsumer] || 0) + 1;
      console.warn(
        `[agent-event] ack without deliveryId from ${safeAgentName}:${safeInstanceId} via ${safeConsumer} — pre-D6 driver`,
      );
      // Per-consumer: an unlisted consumer stays on Phase A even while others
      // enforce, so a parked path cannot hold the flip hostage.
      if (requireDeliveryNonce(safeConsumer)) return null;
    }
    const result = await AgentEvent.findOneAndUpdate(
      {
        _id: safeEventId,
        agentName: safeAgentName,
        instanceId: safeInstanceId,
        status: { $in: ['pending', 'delivered'] },
        ...(safeDeliveryId ? { deliveryNonce: safeDeliveryId } : {}),
      },
      {
        $set: {
          status: 'acked',
          deliveredAt: new Date(),
          deliveryNonce: null,
          ...(normalizedDelivery ? { delivery: normalizedDelivery } : {}),
        },
        // No $inc here. `attempts` counts deliveries (incremented at the claim
        // in list()); an ack is not a delivery. Incrementing at both sites made
        // a normally-handled event read `attempts: 2` and left the field
        // meaning "deliveries plus terminal transitions" — a number no driver
        // can use for the ADR-004 dedup it is obliged to perform.
      },
      { new: true },
    ) as EventDoc | null;

    const consumedDigest = !normalizedDelivery
      || normalizedDelivery.outcome === 'posted'
      || normalizedDelivery.outcome === 'acknowledged'
      || (normalizedDelivery.outcome === 'no_action' && !normalizedDelivery.reason);
    if (result && consumedDigest) {
      if (result.digestEventIds?.length) {
        await this.settleLegacyDigest(result).catch((err: Error) => {
          console.warn('[agent-event] legacy digest settle failed:', err.message);
        });
      } else if (result.digestRollupRevision) {
        await settleFoldedDigest(
          { agentName: safeAgentName, instanceId: safeInstanceId, podId: result.podId },
          result.digestRollupRevision,
        ).catch((err: Error) => {
          console.warn('[agent-event] folded digest settle failed:', err.message);
        });
      }
    }

    // ADR-012 §3: bump lastSeenRevision exactly once per event via $max.
    // First-ack only: the status-gate above ensures result is non-null only
    // on the winning ack. memoryRevisionAtDelivery was captured at fetch
    // time (`list()`); this update brings the agent's read-checkpoint up
    // to that revision. $max makes it monotone — out-of-order acks across
    // events still converge correctly.
    if (result && consumedDigest
      && typeof result.memoryRevisionAtDelivery === 'number' && result.memoryRevisionAtDelivery > 0) {
      try {
        await AgentMemory.updateOne(
          { agentName: safeAgentName, instanceId: safeInstanceId },
          { $max: { lastSeenRevision: result.memoryRevisionAtDelivery } },
        );
      } catch (err) {
        // Non-fatal — the next ack with a higher memoryRevisionAtDelivery
        // will still bump correctly. Log for ops visibility.
        console.warn(
          '[agent-event] lastSeenRevision $max bump failed:',
          (err as Error).message,
        );
      }
    }

    this.logEventLifecycle('acknowledged', {
      eventId: String((eventId as { toString?: () => string })?.toString?.() || eventId),
      agentName: agentName.toLowerCase(),
      instanceId,
      podId: String((result?.podId as { toString?: () => string })?.toString?.() || ''),
      type: result?.type || '',
      deliveryMode: result?.deliveryMode || 'wake',
      trigger: result?.payload?.trigger,
      status: result?.status || 'acked',
      attempts: result?.attempts,
      error: result?.delivery?.reason && result?.delivery?.outcome === 'error'
        ? result.delivery.reason
        : undefined,
    });

    if (result && normalizedDelivery && this.shouldAttemptContextOverflowRecovery(normalizedDelivery)) {
      try {
        const recovery = await this.recoverContextOverflow(result, normalizedDelivery);
        this.logEventLifecycle('context_overflow_recovery', {
          eventId: String((eventId as { toString?: () => string })?.toString?.() || eventId),
          agentName: agentName.toLowerCase(),
          instanceId,
          podId: String((result?.podId as { toString?: () => string })?.toString?.() || ''),
          type: result?.type || '',
          trigger: result?.payload?.trigger,
          status: recovery?.recovered ? 'recovered' : 'skipped',
          error: recovery?.recovered ? undefined : recovery?.reason,
        });
      } catch (recoveryError) {
        this.logEventLifecycle('context_overflow_recovery_failed', {
          eventId: String((eventId as { toString?: () => string })?.toString?.() || eventId),
          agentName: agentName.toLowerCase(),
          instanceId,
          podId: String((result?.podId as { toString?: () => string })?.toString?.() || ''),
          type: result?.type || '',
          trigger: result?.payload?.trigger,
          status: 'failed',
          error: (recoveryError as Error).message,
        });
      }
    }

    return result;
  }

  // Did this ack lose to a requeue? Only meaningful when the caller presented
  // a deliveryId and the gated update matched nothing: the event may be gone,
  // already acked, or still live under a NEWER nonce. Only the last of those
  // means "you were superseded — stop working", and a driver cannot act on
  // that distinction unless we make it.
  static async isSupersededDelivery(
    eventId: unknown,
    agentName: string,
    instanceId: string,
    deliveryId: unknown,
  ): Promise<boolean> {
    const safeEventId = eventId != null ? String(eventId) : '';
    const safeDeliveryId = typeof deliveryId === 'string' && deliveryId ? deliveryId : null;
    if (!safeEventId || !safeDeliveryId) return false;
    const event = await AgentEvent.findOne({
      _id: safeEventId,
      agentName: String(agentName || '').toLowerCase(),
      instanceId: String(instanceId || 'default'),
    }).select('status deliveryNonce').lean() as { status?: string; deliveryNonce?: string | null } | null;
    if (!event) return false;
    if (event.status === 'acked' || event.status === 'failed') return false;
    return event.deliveryNonce !== safeDeliveryId;
  }

  static async markPosted(
    eventId: unknown,
    agentName: string,
    instanceId = 'default',
    { messageId }: { messageId?: string } = {},
  ): Promise<EventDoc | null> {
    if (!eventId) return null;
    // `eventId` arrives from agent-supplied metadata (postMessage's
    // sourceEventId), so an object like {$ne: null} must never reach the
    // query position. The typeof gate — not just String() — is deliberate:
    // it rejects operator objects outright, and it is the barrier shape the
    // js/sql-injection query recognizes. Same entrance-taint pattern as
    // personaHireService.
    if (typeof eventId !== 'string' && typeof eventId !== 'number') return null;
    const eventIdStr = String(eventId);
    // Same gate for the co-tenants of the query object: every operand of a
    // Mongo filter built from caller input must be a primitive by
    // construction, not by trust in the call site.
    const safeAgentName = typeof agentName === 'string' ? agentName.toLowerCase() : '';
    const safeInstanceId = typeof instanceId === 'string' ? instanceId : 'default';
    // `status: 'delivered'` is load-bearing, not defensive. Ungated, this
    // write returned an already-terminal event to 'delivered' with a fresh
    // deliveredAt — exactly the requeue's target population (garbageCollect
    // selects status 'delivered' by deliveredAt age), so posting a second
    // message citing a completed event re-delivered it. Same class as the
    // webhook duplicate-delivery bug described at deliverEventViaWebhook, on
    // the path that fix did not cover.
    //
    // `$ne: 'acked'` was the first attempt and was too loose in two ways
    // (found in review): a stale child posting after a requeue flipped
    // 'pending' back to 'delivered' with a null nonce, hiding the event from
    // list() for another full requeue window; and a 'failed' event retired by
    // the attempt cap could be resurrected the same way. Annotating a
    // delivery only makes sense while one is in flight, so the predicate is
    // the positive state, not the absence of the terminal one.
    //
    // It deliberately does NOT mint a delivery nonce. This is an annotation
    // of the delivery already in flight, not a new claim — minting here would
    // invalidate the nonce held by the very child that just posted, and its
    // ack would then be refused as stale. Only a claim mints.
    return AgentEvent.findOneAndUpdate(
      {
        _id: eventIdStr,
        agentName: safeAgentName,
        instanceId: safeInstanceId,
        status: 'delivered',
      },
      {
        $set: {
          status: 'delivered',
          deliveredAt: new Date(),
          delivery: {
            outcome: 'posted',
            reason: 'message_posted',
            messageId: messageId ? String(messageId) : undefined,
            updatedAt: new Date(),
          },
        },
      },
      { new: true },
    ) as Promise<EventDoc | null>;
  }

  static async recordFailure(
    eventId: unknown,
    agentName: string,
    instanceId: string,
    errorMessage: string,
    deliveryId: unknown = null,
  ): Promise<EventDoc | null> {
    // D6, same reasoning as acknowledge(): failing is as terminal as acking,
    // so a stale runner's failure must not retire a delivery that now belongs
    // to its replacement. Match-if-present for the same migration reason —
    // callers that pass nothing behave exactly as before.
    const safeDeliveryId = typeof deliveryId === 'string' && deliveryId ? deliveryId : null;
    const result = await AgentEvent.findOneAndUpdate(
      {
        _id: eventId,
        agentName: agentName.toLowerCase(),
        instanceId,
        // Terminal states are terminal in both directions: without this, a
        // late failure from a runner nobody is waiting for overwrites an
        // event that was already acked (review on #1347).
        status: { $in: ['pending', 'delivered'] },
        ...(safeDeliveryId ? { deliveryNonce: safeDeliveryId } : {}),
      },
      // No $inc — see acknowledge(). `attempts` is a delivery counter owned by
      // the claim in list(); a terminal transition must not inflate it.
      { $set: { status: 'failed', error: errorMessage, deliveryNonce: null } },
      { new: true },
    ) as EventDoc | null;

    this.logEventLifecycle('failed', {
      eventId: String((eventId as { toString?: () => string })?.toString?.() || eventId),
      agentName: agentName.toLowerCase(),
      instanceId,
      podId: String((result?.podId as { toString?: () => string })?.toString?.() || ''),
      type: result?.type || '',
      trigger: result?.payload?.trigger,
      status: result?.status || 'failed',
      attempts: result?.attempts,
      error: errorMessage,
    });

    return result;
  }
}

// Re-export the typing helper so the runtime events endpoint can fire
// the indicator only when the gateway actually fetches an event — a
// much truer "the agent is processing this right now" signal than
// "the event was enqueued and may sit waiting."
export { signalAgentTyping };
export default AgentEventService;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
