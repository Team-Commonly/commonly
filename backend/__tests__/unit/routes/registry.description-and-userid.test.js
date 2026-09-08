/**
 * Direction C Your Team card (ux-lead 66163): line 3 is the curated
 * `botMetadata.description`, or no line at all — never a quote. The payload
 * also carries the bot User's id so a client can key per-agent attention on
 * `AttentionItem.actorUserId` instead of matching names.
 */

const { buildAgentInstallationPayload } = require('../../../routes/registry/helpers');

const install = { agentName: 'wren', instanceId: 'default', status: 'active', scopes: [], createdAt: new Date() };

describe('agent listing description + principal id', () => {
  test('description is the trimmed botMetadata.description and userId is the bot User id', () => {
    const user = { _id: { toString: () => '507f191e810c19729de860ea' }, username: 'wren', botMetadata: { description: '  Connectors. Presses PRs, watches deploys.  ' } };
    const p = buildAgentInstallationPayload(install, { user });
    expect(p.description).toBe('Connectors. Presses PRs, watches deploys.');
    expect(p.userId).toBe('507f191e810c19729de860ea');
  });

  test('no description, or a whitespace one, is null — the card renders no line', () => {
    expect(buildAgentInstallationPayload(install).description).toBeNull();
    expect(buildAgentInstallationPayload(install, { user: { _id: 'u1', botMetadata: {} } }).description).toBeNull();
    expect(buildAgentInstallationPayload(install, { user: { _id: 'u1', botMetadata: { description: '   ' } } }).description).toBeNull();
  });

  test('no user row means no principal id, not a crash', () => {
    expect(buildAgentInstallationPayload(install).userId).toBeNull();
  });
});
