const request = require('supertest');
const express = require('express');

const mockMarkByoCommandCopied = jest.fn();
const mockMarkByoCopyType = jest.fn();
const mockMarkByoSetup = jest.fn();
const mockMarkSurface = jest.fn();
const mockInsertOne = jest.fn().mockResolvedValue({ acknowledged: true });
const mockPassThrough = () => (_req, _res, next) => next();

jest.mock('../../../models/Pod', () => ({ countDocuments: jest.fn() }));
jest.mock('../../../models/User', () => ({ countDocuments: jest.fn() }));
jest.mock('../../../models/Message', () => ({ countDocuments: jest.fn() }));
const mockInstallExists = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { distinct: jest.fn(), exists: (...args) => mockInstallExists(...args) },
}));
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.userId = 'human-1';
  next();
});
jest.mock('../../../services/onboardingMarks', () => ({
  markByoCommandCopied: (...args) => mockMarkByoCommandCopied(...args),
  markByoCopyType: (...args) => mockMarkByoCopyType(...args),
  markByoSetup: (...args) => mockMarkByoSetup(...args),
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

  it('records the daemon copy as telemetry only, with no onboarding copy mark', async () => {
    const res = await request(app)
      .post('/api/stats/byo-step')
      .send({ step: 'daemon-command-copied', command: 'commonly daemon register' });

    expect(res.status).toBe(200);
    expect(mockMarkByoCommandCopied).not.toHaveBeenCalled();
    expect(mockInsertOne).toHaveBeenCalledWith({
      userId: 'human-1',
      step: 'daemon-command-copied',
      at: expect.any(Date),
    });
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

  it('a copy step passes the copy type and the setup the page showed to the marks', async () => {
    const res = await request(app).post('/api/stats/byo-step')
      .send({ step: 'mcp-command-copied', copyType: 'mcp-claude', setupOs: 'mac', listenerAvailable: true });

    expect(res.status).toBe(200);
    expect(mockMarkByoCopyType).toHaveBeenCalledWith('human-1', 'mcp-claude');
    expect(mockMarkByoSetup).toHaveBeenCalledWith('human-1', { setupOs: 'mac', listenerAvailable: true });
    // The event row is unchanged: the copy type and setup stay out of telemetry.
    expect(mockInsertOne).toHaveBeenCalledWith(expect.objectContaining({
      step: 'mcp-command-copied',
      commandType: 'mcp',
    }));
    expect(JSON.stringify(mockInsertOne.mock.calls[0][0])).not.toContain('mcp-claude');
  });

  it('a non-copy step records the setup but never a copy type', async () => {
    await request(app).post('/api/stats/byo-step')
      .send({ step: 'seat-created', copyType: 'token', setupOs: 'windows', listenerAvailable: false });

    expect(mockMarkByoCopyType).not.toHaveBeenCalled();
    expect(mockMarkByoSetup).toHaveBeenCalledWith('human-1', { setupOs: 'windows', listenerAvailable: false });
  });

  it('other steps set no surface mark', async () => {
    await request(app).post('/api/stats/byo-step').send({ step: 'page-viewed' });
    expect(mockMarkSurface).not.toHaveBeenCalled();
  });

  it('a copy names its agent only when the person installed that agent in that pod', async () => {
    const podId = 'a'.repeat(24);
    mockInstallExists.mockResolvedValueOnce({ _id: 'inst1' });
    await request(app).post('/api/stats/byo-step')
      .send({ step: 'mcp-command-copied', copyType: 'mcp-claude', agentName: 'gridrunner', podId });
    expect(mockInstallExists).toHaveBeenCalledWith({ agentName: 'gridrunner', podId, installedBy: 'human-1' });
    expect(mockInsertOne).toHaveBeenLastCalledWith(expect.objectContaining({
      step: 'mcp-command-copied', agentName: 'gridrunner', podId,
    }));

    // Someone else's agent: the row is still written, without an agent.
    mockInstallExists.mockResolvedValueOnce(null);
    await request(app).post('/api/stats/byo-step')
      .send({ step: 'cli-command-copied', copyType: 'listen', agentName: 'theirbot', podId });
    const unowned = mockInsertOne.mock.calls[mockInsertOne.mock.calls.length - 1][0];
    expect(unowned).not.toHaveProperty('agentName');
    expect(unowned).not.toHaveProperty('podId');

    // A malformed name or pod is never looked up or stored.
    mockInstallExists.mockClear();
    await request(app).post('/api/stats/byo-step')
      .send({ step: 'mcp-command-copied', agentName: { $ne: null }, podId: 'x' });
    expect(mockInstallExists).not.toHaveBeenCalled();
    expect(mockInsertOne.mock.calls[mockInsertOne.mock.calls.length - 1][0]).not.toHaveProperty('agentName');

    // Non-copy steps never carry an agent.
    mockInstallExists.mockClear();
    await request(app).post('/api/stats/byo-step').send({ step: 'page-viewed', agentName: 'gridrunner', podId });
    expect(mockInstallExists).not.toHaveBeenCalled();
  });

  it('rejects seat-registered from the browser: the backend alone writes that row', async () => {
    const res = await request(app).post('/api/stats/byo-step').send({ step: 'seat-registered' });

    expect(res.status).toBe(400);
    expect(mockInsertOne).not.toHaveBeenCalled();
  });

  it('a copy type that does not match its step writes no per-type mark', async () => {
    await request(app).post('/api/stats/byo-step').send({ step: 'token-copied', copyType: 'listen' });
    await request(app).post('/api/stats/byo-step').send({ step: 'cli-command-copied', copyType: 'mcp-claude' });

    expect(mockMarkByoCopyType).not.toHaveBeenCalled();
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
