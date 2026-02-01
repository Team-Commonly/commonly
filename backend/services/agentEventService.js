const AgentEvent = require('../models/AgentEvent');

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
  static async enqueue({
    agentName, podId, type, payload = {}, instanceId = 'default',
  }) {
    if (!agentName || !podId || !type) {
      throw new Error('agentName, podId, and type are required');
    }

    const event = await AgentEvent.create({
      agentName: agentName.toLowerCase(),
      instanceId,
      podId,
      type,
      payload,
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
