const express = require('express');
const request = require('supertest');

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../middleware/auth', () => (_req, _res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (_req, _res, next) => next(),
}));
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, _res, next) => {
  req.agentUser = { _id: 'bot-1', botMetadata: { agentName: 'pixel', instanceId: 'default' } };
  req.agentInstallations = [{ agentName: 'pixel', instanceId: 'default', podId: 'pod-1', installedBy: 'human-1' }];
  req.agentAuthorizedPodIds = ['pod-1'];
  next();
});

const mockMaybePost = jest.fn(async () => {});
jest.mock('../../../services/firstAgentIntroService', () => ({
  maybePostFirstAgentIntro: (...args) => mockMaybePost(...args),
}));
jest.mock('../../../services/agentEventService', () => ({
  listInboxPage: jest.fn(async () => ({ events: [], inboxCount: 0 })),
}));
jest.mock('../../../models/Pod', () => ({
  find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
}));

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', require('../../../routes/agentsRuntime'));

beforeEach(() => mockMaybePost.mockClear());

test('token verification does not announce before the listener polls events', async () => {
  const response = await request(app).get('/api/agents/runtime/installations');
  expect(response.status).toBe(200);
  expect(mockMaybePost).not.toHaveBeenCalled();
});

test('an authenticated event poll checks for the first-agent intro', async () => {
  const response = await request(app).get('/api/agents/runtime/events');
  expect(response.status).toBe(200);
  expect(mockMaybePost).toHaveBeenCalledWith('pixel', 'default', [
    expect.objectContaining({ podId: 'pod-1', installedBy: 'human-1' }),
  ]);
});

test('an intro failure does not stop the listener from polling', async () => {
  mockMaybePost.mockRejectedValueOnce(new Error('intro unavailable'));

  const response = await request(app).get('/api/agents/runtime/events');

  expect(response.status).toBe(200);
  expect(response.body.events).toEqual([]);
});
