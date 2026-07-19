const AgentFirstContact = require('../../../models/AgentFirstContact');

describe('AgentFirstContact model', () => {
  test('enforces one durable marker per user and agent identity', () => {
    const relationshipIndex = AgentFirstContact.schema.indexes().find(([fields]) => (
      fields.userId === 1 && fields.agentName === 1 && fields.instanceId === 1
    ));

    expect(relationshipIndex).toBeDefined();
    expect(relationshipIndex[1]).toEqual(expect.objectContaining({ unique: true }));
    expect(AgentFirstContact.schema.path('instanceId').options).toEqual(expect.objectContaining({
      required: true,
      lowercase: true,
      trim: true,
    }));
  });
});
