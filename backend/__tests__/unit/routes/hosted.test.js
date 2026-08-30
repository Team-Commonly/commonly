// /api/hosted — ownership (sole-installer), unconfigured 503, cap re-check,
// server-side mint → worker provision, and that secrets never reach the body.
const request = require('supertest');
const express = require('express');

const mockFindOne = jest.fn();
const mockUserFindOne = jest.fn();
const mockIssueToken = jest.fn();
const mockHosted = {
  HOSTED_RUNTIME_TYPE: 'hosted',
  isConfigured: jest.fn(),
  isHostedInstallation: jest.fn(),
  hostedCaps: jest.fn(() => ({ agentsPerUser: 1, turnsPerDay: 200 })),
  countHostedAgentsForUser: jest.fn(),
  meterAllowsTurn: jest.fn(),
  provisionAgent: jest.fn(),
  deprovisionAgent: jest.fn(),
  getAgentStatus: jest.fn(),
  HostedRuntimeError: class HostedRuntimeError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  },
};

jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: 'owner-1' };
  next();
});
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: (...args) => mockFindOne(...args) },
}));
jest.mock('../../../models/User', () => ({ findOne: (...args) => mockUserFindOne(...args) }));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: (name, instance) => (instance === 'default' ? name : `${name}-${instance}`),
}));
jest.mock('../../../services/hostedRuntimeService', () => mockHosted);
jest.mock('../../../routes/registry/tokens', () => ({
  issueRuntimeTokenForAgent: (...args) => mockIssueToken(...args),
}));

const hostedRouter = require('../../../routes/hosted');

const app = express();
app.use(express.json());
app.use('/api/hosted', hostedRouter);

const makeInstallation = (overrides = {}) => ({
  agentName: 'scout',
  instanceId: 'default',
  podId: 'pod-1',
  config: new Map([['runtime', { runtimeType: 'hosted' }]]),
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('/api/hosted', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHosted.isConfigured.mockReturnValue(true);
    mockHosted.isHostedInstallation.mockReturnValue(true);
    mockHosted.countHostedAgentsForUser.mockResolvedValue(1);
    mockUserFindOne.mockResolvedValue({ _id: 'bot-1', username: 'scout' });
    mockIssueToken.mockResolvedValue({ token: 'cm_agent_secret', existing: false });
    mockHosted.provisionAgent.mockResolvedValue({ provisioned: true });
  });

  it('reports availability and caps without the URL or bearer', async () => {
    const res = await request(app).get('/api/hosted/availability');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 } });
    mockHosted.isConfigured.mockReturnValue(false);
    const off = await request(app).get('/api/hosted/availability');
    expect(off.body.configured).toBe(false);
  });

  it('503s with a code when the runtime is not configured, before touching the DB', async () => {
    mockHosted.isConfigured.mockReturnValue(false);
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('hosted_runtime_unconfigured');
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('400s on a malformed agent name', async () => {
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'Bad Name!' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_agent_name');
  });

  it('404s unless the caller is the installer of an active installation', async () => {
    mockFindOne.mockResolvedValue(null);
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_owner_or_missing');
    expect(mockFindOne).toHaveBeenCalledWith({
      agentName: 'scout', instanceId: 'default', status: 'active', installedBy: 'owner-1',
    });
  });

  it('409s when the owned installation is not a hosted one', async () => {
    mockFindOne.mockResolvedValue(makeInstallation());
    mockHosted.isHostedInstallation.mockReturnValue(false);
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_hosted');
    expect(mockHosted.provisionAgent).not.toHaveBeenCalled();
  });

  it('403s when the owner is over the (possibly lowered) per-user cap', async () => {
    mockFindOne.mockResolvedValue(makeInstallation());
    mockHosted.countHostedAgentsForUser.mockResolvedValue(2);
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'hosted_cap_reached', used: 2, cap: 1 });
    expect(mockIssueToken).not.toHaveBeenCalled();
  });

  it('mints server-side with owner lineage, provisions, records, and never returns the token', async () => {
    const installation = makeInstallation();
    mockFindOne.mockResolvedValue(installation);
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'Scout', instanceId: 'Demo' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provisioned: true, agentName: 'scout', instanceId: 'demo', podId: 'pod-1' });
    expect(JSON.stringify(res.body)).not.toContain('cm_agent_secret');
    expect(mockUserFindOne).toHaveBeenCalledWith({ username: 'scout-demo', isBot: true });
    expect(mockIssueToken).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'bot-1' }), 'Hosted runtime', installation, { ownerUserId: 'owner-1' },
    );
    expect(mockHosted.provisionAgent).toHaveBeenCalledWith({ agentName: 'scout', instanceId: 'demo', runtimeToken: 'cm_agent_secret' });
    expect(installation.config.get('hosted').provisionedAt).toBeInstanceOf(Date);
    expect(installation.save).toHaveBeenCalled();
  });

  it('relays a worker failure as 502 and does not record a provision', async () => {
    const installation = makeInstallation();
    mockFindOne.mockResolvedValue(installation);
    mockHosted.provisionAgent.mockRejectedValue(new mockHosted.HostedRuntimeError('Hosted runtime unreachable: timeout', 502));
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('hosted_runtime_unreachable');
    expect(installation.save).not.toHaveBeenCalled();
  });

  it('deprovisions the owner\'s agent and keeps the installation', async () => {
    const installation = makeInstallation();
    mockFindOne.mockResolvedValue(installation);
    mockHosted.deprovisionAgent.mockResolvedValue({ deprovisioned: true });
    const res = await request(app).post('/api/hosted/deprovision').send({ agentName: 'scout' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deprovisioned: true });
    expect(installation.config.get('hosted').provisionedAt).toBeNull();
    expect(installation.save).toHaveBeenCalled();
  });

  it('reports runtime status together with today\'s meter for the owner', async () => {
    mockFindOne.mockResolvedValue(makeInstallation());
    mockHosted.getAgentStatus.mockResolvedValue({ agentName: 'scout', lastPollAt: 1 });
    mockHosted.meterAllowsTurn.mockResolvedValue({ allowed: true, used: 3, cap: 200 });
    const res = await request(app).get('/api/hosted/status').query({ agentName: 'scout' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runtime: { lastPollAt: 1 }, meter: { used: 3, cap: 200 } });
  });
});
