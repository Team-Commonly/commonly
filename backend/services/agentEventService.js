const AgentEvent = require('../models/AgentEvent');
const { AgentInstallation } = require('../models/AgentRegistry');
const Integration = require('../models/Integration');
const Gateway = require('../models/Gateway');
const AgentIdentityService = require('./agentIdentityService');
const {
  getAgentSessionSizes,
  clearAgentRuntimeSessions,
  restartAgentRuntime,
  resolveOpenClawAccountId,
} = require('./agentProvisionerService');

// Lazy-loaded to avoid circular dependency
let agentWebSocketService = null;
const getWebSocketService = () => {
  if (!agentWebSocketService) {
    try {
      // eslint-disable-next-line global-require
      agentWebSocketService = require('./agentWebSocketService');
    } catch {
      agentWebSocketService = null;
    }
  }
  return agentWebSocketService;
};

class AgentEventService {
  static getContextOverflowRetryLimit() {
    const parsed = Number.parseInt(process.env.AGENT_CONTEXT_OVERFLOW_RETRY_LIMIT, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 1;
    return parsed;
  }

  static shouldRestartAfterSessionClear() {
    const raw = String(process.env.AGENT_CONTEXT_OVERFLOW_RESTART_AFTER_CLEAR || '1').trim().toLowerCase();
    return raw !== '0' && raw !== 'false' && raw !== 'no';
  }

  static getSessionResetIntervalHours() {
    const parsed = Number.parseInt(process.env.AGENT_RUNTIME_SESSION_RESET_HOURS, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 24;
    return Math.max(1, Math.min(168, Math.trunc(parsed)));
  }

  static isSessionResetDue(now = new Date()) {
    const intervalHours = this.getSessionResetIntervalHours();
    const hourBucket = Math.floor(now.getTime() / (60 * 60 * 1000));
    return hourBucket % intervalHours === 0;
  }

  static parseOverflowRetryCount(payload = {}) {
    const parsed = Number.parseInt(payload?._contextOverflowRetryCount, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
  }

  static detectContextOverflowText(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    return /context overflow|prompt too large|context length|max(imum)? context|token limit|too many tokens/i
      .test(text);
  }

  static shouldAttemptContextOverflowRecovery(delivery = {}) {
    if (!delivery || delivery.outcome !== 'error') return false;
    if (this.detectContextOverflowText(delivery.reason)) return true;
    return this.detectContextOverflowText(delivery?.details?.message)
      || this.detectContextOverflowText(delivery?.details?.error)
      || this.detectContextOverflowText(delivery?.details?.description);
  }

  static buildContextOverflowRetryPayload(payload = {}, delivery = {}) {
    const retryCount = this.parseOverflowRetryCount(payload) + 1;
    return {
      ...payload,
      _contextOverflowRetryCount: retryCount,
      _contextOverflowRecoveredAt: new Date().toISOString(),
      _contextOverflowReason: delivery.reason || delivery?.details?.message || 'context overflow',
      trigger: payload?.trigger ? `${payload.trigger}:context-overflow-retry` : 'context-overflow-retry',
    };
  }

  static async resolveGatewayFromInstallation(installation) {
    const gatewayId = installation?.config?.runtime?.gatewayId;
    if (!gatewayId) return null;
    const gateway = await Gateway.findById(gatewayId).lean();
    if (!gateway) return null;
    if (gateway.status && gateway.status !== 'active') return null;
    return gateway;
  }

  static async recoverContextOverflow(event, delivery) {
    const typeConfig = AgentIdentityService.getAgentTypeConfig(event?.agentName);
    if (typeConfig?.runtime !== 'moltbot') {
      return { recovered: false, reason: 'runtime_not_openclaw' };
    }

    const retryLimit = this.getContextOverflowRetryLimit();
    const retryCount = this.parseOverflowRetryCount(event?.payload);
    if (retryCount >= retryLimit) {
      return {
        recovered: false,
        reason: 'retry_limit_reached',
        retryCount,
        retryLimit,
      };
    }

    const installation = await AgentInstallation.findOne({
      agentName: event.agentName,
      instanceId: event.instanceId || 'default',
      podId: event.podId,
      status: 'active',
    }).select('config.runtime.gatewayId').lean();

    const gateway = await this.resolveGatewayFromInstallation(installation);
    const accountId = resolveOpenClawAccountId({
      agentName: event.agentName,
      instanceId: event.instanceId || 'default',
    });

    const cleared = await clearAgentRuntimeSessions('moltbot', event.instanceId || 'default', {
      gateway,
      accountId,
    });
    let restarted = null;
    if (this.shouldRestartAfterSessionClear()) {
      restarted = await restartAgentRuntime('moltbot', event.instanceId || 'default', { gateway });
    }

    const retryEvent = await this.enqueue({
      agentName: event.agentName,
      instanceId: event.instanceId || 'default',
      podId: event.podId,
      type: event.type,
      payload: this.buildContextOverflowRetryPayload(event.payload || {}, delivery),
    });

    return {
      recovered: true,
      retryEventId: retryEvent?._id?.toString?.() || null,
      retryCount: retryCount + 1,
      retryLimit,
      cleared,
      restarted,
    };
  }

  static async clearOpenClawSessionsForActiveInstallations({
    source = 'scheduled',
    restart = true,
  } = {}) {
    const installations = await AgentInstallation.find({
      status: 'active',
    }).select('agentName instanceId config.runtime.gatewayId').lean();

    const byInstance = new Map();
    installations.forEach((installation) => {
      const typeConfig = AgentIdentityService.getAgentTypeConfig(installation?.agentName);
      if (typeConfig?.runtime !== 'moltbot') return;
      const agentName = String(installation.agentName || '').toLowerCase();
      const instanceId = String(installation.instanceId || 'default');
      const gatewayId = installation?.config?.runtime?.gatewayId
        ? String(installation.config.runtime.gatewayId)
        : '';
      const key = `${agentName}:${instanceId}:${gatewayId}`;
      if (!byInstance.has(key)) {
        byInstance.set(key, {
          agentName,
          instanceId,
          gatewayId: gatewayId || null,
        });
      }
    });

    const targets = Array.from(byInstance.values());
    const processed = await Promise.all(targets.map(async (target) => {
      const accountId = resolveOpenClawAccountId({
        agentName: target.agentName,
        instanceId: target.instanceId,
      });

      try {
        const gateway = target.gatewayId
          ? await Gateway.findById(target.gatewayId).lean()
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
        return {
          ...target,
          accountId,
          source,
          status: 'cleared',
          cleared,
          restarted,
        };
      } catch (error) {
        return {
          ...target,
          accountId,
          source,
          status: 'failed',
          error: error.message,
        };
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

  /**
   * Checks all agent session directories on the gateway and clears any that exceed
   * the configured size threshold. Runs against the first available gateway.
   * Threshold env: AGENT_SESSION_MAX_SIZE_KB (default 400 KB).
   */
  static async clearOversizedAgentSessions({ source = 'size-check', restart = false } = {}) {
    const thresholdKb = Math.max(
      64,
      Number.parseInt(process.env.AGENT_SESSION_MAX_SIZE_KB, 10) || 400,
    );
    const thresholdBytes = thresholdKb * 1024;

    let sizes;
    try {
      sizes = await getAgentSessionSizes();
    } catch (error) {
      console.error('[session-size-check] Failed to get session sizes:', error.message);
      return { source, checked: 0, cleared: 0, failed: 0, skipped: 0 };
    }

    const oversized = sizes.filter((s) => s.bytes >= thresholdBytes);
    let cleared = 0;
    let failed = 0;
    const skipped = sizes.length - oversized.length;

    await Promise.all(oversized.map(async (entry) => {
      try {
        await clearAgentRuntimeSessions('moltbot', entry.accountId, {
          accountId: entry.accountId,
        });
        console.log(
          `[session-size-check] Cleared sessions for ${entry.accountId} `
          + `(${Math.round(entry.bytes / 1024)} KB > ${thresholdKb} KB threshold)`,
        );
        if (restart) {
          await restartAgentRuntime('moltbot', entry.accountId, {}).catch(() => null);
        }
        cleared += 1;
      } catch (error) {
        console.error(
          `[session-size-check] Failed to clear ${entry.accountId}:`,
          error.message,
        );
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

  static normalizeDeliveryMeta(input = {}) {
    if (!input || typeof input !== 'object') return null;
    const allowedOutcomes = new Set(['acknowledged', 'posted', 'no_action', 'skipped', 'error']);
    const rawOutcome = typeof input.outcome === 'string' ? input.outcome.trim().toLowerCase() : '';
    const outcome = allowedOutcomes.has(rawOutcome) ? rawOutcome : 'acknowledged';
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    const messageId = typeof input.messageId === 'string' ? input.messageId.trim() : '';
    const details = input.details && typeof input.details === 'object' ? input.details : undefined;
    return {
      outcome,
      reason: reason || undefined,
      messageId: messageId || undefined,
      details,
      updatedAt: new Date(),
    };
  }

  static logEventLifecycle(action, details = {}) {
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
  } = {}) {
    const now = Date.now();
    const stalePendingThreshold = new Date(now - (Math.max(stalePendingMinutes, 1) * 60 * 1000));
    const deliveredThreshold = new Date(now - (Math.max(deliveredRetentionHours, 1) * 60 * 60 * 1000));
    const failedThreshold = new Date(now - (Math.max(failedRetentionHours, 1) * 60 * 60 * 1000));

    const [pendingResult, deliveredResult, failedResult] = await Promise.all([
      AgentEvent.deleteMany({
        status: 'pending',
        createdAt: { $lt: stalePendingThreshold },
      }),
      AgentEvent.deleteMany({
        status: 'delivered',
        createdAt: { $lt: deliveredThreshold },
      }),
      AgentEvent.deleteMany({
        status: 'failed',
        createdAt: { $lt: failedThreshold },
      }),
    ]);

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

  static hasIntegrationReadScope(installation) {
    const scopes = installation?.scopes || [];
    return scopes.includes('integration:read') || scopes.includes('integrations:read');
  }

  static mergeAvailableIntegrations(existing, incoming) {
    const byKey = new Map();
    (Array.isArray(existing) ? existing : []).forEach((item) => {
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
  }) {
    const installation = await AgentInstallation.findOne({
      agentName: agentName.toLowerCase(),
      podId,
      instanceId,
      status: 'active',
    }).select('scopes').lean();

    if (!installation || !this.hasIntegrationReadScope(installation)) {
      return payload;
    }

    const integrations = await Integration.find({
      podId,
      isActive: true,
      status: 'connected',
      'config.agentAccessEnabled': true,
    }).select('type config.channelId config.channelName config.groupId config.groupName').lean();

    const availableIntegrations = integrations.map((integration) => ({
      id: integration._id?.toString(),
      type: integration.type,
      channelId: integration.config?.channelId,
      channelName: integration.config?.channelName,
      groupId: integration.config?.groupId,
      groupName: integration.config?.groupName,
    }));

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
  }) {
    if (!agentName || !podId || !type) {
      throw new Error('agentName, podId, and type are required');
    }

    const eventPayload = type === 'heartbeat'
      ? await this.enrichHeartbeatPayload({
        agentName,
        instanceId,
        podId,
        payload: {
          ...payload,
          podId: String(podId),
        },
      })
      : payload;

    const event = await AgentEvent.create({
      agentName: agentName.toLowerCase(),
      instanceId,
      podId,
      type,
      payload: eventPayload,
    });
    this.logEventLifecycle('enqueued', {
      eventId: event._id?.toString?.(),
      agentName: event.agentName,
      instanceId: event.instanceId,
      podId: event.podId?.toString?.(),
      type: event.type,
      trigger: event.payload?.trigger,
      status: event.status,
      attempts: event.attempts,
    });

    // Push event via WebSocket if agent is connected
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

    return event;
  }

  static async list({
    agentName, podId, podIds, limit = 20, instanceId = 'default',
  }) {
    const query = {
      agentName: agentName.toLowerCase(),
      instanceId,
      status: 'pending',
    };

    // Support single podId or array of podIds
    if (podIds && Array.isArray(podIds) && podIds.length > 0) {
      query.podId = { $in: podIds };
    } else if (podId) {
      query.podId = podId;
    }

    const events = await AgentEvent.find(query)
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    return (Array.isArray(events) ? events : []).map((event) => {
      const messageId = event?.payload?.messageId;
      if (messageId === undefined || messageId === null || typeof messageId === 'string') {
        return event;
      }
      return {
        ...event,
        payload: {
          ...event.payload,
          messageId: String(messageId),
        },
      };
    });
  }

  static async acknowledge(eventId, agentName, instanceId = 'default', delivery = null) {
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
    );
    this.logEventLifecycle('acknowledged', {
      eventId: eventId?.toString?.() || eventId,
      agentName: agentName.toLowerCase(),
      instanceId,
      podId: result?.podId?.toString?.(),
      type: result?.type,
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
          eventId: eventId?.toString?.() || eventId,
          agentName: agentName.toLowerCase(),
          instanceId,
          podId: result?.podId?.toString?.(),
          type: result?.type,
          trigger: result?.payload?.trigger,
          status: recovery?.recovered ? 'recovered' : 'skipped',
          error: recovery?.recovered ? undefined : recovery?.reason,
        });
      } catch (recoveryError) {
        this.logEventLifecycle('context_overflow_recovery_failed', {
          eventId: eventId?.toString?.() || eventId,
          agentName: agentName.toLowerCase(),
          instanceId,
          podId: result?.podId?.toString?.(),
          type: result?.type,
          trigger: result?.payload?.trigger,
          status: 'failed',
          error: recoveryError.message,
        });
      }
    }
    return result;
  }

  static async markPosted(eventId, agentName, instanceId = 'default', { messageId } = {}) {
    if (!eventId) return null;
    return AgentEvent.findOneAndUpdate(
      {
        _id: eventId,
        agentName: agentName.toLowerCase(),
        instanceId,
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
    );
  }

  static async recordFailure(eventId, agentName, instanceId, errorMessage) {
    const result = await AgentEvent.findOneAndUpdate(
      { _id: eventId, agentName: agentName.toLowerCase(), instanceId },
      { $set: { status: 'failed', error: errorMessage }, $inc: { attempts: 1 } },
      { new: true },
    );
    this.logEventLifecycle('failed', {
      eventId: eventId?.toString?.() || eventId,
      agentName: agentName.toLowerCase(),
      instanceId,
      podId: result?.podId?.toString?.(),
      type: result?.type,
      trigger: result?.payload?.trigger,
      status: result?.status || 'failed',
      attempts: result?.attempts,
      error: errorMessage,
    });
    return result;
  }
}

module.exports = AgentEventService;
