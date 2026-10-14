/**
 * Self-serve seats must not bind a built-in agent's identity.
 *
 * Earned 2026-10-14: a connect card named a seat "claude-code", and approving it
 * bound the official Claude Code identity, which every installer shares.
 */
const mockGetByName = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: { getByName: (...args) => mockGetByName(...args) },
}));
jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn((name) => (['claude-code', 'codex', 'openclaw', 'commonly-bot'].includes(name) ? { runtime: name } : null)),
}));

const { reservedAgentNameRefusal } = require('../../../services/agentNameReservation');

beforeEach(() => { mockGetByName.mockReset(); });

describe('reservedAgentNameRefusal', () => {
  test('a platform agent type is reserved, with a name of their own suggested', async () => {
    const refusal = await reservedAgentNameRefusal('Claude-Code');
    expect(refusal).toEqual({ code: 'agent_name_reserved', error: expect.stringContaining('"claude-code" is the name of a built-in agent') });
    expect(refusal.error).toContain('"your-name-claude"');
  });

  test('an official registry row is reserved (the first-party apps, such as Scout)', async () => {
    mockGetByName.mockResolvedValue({ agentName: 'scout', registry: 'commonly-official' });
    expect(await reservedAgentNameRefusal('scout')).toEqual(expect.objectContaining({ code: 'agent_name_reserved' }));
  });

  test('a community-published agent stays installable (multi-installer by design, #609)', async () => {
    mockGetByName.mockResolvedValue({ agentName: 'standup-bot', registry: 'commonly-community' });
    expect(await reservedAgentNameRefusal('standup-bot')).toBeNull();
  });

  test('a self-serve (ephemeral) name and an unused name are free', async () => {
    mockGetByName.mockResolvedValueOnce({ agentName: 'sams-claude', registry: 'private', ephemeral: true });
    expect(await reservedAgentNameRefusal('sams-claude')).toBeNull();
    mockGetByName.mockResolvedValueOnce(null);
    expect(await reservedAgentNameRefusal('lee-codex')).toBeNull();
  });

  test('an empty name is left to the callers own validation', async () => {
    expect(await reservedAgentNameRefusal('')).toBeNull();
    expect(mockGetByName).not.toHaveBeenCalled();
  });
});
