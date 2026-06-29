jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findOne: jest.fn(), findById: jest.fn() }));

const AgentIdentityService = require('../../../services/agentIdentityService');

describe('AgentIdentityService display label helpers', () => {
  it('prefers the curated displayName when available', () => {
    const label = AgentIdentityService.resolveAgentDisplayLabel({
      username: 'openclaw',
      botMetadata: { displayName: 'Pixel', instanceId: 'pixel', agentName: 'openclaw' },
    });

    expect(label).toBe('Pixel');
  });

  it('falls back to instanceId when displayName leaks the runtime label', () => {
    const label = AgentIdentityService.resolveAgentDisplayLabel({
      username: 'openclaw',
      botMetadata: { displayName: 'openclaw (nova)', instanceId: 'nova', agentName: 'openclaw' },
    });

    expect(label).toBe('nova');
  });

  it('falls back to username when no displayName or instanceId is available', () => {
    const label = AgentIdentityService.resolveAgentDisplayLabel({
      username: 'fallback-user',
      botMetadata: { agentName: 'openclaw' },
    });

    expect(label).toBe('fallback-user');
  });

  it('falls back to the provided default when user is missing', () => {
    expect(AgentIdentityService.resolveAgentDisplayLabel(null, 'agent')).toBe('agent');
  });
});
