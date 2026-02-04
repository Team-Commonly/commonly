const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  req.userId = 'user-1';
  next();
});

jest.mock('../../../services/agentEnsembleService', () => ({
  completeActiveForPod: jest.fn(),
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

const Pod = require('../../../models/Pod');
const AgentEnsembleService = require('../../../services/agentEnsembleService');
const agentEnsembleRoutes = require('../../../routes/agentEnsemble');

const app = express();
app.use(express.json());
app.use('/api/pods', agentEnsembleRoutes);

describe('agent ensemble complete route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('completes active/paused discussions for pod', async () => {
    Pod.findById.mockResolvedValue({
      _id: 'pod-1',
      type: 'agent-ensemble',
      createdBy: 'user-1',
      members: ['user-1'],
    });

    AgentEnsembleService.completeActiveForPod.mockResolvedValue({
      _id: 'state-1',
      status: 'completed',
      stats: { completionReason: 'manual', totalMessages: 3 },
      summary: { content: 'done' },
    });

    const res = await request(app)
      .post('/api/pods/pod-1/ensemble/complete')
      .send({});

    expect(res.status).toBe(200);
    expect(AgentEnsembleService.completeActiveForPod).toHaveBeenCalledWith('pod-1', 'manual');
  });

  it('returns error when no active discussion exists', async () => {
    Pod.findById.mockResolvedValue({
      _id: 'pod-1',
      type: 'agent-ensemble',
      createdBy: 'user-1',
      members: ['user-1'],
    });

    AgentEnsembleService.completeActiveForPod.mockRejectedValue(new Error('No active discussion to complete'));

    const res = await request(app)
      .post('/api/pods/pod-1/ensemble/complete')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No active discussion to complete');
  });
});
