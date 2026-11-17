const request = require('supertest');
const express = require('express');

const mockInsertOne = jest.fn().mockResolvedValue({ acknowledged: true });
const mockFind = jest.fn();
const mockPassThrough = () => (_req, _res, next) => next();

jest.mock('../../../models/Pod', () => ({ countDocuments: jest.fn() }));
jest.mock('../../../models/User', () => ({ countDocuments: jest.fn() }));
jest.mock('../../../models/Message', () => ({ countDocuments: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { distinct: jest.fn(), find: (...args) => mockFind(...args) },
}));
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../../middleware/auth', () => (_req, res) => res.status(401).json({ msg: 'no' }));
jest.mock('../../../services/onboardingMarks', () => ({
  markByoCommandCopied: jest.fn(), markByoCopyType: jest.fn(), markByoSetup: jest.fn(), markSurface: jest.fn(),
}));
jest.mock('express-rate-limit', () => ({ __esModule: true, default: mockPassThrough, rateLimit: mockPassThrough }));
jest.mock('../../../middleware/ipRateLimit', () => ({ cloudflareIpRateLimitKeyGenerator: jest.fn() }));
jest.mock('mongoose', () => ({
  connection: { db: { collection: () => ({ insertOne: (...args) => mockInsertOne(...args) }) } },
}));

const statsRoutes = require('../../../routes/stats');

const app = express();
app.use(express.json());
app.use('/api/stats', statsRoutes);

// The query chain the route uses: find(filter).select(fields).limit(n).lean().
const installsFound = (lean) => {
  const chain = { select: () => chain, limit: () => chain, lean };
  mockFind.mockReturnValue(chain);
};
// The route answers before it looks anything up, so let that work finish.
const settle = () => new Promise((resolve) => { setTimeout(resolve, 10); });
const post = (body) => request(app).post('/api/stats/run-stopped').send(body);

describe('POST /api/stats/run-stopped (F551)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installsFound(() => Promise.resolve([]));
  });

  it('needs no sign-in, and records a row for the recent BYO agent of that name, owned by its installer', async () => {
    installsFound(() => Promise.resolve([{ _id: 'inst-1', installedBy: 'human-1' }]));

    const res = await post({
      reason: 'no-token', agentName: 'Cincono-Codex', platform: 'win32', nodeMajor: 22,
    });
    await settle();

    expect(res.status).toBe(204);
    const [filter] = mockFind.mock.calls[0];
    expect(filter).toEqual({
      agentName: 'cincono-codex',
      status: 'active',
      'config.runtime.runtimeType': 'webhook',
      createdAt: { $gte: expect.any(Date) },
    });
    expect(Date.now() - filter.createdAt.$gte.getTime()).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
    expect(mockInsertOne).toHaveBeenCalledWith({
      _id: 'run-stopped:inst-1:no-token',
      userId: 'human-1',
      step: 'run-stopped',
      reason: 'no-token',
      installationId: 'inst-1',
      platform: 'win32',
      nodeMajor: 22,
      at: expect.any(Date),
    });
  });

  it('answers before the lookup, so a hit and a miss take the same time', async () => {
    installsFound(() => new Promise(() => {}));

    const res = await post({
      reason: 'no-token', agentName: 'a1', platform: 'win32', nodeMajor: 22,
    });

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(mockFind).toHaveBeenCalled();
  });

  it('answers 204 and writes nothing when no recent agent has the name', async () => {
    const res = await post({
      reason: 'no-token', agentName: 'nobody-here', platform: 'win32', nodeMajor: 22,
    });
    await settle();

    expect(res.status).toBe(204);
    expect(mockInsertOne).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown reason', { reason: 'cm_agent_secret', agentName: 'a1' }],
    ['a malformed name', { reason: 'no-token', agentName: 'a b; drop' }],
    ['a missing name', { reason: 'no-token' }],
    ['a name sent as an array', { reason: 'no-token', agentName: ['a1'] }],
    ['a name sent as an object', { reason: 'no-token', agentName: { $ne: '' } }],
  ])('drops %s without a lookup, still 204', async (_label, body) => {
    const res = await post(body);
    await settle();

    expect(res.status).toBe(204);
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockInsertOne).not.toHaveBeenCalled();
  });

  it('keeps only known platforms and a plausible Node major, never other fields', async () => {
    installsFound(() => Promise.resolve([{ _id: 'inst-2', installedBy: 'human-2' }]));

    await post({
      reason: 'no-token', agentName: 'a1', platform: 'beos', nodeMajor: 'cm_agent_x', token: 'cm_agent_secret',
    });
    await settle();

    const row = mockInsertOne.mock.calls[0][0];
    expect(row).not.toHaveProperty('platform');
    expect(row).not.toHaveProperty('nodeMajor');
    expect(JSON.stringify(row)).not.toContain('cm_agent');
  });
});
