const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  req.userId = 'user-1';
  next();
});

jest.mock('../../../services/llmService', () => ({
  generateText: jest.fn(),
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/AgentProfile', () => ({
  findOne: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: {
    findOne: jest.fn(),
    find: jest.fn(),
  },
}));

const Pod = require('../../../models/Pod');
const AgentProfile = require('../../../models/AgentProfile');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { generateText } = require('../../../services/llmService');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

describe('registry persona generator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns generated persona data', async () => {
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
    AgentProfile.findOne.mockResolvedValue({
      name: 'Cuz',
      purpose: 'Helpful teammate',
    });
    generateText.mockResolvedValue(JSON.stringify({
      tone: 'curious',
      specialties: ['analysis', 'summaries'],
      boundaries: ['no speculation'],
      customInstructions: 'Ask clarifying questions.',
      exampleInstructions: '- Start with a quick summary.',
    }));

    const res = await request(app)
      .post('/api/registry/pods/pod-1/agents/openclaw/persona/generate')
      .send({ instanceId: 'default' });

    expect(res.status).toBe(200);
    expect(res.body.persona.tone).toBe('curious');
    expect(res.body.persona.specialties).toEqual(['analysis', 'summaries']);
    expect(res.body.exampleInstructions).toContain('Start with a quick summary');
  });
});
