const AgentEvent = require('../models/AgentEvent');

class AgentEventService {
  static async enqueue({
    agentName, podId, type, payload = {},
  }) {
    if (!agentName || !podId || !type) {
      throw new Error('agentName, podId, and type are required');
    }

    return AgentEvent.create({
      agentName: agentName.toLowerCase(),
      podId,
      type,
      payload,
    });
  }

  static async list({
    agentName, podId, limit = 20,
  }) {
    return AgentEvent.find({
      agentName: agentName.toLowerCase(),
      podId,
      status: 'pending',
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();
  }

  static async acknowledge(eventId, agentName) {
    return AgentEvent.updateOne(
      { _id: eventId, agentName: agentName.toLowerCase() },
      { $set: { status: 'delivered', deliveredAt: new Date() }, $inc: { attempts: 1 } },
    );
  }

  static async recordFailure(eventId, agentName, errorMessage) {
    return AgentEvent.updateOne(
      { _id: eventId, agentName: agentName.toLowerCase() },
      { $set: { status: 'failed', error: errorMessage }, $inc: { attempts: 1 } },
    );
  }
}

module.exports = AgentEventService;
