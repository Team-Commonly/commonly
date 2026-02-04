const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  req.userId = 'user-1';
  next();
});

jest.mock('../../../services/agentProvisionerService', () => ({
  writeOpenClawHeartbeatFile: jest.fn(),
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: {
    findOne: jest.fn(),
    find: jest.fn(),
  },
}));

const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { writeOpenClawHeartbeatFile } = require('../../../services/agentProvisionerService');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

describe('registry heartbeat file updates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes heartbeat file for openclaw agents', async () => {
    Pod.findById.mockResolvedValue({
      _id: 'pod-1',
      createdBy: 'user-1',
      members: ['user-1'],
    });
    AgentInstallation.findOne.mockResolvedValue({
      agentName: 'openclaw',
      podId: 'pod-1',
      instanceId: 'default',
      displayName: 'Cuz',
    });
    writeOpenClawHeartbeatFile.mockReturnValue('/tmp/HEARTBEAT.md');

    const res = await request(app)
      .post('/api/registry/pods/pod-1/agents/openclaw/heartbeat-file')
      .send({ instanceId: 'default', content: '- Check updates' });

    expect(res.status).toBe(200);
    expect(writeOpenClawHeartbeatFile).toHaveBeenCalled();
  });
});
