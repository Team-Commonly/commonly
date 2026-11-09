const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'admin-1' };
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: { find: jest.fn() },
}));
jest.mock('../../../routes/registry/reprovision', () => ({ reprovisionInstallation: jest.fn() }));
const mockResolveGateway = jest.fn();
jest.mock('../../../routes/registry/helpers', () => ({
  ...jest.requireActual('../../../routes/registry/helpers'),
  resolveGatewayForInstallation: (...args) => mockResolveGateway(...args),
}));
jest.mock('../../../services/agentProvisionerService', () => ({
  ...jest.requireActual('../../../services/agentProvisionerService'),
  restartAgentRuntime: jest.fn().mockResolvedValue({ restarted: true }),
}));

const { AgentInstallation } = require('../../../models/AgentRegistry');
const { reprovisionInstallation } = require('../../../routes/registry/reprovision');
const { restartAgentRuntime } = require('../../../services/agentProvisionerService');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

describe('POST /admin/installations/reprovision-all', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentInstallation.find.mockReturnValue({ sort: () => ({ limit: async () => [{ _id: 'a' }, { _id: 'b' }] }) });
  });

  it('reports a skipped install as skipped, and restarts nothing for it', async () => {
    reprovisionInstallation.mockResolvedValue({
      installationId: 'a', agentName: 'openclaw', runtimeType: 'moltbot', skipped: true, skipReason: 'keeps_its_own_token',
    });

    const res = await request(app).post('/api/registry/admin/installations/reprovision-all').send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true, attempted: 2, succeeded: 0, failed: 0, skipped: 2, 
    });
    expect(res.body.items[0]).toMatchObject({ skipped: true, skipReason: 'keeps_its_own_token' });
    expect(restartAgentRuntime).not.toHaveBeenCalled();
  });

  it('restarts the shared gateway once for rows it did provision', async () => {
    reprovisionInstallation.mockResolvedValue({ installationId: 'a', agentName: 'openclaw', runtimeType: 'moltbot' });

    const res = await request(app).post('/api/registry/admin/installations/reprovision-all').send({});

    expect(res.body).toMatchObject({ succeeded: 2, skipped: 0 });
    expect(restartAgentRuntime).toHaveBeenCalledTimes(1);
  });

  it('a run that only removed refused accounts restarts the gateway once', async () => {
    reprovisionInstallation.mockResolvedValue({
      installationId: 'a',
      agentName: 'openclaw',
      runtimeType: 'moltbot',
      skipped: true,
      skipReason: 'cloud_agents_not_entitled',
      removedFromRuntime: true,
      runtimeRestartNeeded: true,
      runtimeGatewayId: null,
    });

    const res = await request(app).post('/api/registry/admin/installations/reprovision-all').send({});

    expect(res.body).toMatchObject({ success: true, skipped: 2, failed: 0 });
    expect(restartAgentRuntime).toHaveBeenCalledTimes(1);
    expect(restartAgentRuntime).toHaveBeenCalledWith('moltbot', 'default', {});
  });

  it('a removal on a gateway of its own restarts that gateway, and a failed state edit reads as failed', async () => {
    const gateway = { _id: 'gw-1', slug: 'team' };
    mockResolveGateway.mockResolvedValue(gateway);
    reprovisionInstallation
      .mockResolvedValueOnce({
        installationId: 'a',
        agentName: 'openclaw',
        runtimeType: 'moltbot',
        skipped: true,
        skipReason: 'cloud_agents_not_entitled',
        removedFromRuntime: true,
        runtimeRestartNeeded: true,
        runtimeGatewayId: 'gw-1',
        runtimeRemovalError: 'The state file edit failed.',
      })
      .mockResolvedValueOnce({
        installationId: 'b',
        agentName: 'openclaw',
        runtimeType: 'moltbot',
        skipped: true,
        skipReason: 'cloud_agents_not_entitled',
        removedFromRuntime: true,
        runtimeRestartNeeded: true,
        runtimeGatewayId: 'gw-1',
      });

    const res = await request(app).post('/api/registry/admin/installations/reprovision-all').send({});

    expect(restartAgentRuntime).toHaveBeenCalledTimes(1);
    expect(mockResolveGateway).toHaveBeenCalledWith({ gatewayId: 'gw-1' });
    expect(restartAgentRuntime).toHaveBeenCalledWith('moltbot', 'default', { gateway });
    expect(res.body).toMatchObject({
      success: false, attempted: 2, succeeded: 0, failed: 1, skipped: 1,
    });
    expect(res.body.items[0]).toMatchObject({ success: false, error: 'The state file edit failed.' });
    // Not even the gateway's id goes out in the response.
    expect(res.body.items[0].runtimeGatewayId).toBeUndefined();
  });

  // The next run finds the ConfigMap clean and queues no restart, so a removal
  // whose restart failed has to read as failed now.
  const removedOn = (installationId, runtimeGatewayId) => ({
    installationId,
    agentName: 'openclaw',
    runtimeType: 'moltbot',
    skipped: true,
    skipReason: 'cloud_agents_not_entitled',
    removedFromRuntime: true,
    runtimeRestartNeeded: true,
    runtimeGatewayId,
  });

  it('a removal whose gateway cannot be found again reads as failed, and nothing restarts', async () => {
    mockResolveGateway.mockRejectedValue(new Error('gateway lookup failed'));
    reprovisionInstallation.mockResolvedValueOnce(removedOn('a', 'gw-1')).mockResolvedValueOnce(removedOn('b', 'gw-2'));
    mockResolveGateway.mockResolvedValueOnce({ _id: 'gw-1', slug: 'team' });

    const res = await request(app).post('/api/registry/admin/installations/reprovision-all').send({});

    expect(restartAgentRuntime).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ success: false, failed: 1, skipped: 1 });
    expect(res.body.items[0]).toMatchObject({ installationId: 'a', success: true });
    expect(res.body.items[1]).toMatchObject({ installationId: 'b', success: false });
    expect(res.body.items[1].error).toMatch(/gateway restart failed \(gateway lookup failed\)/);
  });

  it('a named gateway whose restart reports a failure reads as failed', async () => {
    mockResolveGateway.mockResolvedValue({ _id: 'gw-1', slug: 'team' });
    restartAgentRuntime.mockResolvedValueOnce({ restarted: false, reason: 'conflict' });
    reprovisionInstallation.mockResolvedValue(removedOn('a', 'gw-1'));

    const res = await request(app).post('/api/registry/admin/installations/reprovision-all').send({});

    expect(res.body).toMatchObject({ success: false, failed: 2, skipped: 0 });
    expect(res.body.items[0].error).toMatch(/gateway restart failed \(conflict\)/);
  });

  it('a removal that found no Deployment owes no restart and reads as removed', async () => {
    reprovisionInstallation.mockResolvedValue({ ...removedOn('a', 'gw-1'), runtimeRestartNeeded: false });

    const res = await request(app).post('/api/registry/admin/installations/reprovision-all').send({});

    expect(restartAgentRuntime).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ success: true, failed: 0, skipped: 2 });
    expect(res.body.items[0].runtimeRestartNeeded).toBeUndefined();
  });

  it('a removal whose shared gateway restart fails reads as failed, keeping any state error', async () => {
    // The real restartAgentRuntime reports a failure this way; it never throws.
    restartAgentRuntime.mockResolvedValueOnce({ restarted: false, reason: 'restart refused' });
    reprovisionInstallation
      .mockResolvedValueOnce({ ...removedOn('a', null), runtimeRemovalError: 'The state file edit failed.' })
      .mockResolvedValueOnce(removedOn('b', null));

    const res = await request(app).post('/api/registry/admin/installations/reprovision-all').send({});

    expect(res.body).toMatchObject({ success: false, failed: 2, skipped: 0 });
    expect(res.body.items[0].error).toMatch(/^The state file edit failed\. The account was removed/);
    expect(res.body.items[1].error).toMatch(/gateway restart failed \(restart refused\)/);
  });
});
