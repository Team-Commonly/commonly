const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  req.userId = 'user-1';
  next();
});

jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

jest.mock('../../../services/agentProvisionerService', () => ({
  provisionAgentRuntime: jest.fn(),
  startAgentRuntime: jest.fn(),
  stopAgentRuntime: jest.fn(),
  restartAgentRuntime: jest.fn(),
  getAgentRuntimeStatus: jest.fn(),
  getAgentRuntimeLogs: jest.fn(),
  isK8sMode: jest.fn(() => true),
  listOpenClawPlugins: jest.fn(),
  listOpenClawBundledSkills: jest.fn(),
  installOpenClawPlugin: jest.fn(),
  writeOpenClawHeartbeatFile: jest.fn(),
  syncOpenClawSkills: jest.fn(),
}));

const { listOpenClawBundledSkills } = require('../../../services/agentProvisionerService');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

describe('registry bundled OpenClaw skills', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists bundled skills from provisioner', async () => {
    listOpenClawBundledSkills.mockResolvedValue({
      skills: [{ name: 'github' }, { name: 'tavily' }],
      deployment: 'clawdbot-gateway',
    });

    const res = await request(app)
      .get('/api/registry/openclaw/bundled-skills');

    expect(res.status).toBe(200);
    expect(res.body.skills).toEqual([{ name: 'github' }, { name: 'tavily' }]);
    expect(res.body.deployment).toBe('clawdbot-gateway');
    expect(listOpenClawBundledSkills).toHaveBeenCalledWith({ gateway: null });
  });
});
