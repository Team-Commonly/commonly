/**
 * #1377 — the agent listing classifies internal ops/smoke/demo seats at the
 * boundary (`internal: true` on the payload) so no consumer curates its own
 * name list. The one-release client constant in V2YourTeamPage is deleted;
 * this is the contract that replaced it.
 */

const { buildAgentInstallationPayload, isInternalSeat } = require('../../../routes/registry/helpers');

const install = (agentName, config = undefined) => ({
  agentName,
  instanceId: 'default',
  status: 'active',
  scopes: [],
  createdAt: new Date('2026-08-30'),
  config,
});

describe('internal seat classification (#1377)', () => {
  test('known ops seats and script prefixes are flagged', () => {
    for (const name of ['hosted-smoke', 'run-here-smoke', 'commonly-summarizer',
      'smoke-stranger-abc', 'recorder-demo1', 'adr-023-probe', 'demo-pelican']) {
      expect(buildAgentInstallationPayload(install(name)).internal).toBe(true);
    }
  });

  test('an ordinary agent is not flagged', () => {
    for (const name of ['scout', 'hairui-yu-agent', 'smokey', 'fable']) {
      expect(buildAgentInstallationPayload(install(name)).internal).toBe(false);
    }
  });

  test('an explicit config.internal: true wins regardless of name', () => {
    expect(buildAgentInstallationPayload(install('scout', { internal: true })).internal).toBe(true);
  });

  test('config.internal must be boolean true — truthy strings do not flag', () => {
    expect(isInternalSeat('scout', { internal: 'yes' })).toBe(false);
  });
});
