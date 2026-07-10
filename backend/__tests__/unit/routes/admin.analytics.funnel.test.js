const request = require('supertest');
const express = require('express');

// Wave 0 (GH#661): activation-funnel endpoint. Verifies cohort math, bot
// exclusion, the PG-backed sentMessage source, the lastActive return proxy,
// and that non-admins are refused.

let mockRole = 'admin';
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'admin1' };
  req.userId = 'admin1';
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => {
  if (mockRole !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  return next();
});
jest.mock('../../../middleware/ipRateLimit', () => ({
  cloudflareIpRateLimitKeyGenerator: () => 'test-key',
}));

const mockUserFind = jest.fn();
const mockCountDocuments = jest.fn();
jest.mock('../../../models/User', () => ({
  find: (...args) => mockUserFind(...args),
  countDocuments: (...args) => mockCountDocuments(...args),
}));

const mockPodAggregate = jest.fn();
jest.mock('../../../models/Pod', () => ({
  aggregate: (...args) => mockPodAggregate(...args),
}));

const mockDistinct = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { distinct: (...args) => mockDistinct(...args) },
}));

const mockPgQuery = jest.fn();
jest.mock('../../../config/db-pg', () => ({
  pool: { query: (...args) => mockPgQuery(...args) },
}));

const routes = require('../../../routes/admin/analytics');

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const dayKey = (d) => d.toISOString().slice(0, 10);

const userDoc = (id, createdDaysAgo, lastActiveDaysAgo) => ({
  _id: id,
  createdAt: daysAgo(createdDaysAgo),
  lastActive: lastActiveDaysAgo != null ? daysAgo(lastActiveDaysAgo) : undefined,
});

describe('GET /api/admin/analytics/funnel', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use('/api/admin/analytics', routes);
    jest.clearAllMocks();
    mockRole = 'admin';
  });

  const chain = (docs) => ({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) }) });

  it('computes cohorts, totals and rates from the three sources', async () => {
    // u1: signed up 10d ago, attached agent, messaged, still active (D1+D7 return)
    // u2: signed up 10d ago, no agent, no message, never came back
    // u3: signed up 2d ago, attached, messaged, active yesterday (D1 return, no D7 yet)
    mockUserFind.mockReturnValue(chain([
      userDoc('u1', 10, 0),
      userDoc('u2', 10, 10),
      userDoc('u3', 2, 1),
    ]));
    mockDistinct.mockResolvedValue(['u1', 'u3']);
    mockPgQuery.mockResolvedValue({ rows: [{ user_id: 'u1' }, { user_id: 'u3' }] });

    const res = await request(app).get('/api/admin/analytics/funnel?days=30').expect(200);

    expect(res.body.totals).toMatchObject({
      signups: 3,
      attachedAgent: 2,
      sentMessage: 2,
      returnedD1: 2,
      returnedD7: 1,
      attachRatePct: 67,
      messageRatePct: 67,
      d1ReturnPct: 67,
      d7ReturnPct: 33,
    });
    // PG queried with the cohort's user ids
    expect(mockPgQuery).toHaveBeenCalledWith(expect.stringContaining('DISTINCT user_id'), [['u1', 'u2', 'u3']]);
    // Bot exclusion is part of the User query itself
    const q = mockUserFind.mock.calls[0][0];
    expect(JSON.stringify(q)).toContain('botMetadata.agentName');
    // Every day in range is present (zeros, not gaps)
    expect(res.body.cohorts.length).toBeGreaterThanOrEqual(30);
  });

  it('clamps days to [7, 90]', async () => {
    mockUserFind.mockReturnValue(chain([]));
    mockDistinct.mockResolvedValue([]);
    const r1 = await request(app).get('/api/admin/analytics/funnel?days=2').expect(200);
    expect(r1.body.days).toBe(7);
    const r2 = await request(app).get('/api/admin/analytics/funnel?days=500').expect(200);
    expect(r2.body.days).toBe(90);
  });

  it('skips the PG query entirely for an empty cohort', async () => {
    mockUserFind.mockReturnValue(chain([]));
    mockDistinct.mockResolvedValue([]);
    await request(app).get('/api/admin/analytics/funnel').expect(200);
    expect(mockPgQuery).not.toHaveBeenCalled();
  });

  it('403s non-admins', async () => {
    mockRole = 'user';
    await request(app).get('/api/admin/analytics/funnel').expect(403);
  });
});

describe('GET /api/admin/analytics/usage', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use('/api/admin/analytics', routes);
    jest.clearAllMocks();
    mockRole = 'admin';
  });

  const chain = (docs) => ({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) }) });

  it('merges Mongo signups with PG message/poster counts per day', async () => {
    mockUserFind.mockImplementation((q) => {
      if (q && q['botMetadata.agentName']) return chain([{ _id: 'bot1' }]);
      return chain([userDoc('u1', 3), userDoc('u2', 3), userDoc('u3', 0)]);
    });
    // dau, wau, totalUsers in Promise.all order
    mockCountDocuments
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(5);
    const d3 = dayKey(daysAgo(3));
    mockPgQuery.mockResolvedValue({ rows: [{ day: d3, messages: 12, posters: 2 }] });

    const res = await request(app).get('/api/admin/analytics/usage?days=7').expect(200);

    expect(res.body.totals).toMatchObject({
      signups: 3, messages: 12, dau: 1, wau: 2, totalUsers: 5,
    });
    const day3 = res.body.daily.find((r) => r.date === d3);
    expect(day3).toMatchObject({ signups: 2, messages: 12, posters: 2 });
    // Bot user ids are passed to PG so posters exclude agents
    expect(mockPgQuery.mock.calls[0][1][1]).toEqual(['bot1']);
    // Every day in range present (zeros, not gaps)
    expect(res.body.daily.length).toBeGreaterThanOrEqual(7);
  });

  it('403s non-admins', async () => {
    mockRole = 'user';
    await request(app).get('/api/admin/analytics/usage').expect(403);
  });
});

describe('GET /api/admin/analytics/lifecycle', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use('/api/admin/analytics', routes);
    jest.clearAllMocks();
    mockRole = 'admin';
  });

  it('merges pod counts (Mongo) with message counts (PG) keyed by user id', async () => {
    mockPodAggregate.mockResolvedValue([
      { _id: 'u1', pods: 3 },
      { _id: 'u2', pods: 1 },
    ]);
    mockPgQuery.mockResolvedValue({ rows: [{ user_id: 'u1', messages: 42 }] });

    const res = await request(app).get('/api/admin/analytics/lifecycle').expect(200);

    expect(res.body.users).toEqual({
      u1: { pods: 3, messages: 42 },
      u2: { pods: 1, messages: 0 },
    });
  });

  it('403s non-admins', async () => {
    mockRole = 'user';
    await request(app).get('/api/admin/analytics/lifecycle').expect(403);
  });
});
