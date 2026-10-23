/**
 * Direction C Your Team card (ux-lead 66163): line 3 is the curated
 * `botMetadata.description`, or no line at all — never a quote. The payload
 * also carries the bot User's id so a client can key per-agent attention on
 * `AttentionItem.actorUserId` instead of matching names.
 */

const { buildAgentInstallationPayload } = require('../../../routes/registry/helpers');
const { resolveAgentDisplayLabel } = require('../../../services/agentIdentityService');

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

  test('listing and chat use the same User label even when scoped labels differ', () => {
    const user = {
      _id: 'u1',
      username: 'commonly-summarizer',
      botMetadata: { agentName: 'commonly-bot', instanceId: 'default', displayName: 'Commonly Summarizer' },
    };
    const listing = buildAgentInstallationPayload(
      { ...install, displayName: 'Commonly Bot' },
      { user, profile: { name: 'Commonly Bot' } },
    );
    expect(listing.displayName).toBe(resolveAgentDisplayLabel(user, user.username));
    expect(listing.displayName).toBe('Commonly Summarizer');
  });

  test('collision suffix and runtime-label fallback match chat', () => {
    for (const displayName of ['Pixel (Pixel Demo)', 'openclaw (pixel)']) {
      const user = { username: 'openclaw-pixel', botMetadata: { agentName: 'openclaw', instanceId: 'pixel', displayName } };
      expect(buildAgentInstallationPayload(install, { user, profile: { name: 'Pixel' } }).displayName)
        .toBe(resolveAgentDisplayLabel(user, user.username));
    }
  });

  test('settings projects effective environment model controls without secrets', () => {
    const payload = buildAgentInstallationPayload({ ...install, config: new Map([['environment', {
      model: 'openai/gpt-5', effort: 'high', adapter: 'codex',
      provider: { apiKey: 'secret' }, mcp: [{ env: { TOKEN: 'secret' } }],
    }]]) });
    expect(payload.config.environment).toEqual({ model: 'openai/gpt-5', effort: 'high', adapter: 'codex' });
    expect(JSON.stringify(payload)).not.toContain('secret');
  });
});
