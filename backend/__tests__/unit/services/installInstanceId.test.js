// F359: an install that names no instance takes it from the display name. A
// display name that only repeats the end of the agent's name must not double
// it, and must never move an existing agent off its identity.
const mockRow = jest.fn();
const mockBot = jest.fn();
const mockCollation = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    findOne: (filter) => ({
      select: () => ({
        collation: (collation) => { mockCollation(collation); return { lean: () => mockRow(filter) }; },
      }),
    }),
  },
}));
jest.mock('../../../models/User', () => ({
  findOne: (filter) => ({ select: () => ({ lean: () => mockBot(filter) }) }),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentType: (name) => name,
  buildAgentUsername: (type, instanceId) => (instanceId === 'default' ? type : `${type}-${instanceId}`),
}));

const { deriveInstanceId, resolveUnnamedInstanceId } = require('../../../services/installInstanceId');

const rowAt = (instanceId) => async (filter) => (
  (filter.instanceId === instanceId || (instanceId === 'default' && filter.$or)) ? { _id: 'row' } : null
);

describe('resolveUnnamedInstanceId', () => {
  beforeEach(() => {
    mockRow.mockReset(); mockRow.mockResolvedValue(null);
    mockBot.mockReset(); mockBot.mockResolvedValue(null);
    mockCollation.mockReset();
  });

  test('a fresh install whose display name repeats the end of the agent name takes default', async () => {
    expect(await resolveUnnamedInstanceId('CTO', 'acme-cto')).toBe('default');
    expect(await resolveUnnamedInstanceId('SWE', 'acme-swe')).toBe('default');
    expect(await resolveUnnamedInstanceId('--cto--', 'acme-cto')).toBe('default');
    // Any status, and case-insensitive the way the route reads identities.
    expect(JSON.stringify(mockRow.mock.calls[0][0])).not.toContain('status');
    expect(mockCollation).toHaveBeenCalledWith({ locale: 'en', strength: 2 });
  });

  test('a row at the slug, in any status, keeps it, so a re-install finds the agent', async () => {
    mockRow.mockImplementation(rowAt('cto'));
    expect(await resolveUnnamedInstanceId('CTO', 'acme-cto')).toBe('cto');
  });

  test('a bot user at the slug keeps it even with no row left', async () => {
    mockBot.mockImplementation(async ({ username }) => (username === 'acme-cto-cto' ? { _id: 'bot' } : null));
    expect(await resolveUnnamedInstanceId('CTO', 'acme-cto')).toBe('cto');
  });

  test("the agent's own default keeps a later install on default, never splitting it", async () => {
    // The first install made the default row and bot user; every later install
    // (a retry, a second pod, a reattach) must land back on it.
    mockRow.mockImplementation(rowAt('default'));
    mockBot.mockImplementation(async ({ username }) => (username === 'acme-cto' ? { _id: 'bot' } : null));
    expect(await resolveUnnamedInstanceId('CTO', 'acme-cto')).toBe('default');
  });

  test('a display name that names a different seat still derives its instance', async () => {
    expect(await resolveUnnamedInstanceId('Cuz', 'openclaw')).toBe('cuz');
    expect(await resolveUnnamedInstanceId('Scout', 'acme-cto')).toBe('scout');
    // Only a whole trailing segment counts: "to" is not the end of "acme-cto".
    expect(await resolveUnnamedInstanceId('to', 'acme-cto')).toBe('to');
    expect(mockRow).not.toHaveBeenCalled();
  });

  test('no display name, or the agent name itself, takes default without a read', async () => {
    expect(await resolveUnnamedInstanceId(undefined, 'acme-cto')).toBe('default');
    expect(await resolveUnnamedInstanceId('Acme CTO', 'acme-cto')).toBe('default');
    expect(deriveInstanceId('', 'x')).toBe('default');
    expect(deriveInstanceId('-'.repeat(10000), 'acme-cto')).toBe('default');
    expect(deriveInstanceId('--Scout--', 'acme-cto')).toBe('scout');
    expect(mockRow).not.toHaveBeenCalled();
  });
});
