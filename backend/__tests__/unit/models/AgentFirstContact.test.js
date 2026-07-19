const AgentFirstContact = require('../../../models/AgentFirstContact');

describe('AgentFirstContact model', () => {
  test('enforces one durable marker per user and agent', () => {
    const relationshipIndex = AgentFirstContact.schema.indexes().find(([fields]) => (
      fields.userId === 1 && fields.agentName === 1
    ));

    expect(relationshipIndex).toBeDefined();
    expect(relationshipIndex[1]).toEqual(expect.objectContaining({ unique: true }));
  });
});
