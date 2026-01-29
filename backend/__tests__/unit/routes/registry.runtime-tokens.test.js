const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { _id: 'user-1' };
  next();
});

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: {
    findOne: jest.fn(),
  },
}));

const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

describe('agent runtime tokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('issues a runtime token for an installed agent', async () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1',
        createdBy: 'user-1',
        members: ['user-1'],
      }),
    });

    const installation = {
      agentName: 'commonly-bot',
      podId: 'pod-1',
      status: 'active',
      runtimeTokens: [],
      save: jest.fn().mockResolvedValue(true),
    };

    AgentInstallation.findOne.mockResolvedValue(installation);

    const res = await request(app)
      .post('/api/registry/pods/pod-1/agents/commonly-bot/runtime-tokens')
      .send({ label: 'Local dev' });

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^cm_agent_/);
    expect(installation.runtimeTokens.length).toBe(1);
    expect(installation.save).toHaveBeenCalled();
  });
});
