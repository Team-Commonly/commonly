const request = require('supertest');
const express = require('express');

const mockPgQuery = jest.fn();
const mockMessageCountDocuments = jest.fn().mockResolvedValue(88);

jest.mock('../../../models/Pod', () => ({
  countDocuments: jest.fn().mockResolvedValue(12),
}));
jest.mock('../../../models/User', () => ({
  countDocuments: jest.fn().mockResolvedValue(42),
}));
jest.mock('../../../models/Message', () => ({
  countDocuments: mockMessageCountDocuments,
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    distinct: jest.fn().mockResolvedValue(['openclaw', 'moltbot', 'clawdbot']),
  },
}));
jest.mock('../../../config/db-pg', () => ({
  pool: { query: mockPgQuery },
}));

// eslint-disable-next-line import/no-unresolved, import/extensions
const statsRoutes = require('../../../routes/stats');

describe('GET /api/stats/public', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/stats', statsRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
    mockPgQuery.mockResolvedValue({ rows: [{ count: 1234 }] });
  });

  it('uses PostgreSQL for the 24-hour message count', async () => {
    const res = await request(app).get('/api/stats/public');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      activePods: 12,
      activeAgents: 3,
      messageCount24h: 1234,
      registeredUsers: 42,
    });
    expect(mockPgQuery).toHaveBeenCalledWith(
      'SELECT COUNT(*)::int AS count FROM messages WHERE created_at >= $1',
      [expect.any(Date)],
    );
    expect(mockMessageCountDocuments).not.toHaveBeenCalled();
  });

  it('falls back to MongoDB when the PostgreSQL count fails', async () => {
    mockPgQuery.mockRejectedValue(new Error('PostgreSQL unavailable'));

    const res = await request(app).get('/api/stats/public');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      activePods: 12,
      activeAgents: 3,
      messageCount24h: 88,
      registeredUsers: 42,
    });
    expect(mockMessageCountDocuments).toHaveBeenCalledWith({
      createdAt: { $gte: expect.any(Date) },
    });
  });

  it('does not require authentication', async () => {
    const res = await request(app).get('/api/stats/public');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
