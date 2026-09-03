/**
 * Wren spec §1.1 line 2 — the agent listing carries what the agent last said,
 * trimmed at the boundary. The median agent message is ~2,700 chars; the card
 * shows one line, so the payload must never ship the full body.
 */

const { buildAgentInstallationPayload, toSnippet } = require('../../../routes/registry/helpers');

const install = { agentName: 'scout', instanceId: 'default', status: 'active', scopes: [], createdAt: new Date() };

describe('agent listing last-message snippet', () => {
  test('snippet is collapsed, trimmed, and capped at 200 chars with an ellipsis', () => {
    expect(toSnippet('  hello\n\n  world  ')).toBe('hello world');
    const long = 'x'.repeat(500);
    const s = toSnippet(long);
    expect(s.length).toBe(200);
    expect(s.endsWith('…')).toBe(true);
  });

  test('payload carries { snippet, at } when a last message exists', () => {
    const at = new Date('2026-09-01T08:00:00Z');
    const p = buildAgentInstallationPayload(install, {
      lastMessage: { content: 'Deployed the fix.\nAll green.', createdAt: at },
    });
    expect(p.lastMessage).toEqual({ snippet: 'Deployed the fix. All green.', at });
  });

  test('payload lastMessage is null when the agent never spoke — or said only whitespace', () => {
    expect(buildAgentInstallationPayload(install).lastMessage).toBeNull();
    expect(buildAgentInstallationPayload(install, { lastMessage: { content: '  \n ' } }).lastMessage).toBeNull();
  });

  test('payload carries the output state instead of inferring it in a roster client', () => {
    const now = Date.now();
    const p = buildAgentInstallationPayload(install, {
      lastActiveAt: new Date(now - 1000),
      lastMessage: { content: 'A reply from earlier today.', createdAt: new Date(now - 31 * 60 * 1000) },
    });
    expect(p.outputState).toBe('unverifiable');
  });

  test('blank message content does not count as observed output', () => {
    const p = buildAgentInstallationPayload(install, {
      lastActiveAt: new Date(),
      lastMessage: { content: ' \n ', createdAt: new Date() },
    });
    expect(p.lastMessage).toBeNull();
    expect(p.outputState).toBe('unverifiable');
  });
});
