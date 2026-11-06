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
});
