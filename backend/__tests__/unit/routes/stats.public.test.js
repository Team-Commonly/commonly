const request = require('supertest');
const express = require('express');

jest.mock('../../../models/Pod', () => ({
  countDocuments: jest.fn().mockResolvedValue(12),
}));
jest.mock('../../../models/User', () => ({
  countDocuments: jest.fn().mockResolvedValue(42),
}));
jest.mock('../../../models/Message', () => ({
  countDocuments: jest.fn().mockResolvedValue(88),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    distinct: jest.fn().mockResolvedValue(['openclaw', 'moltbot', 'clawdbot']),
  },
}));

const statsRoutes = require('../../../routes/stats');

describe('GET /api/stats/public', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/stats', statsRoutes);

  it('returns public stats with correct shape', async () => {
    const res = await request(app).get('/api/stats/public');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      activePods: 12,
      activeAgents: 3,
      messageCount24h: 88,
      registeredUsers: 42,
    });
  });

  it('does not require authentication', async () => {
    const res = await request(app).get('/api/stats/public');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
