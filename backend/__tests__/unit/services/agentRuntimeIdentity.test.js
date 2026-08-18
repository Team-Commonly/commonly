const { resolveAgentRuntimeIdentity } = require('../../../services/agentRuntimeIdentity');

describe('resolveAgentRuntimeIdentity', () => {
  it('uses an identity-bearing instanceId as both event keys when agentName is absent', () => {
    expect(resolveAgentRuntimeIdentity({
      username: 'openclaw-reviewer',
      botMetadata: { instanceId: 'reviewer' },
    })).toEqual({ agentName: 'reviewer', instanceId: 'reviewer' });
  });

  it('derives an instance suffix from username when metadata still says default', () => {
    expect(resolveAgentRuntimeIdentity({
      username: 'openclaw-reviewer',
      botMetadata: { agentName: 'openclaw', instanceId: 'default' },
    })).toEqual({ agentName: 'openclaw', instanceId: 'reviewer' });
  });
});
