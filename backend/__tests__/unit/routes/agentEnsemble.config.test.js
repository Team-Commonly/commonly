const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  req.userId = 'user-1';
  next();
});

jest.mock('../../../services/agentEnsembleService', () => ({
  updateConfig: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(),
}));

const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentEnsembleService = require('../../../services/agentEnsembleService');
const agentEnsembleRoutes = require('../../../routes/agentEnsemble');

const app = express();
app.use(express.json());
app.use('/api/pods', agentEnsembleRoutes);

describe('agent ensemble config access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows global admin to update config', async () => {
    Pod.findById
      .mockResolvedValueOnce({
        _id: 'pod-1',
        type: 'agent-ensemble',
        createdBy: 'creator-1',
      })
      .mockResolvedValueOnce({
        _id: 'pod-1',
        agentEnsemble: { enabled: true },
      });

    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue({ _id: 'user-1', role: 'admin' }) });

    const res = await request(app)
      .patch('/api/pods/pod-1/ensemble/config')
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(AgentEnsembleService.updateConfig).toHaveBeenCalled();
  });

  it('blocks non-admin non-creator', async () => {
    Pod.findById.mockResolvedValue({
      _id: 'pod-1',
      type: 'agent-ensemble',
      createdBy: 'creator-1',
    });

    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue({ _id: 'user-1', role: 'member' }) });

    const res = await request(app)
      .patch('/api/pods/pod-1/ensemble/config')
      .send({ enabled: true });

    expect(res.status).toBe(403);
    expect(AgentEnsembleService.updateConfig).not.toHaveBeenCalled();
  });
});
