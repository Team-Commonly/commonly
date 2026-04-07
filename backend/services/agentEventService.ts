import crypto from 'crypto';

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
  stalePendingMinutes?: number;
  deliveredRetentionHours?: number;
  failedRetentionHours?: number;
}

interface GarbageCollectResult {
  deletedPending: number;
  deletedDelivered: number;
  deletedFailed: number;
  totalDeleted: number;
  stalePendingMinutes: number;
  deliveredRetentionHours: number;
  failedRetentionHours: number;
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

    await AgentEvent.findByIdAndUpdate(event._id, {
      status: 'delivered',
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
    stalePendingMinutes = Number(process.env.AGENT_EVENT_STALE_PENDING_MINUTES || 30),
    deliveredRetentionHours = Number(process.env.AGENT_EVENT_DELIVERED_RETENTION_HOURS || 168),
    failedRetentionHours = Number(process.env.AGENT_EVENT_FAILED_RETENTION_HOURS || 168),
  }: GarbageCollectOptions = {}): Promise<GarbageCollectResult> {
    const now = Date.now();
    const stalePendingThreshold = new Date(now - (Math.max(stalePendingMinutes, 1) * 60 * 1000));
    const deliveredThreshold = new Date(now - (Math.max(deliveredRetentionHours, 1) * 60 * 60 * 1000));
    const failedThreshold = new Date(now - (Math.max(failedRetentionHours, 1) * 60 * 60 * 1000));

    const [pendingResult, deliveredResult, failedResult] = await Promise.all([
      AgentEvent.deleteMany({ status: 'pending', createdAt: { $lt: stalePendingThreshold } }),
      AgentEvent.deleteMany({ status: 'delivered', createdAt: { $lt: deliveredThreshold } }),
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
      stalePendingMinutes: Math.max(stalePendingMinutes, 1),
      deliveredRetentionHours: Math.max(deliveredRetentionHours, 1),
      failedRetentionHours: Math.max(failedRetentionHours, 1),
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

  static async enqueue({
    agentName, podId, type, payload = {}, instanceId = 'default',
  }: EnqueueOptions): Promise<EventDoc> {
    if (!agentName || !podId || !type) {
      throw new Error('agentName, podId, and type are required');
    }

    const eventPayload = type === 'heartbeat'
      ? await this.enrichHeartbeatPayload({
        agentName,
        instanceId,
        podId,
        payload: { ...payload, podId: String(podId) },
      })
      : payload;

    const event = await AgentEvent.create({
      agentName: agentName.toLowerCase(),
      instanceId,
      podId,
      type,
      payload: eventPayload,
    }) as EventDoc;

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

  static async list({
    agentName, podId, podIds, limit = 20, instanceId = 'default',
  }: ListOptions): Promise<EventDoc[]> {
    const query: Record<string, unknown> = {
      agentName: agentName.toLowerCase(),
      instanceId,
      status: 'pending',
    };

    if (podIds && Array.isArray(podIds) && podIds.length > 0) {
      query.podId = { $in: podIds };
    } else if (podId) {
      query.podId = podId;
    }

    const events = await AgentEvent.find(query)
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean() as EventDoc[];

    return (Array.isArray(events) ? events : []).map((event) => {
      const messageId = event?.payload?.messageId;
      if (messageId === undefined || messageId === null || typeof messageId === 'string') {
        return event;
      }
      return {
        ...event,
        payload: { ...event.payload, messageId: String(messageId) },
      };
    });
  }

  static async acknowledge(
    eventId: unknown,
    agentName: string,
    instanceId = 'default',
    delivery: DeliveryMeta | null = null,
  ): Promise<EventDoc | null> {
    const normalizedDelivery = this.normalizeDeliveryMeta(delivery || {});
    const result = await AgentEvent.findOneAndUpdate(
      { _id: eventId, agentName: agentName.toLowerCase(), instanceId },
      {
        $set: {
          status: 'delivered',
          deliveredAt: new Date(),
          ...(normalizedDelivery ? { delivery: normalizedDelivery } : {}),
        },
        $inc: { attempts: 1 },
      },
      { new: true },
    ) as EventDoc | null;

    this.logEventLifecycle('acknowledged', {
      eventId: String((eventId as { toString?: () => string })?.toString?.() || eventId),
      agentName: agentName.toLowerCase(),
      instanceId,
      podId: String((result?.podId as { toString?: () => string })?.toString?.() || ''),
      type: result?.type || '',
      trigger: result?.payload?.trigger,
      status: result?.status || 'delivered',
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
    return AgentEvent.findOneAndUpdate(
      { _id: eventId, agentName: agentName.toLowerCase(), instanceId },
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
      { $set: { status: 'failed', error: errorMessage }, $inc: { attempts: 1 } },
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

export default AgentEventService;
