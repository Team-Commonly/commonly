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
    return AgentEvent.updateOne(
      { _id: eventId, agentName: agentName.toLowerCase(), instanceId },
      { $set: { status: 'delivered', deliveredAt: new Date() }, $inc: { attempts: 1 } },
    );
  }

  static async recordFailure(eventId, agentName, instanceId, errorMessage) {
    return AgentEvent.updateOne(
      { _id: eventId, agentName: agentName.toLowerCase(), instanceId },
      { $set: { status: 'failed', error: errorMessage }, $inc: { attempts: 1 } },
    );
  }
}

module.exports = AgentEventService;
