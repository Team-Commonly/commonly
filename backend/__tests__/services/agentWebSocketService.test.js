jest.mock('../../models/AgentRegistry', () => ({
  AgentInstallation: {
    findOne: jest.fn(),
    updateOne: jest.fn(),
  },
}));

const { hash } = require('../../utils/secret');
const { AgentInstallation } = require('../../models/AgentRegistry');

describe('agentWebSocketService.validateAgentToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('validates cm_agent tokens using hashed runtime tokens', async () => {
    AgentInstallation.findOne.mockResolvedValue({
      _id: 'install-1',
      agentName: 'openclaw',
      instanceId: 'default',
      podId: 'pod-123',
    });
    AgentInstallation.updateOne.mockResolvedValue({});

    const agentWebSocketService = require('../../services/agentWebSocketService');
    const token = 'cm_agent_testtoken';
    const result = await agentWebSocketService.validateAgentToken(token);

    expect(AgentInstallation.findOne).toHaveBeenCalledWith({
      'runtimeTokens.tokenHash': hash(token),
      status: 'active',
    });
    expect(AgentInstallation.updateOne).toHaveBeenCalledWith(
      { _id: 'install-1', 'runtimeTokens.tokenHash': hash(token) },
      { $set: { 'runtimeTokens.$.lastUsedAt': expect.any(Date) } },
    );
    expect(result).toEqual({
      agentName: 'openclaw',
      instanceId: 'default',
      podId: 'pod-123',
    });
  });
});
