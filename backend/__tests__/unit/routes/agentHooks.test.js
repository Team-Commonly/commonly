const express = require('express');
const request = require('supertest');

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, _res, next) => {
  req.agentUser = { botMetadata: { agentName: 'Nova', instanceId: 'default' } };
  next();
});

const mockFindOne = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: (...args) => mockFindOne(...args) },
}));

const mockProcess = jest.fn();
jest.mock('../../../services/agentHookService', () => ({
  HOOK_EVENT_TYPES: ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop'],
  isHookEventType: (value) => ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop'].includes(value),
  processHookEvent: (...args) => mockProcess(...args),
}));

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', require('../../../routes/agentHooks'));

describe('HTTP hook ingress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindOne.mockResolvedValue({ status: 'active' });
    mockProcess.mockResolvedValue({
      statusCode: 200,
      response: { event: 'PreToolUse', eventId: 'evt-1', permissionDecision: 'allow' },
    });
  });

  test('requires a supported event and eventId', async () => {
    const unsupported = await request(app)
      .post('/api/agents/runtime/pods/p1/hooks')
      .send({ event: 'BeforeToolUse', eventId: 'evt-1' });
    expect(unsupported.status).toBe(400);

    const missingId = await request(app)
      .post('/api/agents/runtime/pods/p1/hooks')
      .send({ event: 'PreToolUse' });
    expect(missingId.status).toBe(400);
  });

  test('checks active installation in the URL pod before processing', async () => {
    mockFindOne.mockResolvedValue(null);
    const result = await request(app)
      .post('/api/agents/runtime/pods/p2/hooks')
      .send({ event: 'Stop', eventId: 'evt-1' });
    expect(result.status).toBe(403);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockFindOne).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'nova', podId: 'p2', status: 'active',
    }));
  });

  test('returns the service decision without echoing tool_input', async () => {
    const result = await request(app)
      .post('/api/agents/runtime/pods/p1/hooks')
      .send({
        event: 'PreToolUse', eventId: 'evt-1', tool_input: { file_path: 'secret.txt', token: 'do-not-echo' },
      });
    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({ permissionDecision: 'allow', eventId: 'evt-1' }));
    expect(JSON.stringify(result.body)).not.toContain('do-not-echo');
    expect(mockProcess).toHaveBeenCalledWith(expect.objectContaining({
      podId: 'p1',
      agentName: 'nova',
      payload: expect.not.objectContaining({ tool_input: expect.anything() }),
    }));
  });
});
