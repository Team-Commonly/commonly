import crypto from 'crypto';
import Task from '../models/Task';

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

interface EventDoc {
  _id?: unknown;
  type?: string;
  podId?: unknown;
  agentName?: string;
  instanceId?: string;
  createdAt?: Date;
  payload?: Record<string, unknown>;
  status?: string;
  attempts?: number;
  delivery?: DeliveryMeta;
  memoryRevisionAtDelivery?: number | null;
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
  deliveredRetentionHours: number;
  failedRetentionHours: number;
  requeuedDelivered?: number;
  requeueDeliveredMinutes?: number;
  // Events that hit the requeue cap and were retired to the terminal 'failed'
  // state. Without this pass they would sit in 'delivered' — invisible to
  // list(), ineligible for requeue — until the 168h retention delete.
  expiredDelivered?: number;
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
}

interface ListOptions {
  agentName: string;
  podId?: unknown;
  podIds?: unknown[];
  limit?: number;
  instanceId?: string;
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Commonly-Event': event.type || '',
        'X-Commonly-Delivery': String(event._id),
        ...(signature ? { 'X-Commonly-Signature': signature } : {}),
      },
      body: payload,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[webhook] ${event.agentName} ${webhookUrl} → HTTP ${res.status}`);
      return;
    }

    let response: Record<string, unknown> = {};
    try { response = await res.json() as Record<string, unknown>; } catch (_) { /* no body is fine */ }

    const { outcome = 'acknowledged', content } = response as { outcome?: string; content?: string };

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
    try {
      const requeueResult = await AgentEvent.updateMany(
        {
          status: 'delivered',
          deliveredAt: { $lt: requeueThreshold },
          $or: [{ attempts: { $lt: attemptCap } }, { attempts: { $exists: false } }],
        },
        {
          $set: { status: 'pending', deliveredAt: null },
        },
      ) as { modifiedCount?: number };
      requeuedDelivered = requeueResult?.modifiedCount || 0;
      if (requeuedDelivered > 0) {
        console.log(`[agent-event] requeued ${requeuedDelivered} stuck 'delivered' events older than ${requeueDeliveredMinutes}min`);
      }

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
    const [pendingResult, deliveredResult, failedResult] = await Promise.all([
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
      AgentEvent.deleteMany({ status: 'pending', createdAt: { $lt: deliveredThreshold } }),
      AgentEvent.deleteMany({ status: { $in: ['delivered', 'acked'] }, createdAt: { $lt: deliveredThreshold } }),
      AgentEvent.deleteMany({ status: 'failed', createdAt: { $lt: failedThreshold } }),
    ]) as Array<{ deletedCount?: number }>;

    const deletedPending = pendingResult?.deletedCount || 0;
    const deletedDelivered = deliveredResult?.deletedCount || 0;
    const deletedFailed = failedResult?.deletedCount || 0;

    return {
      deletedPending,
      deletedDelivered,
      deletedFailed,
      totalDeleted: deletedPending + deletedDelivered + deletedFailed,
      deliveredRetentionHours: Math.max(deliveredRetentionHours, 1),
      failedRetentionHours: Math.max(failedRetentionHours, 1),
      requeuedDelivered,
      requeueDeliveredMinutes: Math.max(requeueDeliveredMinutes, 1),
      expiredDelivered,
    };
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

  static async enqueue({
    agentName, podId, type, payload = {}, instanceId = 'default',
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
    let routedToNative = false;
    let nativeInstallation: InstallationDoc | null = null;
    try {
      const installationDoc = await AgentInstallation.findOne({
        agentName: agentName.toLowerCase(),
        instanceId,
        podId,
        status: 'active',
      }).lean() as InstallationDoc | null;
      if (installationDoc) {
        const installationRuntimeCfg = (normalizeConfig(installationDoc.config)?.runtime || {}) as Record<string, unknown>;
        const installationRuntimeType = String(installationRuntimeCfg.runtimeType || '').toLowerCase();
        if (installationRuntimeType === 'native') {
          routedToNative = true;
          nativeInstallation = installationDoc;
        }
      }
    } catch (lookupErr) {
      console.warn(
        '[native-runtime] routing lookup failed, falling back to external queue:',
        (lookupErr as Error).message,
      );
    }

    const event = await AgentEvent.create({
      agentName: agentName.toLowerCase(),
      instanceId,
      podId,
      type,
      payload: eventPayload,
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
        ? { status: 'delivered', deliveredAt: new Date(), attempts: 1 }
        : {}),
    }) as EventDoc;

    if (routedToNative && nativeInstallation) {
      try {
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const { runAgent } = require('./nativeRuntimeService');
        const eventIdStr = String((event._id as { toString?: () => string })?.toString?.() || '');
        // Fire-and-forget — callers of enqueue() must never block on the
        // loop. Errors are logged but never rethrown.
        // Settle the event on the run's actual outcome. nativeRuntimeService
        // contains no ack or recordFailure call of its own, so before this the
        // native lifecycle had no terminal state at all: every native event
        // stayed 'delivered' forever and was structurally unackable. Doing it
        // here rather than inside runAgent keeps the terminal transition next
        // to the non-terminal state that created it.
        Promise.resolve(runAgent(nativeInstallation, {
          type,
          eventId: eventIdStr,
          payload: event.payload,
        // Two-argument .then, deliberately, NOT .then().catch(): a chained
        // .catch would also catch a rejection thrown by the success handler,
        // so a failing acknowledge() would fall through and mark a run that
        // actually succeeded as 'failed'. The rejection handler here is scoped
        // to runAgent alone. Both terminal calls swallow their own errors so
        // this stays fire-and-forget for the caller.
        })).then(
          () => this.acknowledge(
            eventIdStr,
            agentName,
            instanceId,
            { outcome: 'acknowledged', reason: 'native-runtime-completed' },
          ).catch((ackErr: Error) => {
            console.warn('[native-runtime] ack after successful run failed:', ackErr?.message || ackErr);
          }),
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

    this.logEventLifecycle('enqueued', {
      eventId: String((event._id as { toString?: () => string })?.toString?.() || ''),
      agentName: event.agentName || '',
      instanceId: event.instanceId || '',
      podId: String((event.podId as { toString?: () => string })?.toString?.() || ''),
      type: event.type || '',
      trigger: event.payload?.trigger,
      status: event.status,
      attempts: event.attempts,
    });

    const wsService = getWebSocketService();
    if (wsService) {
      wsService.pushEvent({
        _id: event._id,
        agentName: event.agentName,
        instanceId: event.instanceId,
        podId: event.podId,
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt,
      });
    }

    // (Typing indicator no longer fires at enqueue-time. It now fires
    // when the gateway actually fetches the event via GET /events —
    // a much closer signal to "the agent is really processing this
    // right now" instead of "an event is queued and may sit forever
    // if the gateway is dead." Typing_stop is still emitted when
    // AgentMessageService.postMessage runs.)

    AgentInstallation.find({
      agentName: event.agentName,
      instanceId,
      podId,
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
  static async list({
    agentName, podId, podIds, limit = 20, instanceId = 'default',
  }: ListOptions): Promise<EventDoc[]> {
    // Coerce caller-supplied identifiers to plain strings before they reach
    // any Mongo query — guards against NoSQL-injection-shaped inputs (e.g.
    // `{$ne: null}`) sneaking through. CodeQL flags any data flow from
    // `agentName`/`instanceId` (declared as `string` in ListOptions but
    // origin-tracked from req.params) into a query without an explicit
    // sanitizer; the String() casts are that sanitizer.
    const safeAgentName = String(agentName || '').toLowerCase();
    const safeInstanceId = String(instanceId || 'default');
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

    // First collect candidate _ids (non-mutating). We then claim them one by
    // one with status-gated findOneAndUpdate so concurrent pollers can't
    // double-claim. Limit applies to candidates; the actually-claimed set may
    // be smaller if a sibling poller wins some races.
    const candidates = await AgentEvent.find(query)
      .sort({ createdAt: 1 })
      .limit(limit)
      .select({ _id: 1 })
      .lean() as Array<{ _id: unknown }>;

    if (candidates.length === 0) return [];

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
    for (const candidate of candidates) {
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
          },
          $inc: { attempts: 1 },
        },
        { new: true },
      ).lean() as EventDoc | null;
      if (updated) claimed.push(updated);
    }

    return claimed.map((event) => {
      const messageId = event?.payload?.messageId;
      const basePayload = event?.payload || {};
      // Spread digest bundle into payload. Each sub-field is undefined when
      // empty so JSON.stringify omits it — agents on un-adopted runtimes see
      // a payload that's structurally unchanged.
      const enrichedPayload: Record<string, unknown> = {
        ...basePayload,
        ...digestBundle,
      };
      if (messageId !== undefined && messageId !== null && typeof messageId !== 'string') {
        enrichedPayload.messageId = String(messageId);
      }
      return { ...event, payload: enrichedPayload };
    });
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
  ): Promise<EventDoc | null> {
    // Same NoSQL-injection guard as list() — coerce all caller-supplied query
    // inputs to plain primitives before they reach Mongo.
    const safeEventId = eventId != null ? String(eventId) : '';
    if (!safeEventId) return null;
    const safeAgentName = String(agentName || '').toLowerCase();
    const safeInstanceId = String(instanceId || 'default');
    const normalizedDelivery = this.normalizeDeliveryMeta(delivery || {});
    const result = await AgentEvent.findOneAndUpdate(
      {
        _id: safeEventId,
        agentName: safeAgentName,
        instanceId: safeInstanceId,
        status: { $in: ['pending', 'delivered'] },
      },
      {
        $set: {
          status: 'acked',
          deliveredAt: new Date(),
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

    // ADR-012 §3: bump lastSeenRevision exactly once per event via $max.
    // First-ack only: the status-gate above ensures result is non-null only
    // on the winning ack. memoryRevisionAtDelivery was captured at fetch
    // time (`list()`); this update brings the agent's read-checkpoint up
    // to that revision. $max makes it monotone — out-of-order acks across
    // events still converge correctly.
    if (result && typeof result.memoryRevisionAtDelivery === 'number' && result.memoryRevisionAtDelivery > 0) {
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

  static async markPosted(
    eventId: unknown,
    agentName: string,
    instanceId = 'default',
    { messageId }: { messageId?: string } = {},
  ): Promise<EventDoc | null> {
    if (!eventId) return null;
    // `eventId` arrives from agent-supplied metadata (postMessage's
    // sourceEventId), so an object like {$ne: null} must never reach the
    // query position — String() collapses any operator payload into a
    // literal that matches nothing. Taint boundary at the entrance, same
    // pattern as personaHireService.
    const eventIdStr = String(eventId);
    return AgentEvent.findOneAndUpdate(
      { _id: eventIdStr, agentName: agentName.toLowerCase(), instanceId },
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
  ): Promise<EventDoc | null> {
    const result = await AgentEvent.findOneAndUpdate(
      { _id: eventId, agentName: agentName.toLowerCase(), instanceId },
      // No $inc — see acknowledge(). `attempts` is a delivery counter owned by
      // the claim in list(); a terminal transition must not inflate it.
      { $set: { status: 'failed', error: errorMessage } },
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
