const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  req.userId = 'user-1';
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

jest.mock('../../../models/AgentProfile', () => ({
  updateOne: jest.fn(),
}));

const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

describe('registry tool policy update', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates tool policy on agent profile', async () => {
    Pod.findById.mockResolvedValue({
      _id: 'pod-1',
      createdBy: 'user-1',
      members: ['user-1'],
    });
    AgentInstallation.findOne.mockResolvedValue({
      agentName: 'openclaw',
      podId: 'pod-1',
      instanceId: 'default',
      status: 'active',
      save: jest.fn().mockResolvedValue(true),
    });

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({
        toolPolicy: {
          allowed: ['commonly', 'commonly_search'],
          blocked: ['commonly_write'],
          requireApproval: ['commonly_write'],
        },
      });

    expect(res.status).toBe(200);
    expect(AgentProfile.updateOne).toHaveBeenCalledWith(
      { agentId: 'openclaw:default', podId: 'pod-1' },
      expect.objectContaining({
        toolPolicy: {
          allowed: ['commonly', 'commonly_search'],
          blocked: ['commonly_write'],
          requireApproval: ['commonly_write'],
        },
      }),
    );
  });
});
