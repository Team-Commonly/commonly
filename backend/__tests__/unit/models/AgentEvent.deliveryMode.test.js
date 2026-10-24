const mongoose = require('mongoose');
const AgentEvent = require('../../../models/AgentEvent');

describe('AgentEvent delivery mode persistence shape', () => {
  const base = {
    agentName: 'flint', instanceId: 'default', podId: new mongoose.Types.ObjectId(),
    type: 'message.posted', status: 'pending', attempts: 0,
  };

  test('legacy callers default to wake; digest survives strict schema conversion', () => {
    expect(new AgentEvent(base).toObject().deliveryMode).toBe('wake');
    expect(new AgentEvent({ ...base, deliveryMode: 'digest' }).toObject().deliveryMode).toBe('digest');
  });
});
