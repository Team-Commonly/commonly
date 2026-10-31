/**
 * TASK-551: the roster never labels a seat with its agentName. With a User row
 * the label is the chat label. Without one, only a scoped name that differs
 * from the agentName counts; otherwise the label is '' and the client shows its
 * generic fallback.
 */

const { buildAgentInstallationPayload } = require('../../../routes/registry/helpers');

const install = { agentName: 'scout', instanceId: 'ubd1004e0d7', status: 'active', scopes: [], createdAt: new Date() };

describe('roster displayName for an agent with no User row', () => {
  test('is empty when no curated name is set, never the agentName', () => {
    expect(buildAgentInstallationPayload(install).displayName).toBe('');
  });

  test('is empty when the installation displayName is only the agentName', () => {
    expect(buildAgentInstallationPayload({ ...install, displayName: 'scout' }).displayName).toBe('');
  });

  test('is empty when the profile name is only the agentName', () => {
    expect(buildAgentInstallationPayload(install, { profile: { name: 'scout' } }).displayName).toBe('');
  });

  test('falls past an agentName-equal profile name to a curated installation name', () => {
    const payload = buildAgentInstallationPayload(
      { ...install, displayName: 'Scout Desk' },
      { profile: { name: 'scout' } },
    );
    expect(payload.displayName).toBe('Scout Desk');
  });

  test('keeps a curated name that differs from the agentName', () => {
    expect(buildAgentInstallationPayload({ ...install, displayName: 'Scout' }).displayName).toBe('Scout');
    expect(buildAgentInstallationPayload(install, { profile: { name: 'Scout Desk' } }).displayName).toBe('Scout Desk');
  });
});
