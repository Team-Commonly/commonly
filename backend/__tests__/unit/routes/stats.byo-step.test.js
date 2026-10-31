const request = require('supertest');
const express = require('express');

const mockMarkByoCommandCopied = jest.fn();
const mockMarkSurface = jest.fn();
const mockInsertOne = jest.fn().mockResolvedValue({ acknowledged: true });
const mockPassThrough = () => (_req, _res, next) => next();

jest.mock('../../../models/Pod', () => ({ countDocuments: jest.fn() }));
jest.mock('../../../models/User', () => ({ countDocuments: jest.fn() }));
jest.mock('../../../models/Message', () => ({ countDocuments: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { distinct: jest.fn() },
}));
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.userId = 'human-1';
  next();
});
jest.mock('../../../services/onboardingMarks', () => ({
  markByoCommandCopied: (...args) => mockMarkByoCommandCopied(...args),
  markSurface: (...args) => mockMarkSurface(...args),
}));
jest.mock('express-rate-limit', () => ({
  __esModule: true,
  default: mockPassThrough,
  rateLimit: mockPassThrough,
}));
jest.mock('../../../middleware/ipRateLimit', () => ({
  cloudflareIpRateLimitKeyGenerator: jest.fn(),
}));
jest.mock('mongoose', () => ({
  connection: { db: { collection: () => ({ insertOne: (...args) => mockInsertOne(...args) }) } },
}));

const statsRoutes = require('../../../routes/stats');

describe('POST /api/stats/byo-step', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/stats', statsRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records only the fixed command kind, never command or token contents', async () => {
    const res = await request(app)
      .post('/api/stats/byo-step')
      .send({ step: 'mcp-command-copied', command: 'cm_agent_secret' });

    expect(res.status).toBe(200);
    expect(mockMarkByoCommandCopied).toHaveBeenCalledWith('human-1', 'mcp');
    expect(mockInsertOne).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'human-1',
      step: 'mcp-command-copied',
      commandType: 'mcp',
      at: expect.any(Date),
    }));
    expect(JSON.stringify(mockInsertOne.mock.calls[0][0])).not.toContain('cm_agent_secret');
  });

  it.each(['hosted-offer-shown', 'hosted-offer-clicked'])('accepts %s without copied-command marks or extra payload', async (step) => {
    const res = await request(app).post('/api/stats/byo-step')
      .send({ step, command: 'fixture-only-secret', agentName: 'private-agent' });
    expect(res.status).toBe(200);
    expect(mockMarkByoCommandCopied).not.toHaveBeenCalled();
    expect(mockInsertOne).toHaveBeenCalledWith({ userId: 'human-1', step, at: expect.any(Date) });
  });

  it.each([
    ['invite-card-shown', 'inviteCardShownAt'],
    ['invite-card-dismissed', 'inviteCardDismissedAt'],
    ['byo-offer-shown', 'byoOfferShownAt'],
  ])('%s sets the %s mark and logs only the fixed step', async (step, mark) => {
    const res = await request(app).post('/api/stats/byo-step').send({ step, podId: 'p1' });
    expect(res.status).toBe(200);
    expect(mockMarkSurface).toHaveBeenCalledWith('human-1', mark);
    expect(mockMarkByoCommandCopied).not.toHaveBeenCalled();
    expect(mockInsertOne).toHaveBeenCalledWith({ userId: 'human-1', step, at: expect.any(Date) });
  });

  it('other steps set no surface mark', async () => {
    await request(app).post('/api/stats/byo-step').send({ step: 'page-viewed' });
    expect(mockMarkSurface).not.toHaveBeenCalled();
  });

  it('rejects seat-registered from the browser: the backend alone writes that row', async () => {
    const res = await request(app).post('/api/stats/byo-step').send({ step: 'seat-registered' });

    expect(res.status).toBe(400);
    expect(mockInsertOne).not.toHaveBeenCalled();
  });

  it('rejects unknown steps without writing a mark or telemetry event', async () => {
    const res = await request(app)
      .post('/api/stats/byo-step')
      .send({ step: 'command-copied' });

    expect(res.status).toBe(400);
    expect(mockMarkByoCommandCopied).not.toHaveBeenCalled();
    expect(mockMarkSurface).not.toHaveBeenCalled();
    expect(mockInsertOne).not.toHaveBeenCalled();
  });
});
