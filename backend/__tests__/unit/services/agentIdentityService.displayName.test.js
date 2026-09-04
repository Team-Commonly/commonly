const mockQuery = jest.fn();

jest.mock('../../../models/User', () => ({}));
jest.mock('../../../models/Pod', () => ({}));
jest.mock('../../../models/pg/Message', () => ({}));
jest.mock('../../../models/pg/Pod', () => ({}));
jest.mock('../../../config/db-pg', () => ({ pool: { query: mockQuery } }));
jest.mock('../../../services/avatarService', () => ({ normalizeAvatarUrl: jest.fn((value) => value) }));

const AgentIdentityService = require('../../../services/agentIdentityService');

describe('syncUserToPostgreSQL human display names', () => {
  const originalPgHost = process.env.PG_HOST;

  beforeEach(() => {
    process.env.PG_HOST = 'postgres.test';
    mockQuery.mockReset();
  });

  afterAll(() => {
    if (originalPgHost === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = originalPgHost;
  });

  test('writes a human displayName into the PostgreSQL render column used by the next chat message', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ _id: 'human-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    const user = {
      _id: { toString: () => 'human-1' },
      username: 'lily',
      displayName: 'Lily Shen',
      profilePicture: '/uploads/lily.png',
      isBot: false,
      createdAt: new Date('2026-09-04T20:00:00.000Z'),
    };

    await expect(AgentIdentityService.syncUserToPostgreSQL(user)).resolves.toBe(true);

    expect(mockQuery).toHaveBeenNthCalledWith(1, 'SELECT _id FROM users WHERE _id = $1', ['human-1']);
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SET username = $2'),
      ['human-1', 'Lily Shen', '/uploads/lily.png', false, expect.any(Date)],
    );
  });

  test('reports a failed mirror so the account save can ask the user to retry', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockQuery.mockRejectedValueOnce(new Error('postgres down'));
    const user = {
      _id: { toString: () => 'human-1' },
      username: 'lily',
      displayName: 'Lily Shen',
      profilePicture: '/uploads/lily.png',
      isBot: false,
      createdAt: new Date(),
    };

    await expect(AgentIdentityService.syncUserToPostgreSQL(user)).resolves.toBe(false);
    error.mockRestore();
  });
});
