const AgentEvent = require('../models/AgentEvent');
const { AgentInstallation } = require('../models/AgentRegistry');
const Integration = require('../models/Integration');

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
        payload,
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

    return AgentEvent.find(query)
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();
  }

  static async acknowledge(eventId, agentName, instanceId = 'default') {
    const result = await AgentEvent.findOneAndUpdate(
      { _id: eventId, agentName: agentName.toLowerCase(), instanceId },
      { $set: { status: 'delivered', deliveredAt: new Date() }, $inc: { attempts: 1 } },
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
    });
    return result;
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
