const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1', role: 'admin' };
  req.userId = 'user-1';
  next();
});

jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/PodAsset', () => ({}));

jest.mock('../../../models/Gateway', () => ({
  findById: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
  },
}));

jest.mock('../../../services/agentProvisionerService', () => ({
  getOpenClawConfigPath: jest.fn(),
  syncOpenClawSkills: jest.fn(),
  getGatewaySkillEntries: jest.fn(),
  syncGatewaySkillEnv: jest.fn(),
}));

jest.mock('../../../services/skillsCatalogService', () => ({
  fetchSkillContentFromSource: jest.fn(),
  getCachedCatalog: jest.fn(),
}));

const Gateway = require('../../../models/Gateway');
const {
  getGatewaySkillEntries,
  syncGatewaySkillEnv,
} = require('../../../services/agentProvisionerService');
const skillsRoutes = require('../../../routes/skills');

const app = express();
app.use(express.json());
app.use('/api/skills', skillsRoutes);

describe('skills gateway credentials routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads credentials for k8s gateway via provisioner service', async () => {
    Gateway.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'gateway-1',
        mode: 'k8s',
        slug: 'dev',
      }),
    });
    getGatewaySkillEntries.mockResolvedValue({
      tavily: { envKeys: ['TAVILY_API_KEY'], apiKeyPresent: true, rawKeys: [] },
    });

    const res = await request(app)
      .get('/api/skills/gateway-credentials?gatewayId=gateway-1');

    expect(res.status).toBe(200);
    expect(getGatewaySkillEntries).toHaveBeenCalledWith({
      gateway: expect.objectContaining({ _id: 'gateway-1', mode: 'k8s' }),
    });
    expect(res.body.entries).toEqual({
      tavily: { envKeys: ['TAVILY_API_KEY'], apiKeyPresent: true, rawKeys: [] },
    });
  });

  it('writes credentials for k8s gateway via provisioner service', async () => {
    Gateway.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'gateway-1',
        mode: 'k8s',
        slug: 'dev',
      }),
    });
    syncGatewaySkillEnv.mockResolvedValue({
      tavily: { envKeys: ['TAVILY_API_KEY'], apiKeyPresent: true, rawKeys: [] },
    });

    const res = await request(app)
      .patch('/api/skills/gateway-credentials')
      .send({
        gatewayId: 'gateway-1',
        entries: {
          tavily: { apiKey: 'secret-key' },
        },
      });

    expect(res.status).toBe(200);
    expect(syncGatewaySkillEnv).toHaveBeenCalledWith({
      gateway: expect.objectContaining({ _id: 'gateway-1', mode: 'k8s' }),
      entries: { tavily: { apiKey: 'secret-key' } },
    });
    expect(res.body.entries).toEqual({
      tavily: { envKeys: ['TAVILY_API_KEY'], apiKeyPresent: true, rawKeys: [] },
    });
  });
});
