/**
 * The /bot/* routes take the agent's name and instance from the query or
 * body, and a pod id from a param or body, and use them in Mongo filters.
 * Express hands an array for a repeated key and an object for `key[op]=`,
 * which a filter would read as an operator, so these values are taken only
 * as strings (a pod id only as an ObjectId) and nothing else reaches a query.
 */
const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.userId = 'bot-user';
  next();
});
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res) => res.status(401).end());

const mockUserFindById = jest.fn();
const mockInstallFind = jest.fn();
const mockInstallFindOne = jest.fn();
const mockPodFind = jest.fn();
const mockPodFindOne = jest.fn();
const mockPostFindById = jest.fn();
const mockEventList = jest.fn();
const mockAcknowledge = jest.fn();
jest.mock('../../../services/agentEventService', () => ({
  list: (...a) => mockEventList(...a),
  acknowledge: (...a) => mockAcknowledge(...a),
  isSupersededDelivery: jest.fn().mockResolvedValue(false),
  isDeliveryNonceRequired: jest.fn().mockReturnValue(false),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: (agentName, instanceId) => (instanceId === 'default' ? agentName : `${agentName}-${instanceId}`),
}));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../services/messageClaimService', () => ({}));
jest.mock('../../../services/agentTypingService', () => ({}));
jest.mock('../../../services/dmService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({ findById: (...a) => mockUserFindById(...a) }));
jest.mock('../../../models/Post', () => ({ findById: (...a) => mockPostFindById(...a) }));
jest.mock('../../../models/Pod', () => ({
  find: (...a) => mockPodFind(...a),
  findOne: (...a) => mockPodFindOne(...a),
}));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: (...a) => mockInstallFind(...a),
    findOne: (...a) => mockInstallFindOne(...a),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', require('../../../routes/agentsRuntime'));

const BASE = '/api/agents/runtime';
const podId = String(new mongoose.Types.ObjectId());
const lean = (value) => ({ lean: () => Promise.resolve(value) });
const chain = (value) => ({ select: () => lean(value), sort: () => lean(value), lean: () => Promise.resolve(value) });

const noQueryRan = () => {
  expect(mockInstallFind).not.toHaveBeenCalled();
  expect(mockInstallFindOne).not.toHaveBeenCalled();
  expect(mockPodFind).not.toHaveBeenCalled();
  expect(mockPodFindOne).not.toHaveBeenCalled();
  expect(mockEventList).not.toHaveBeenCalled();
  expect(mockAcknowledge).not.toHaveBeenCalled();
};

describe('/bot/* identity and pod id inputs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserFindById.mockReturnValue(lean({
      _id: 'bot-user',
      isBot: true,
      username: 'pixel',
      botMetadata: { agentName: 'pixel', instanceId: 'default' },
    }));
    mockInstallFind.mockReturnValue(chain([]));
    mockInstallFindOne.mockReturnValue(chain(null));
    mockPodFind.mockReturnValue(chain([]));
    mockPodFindOne.mockReturnValue(chain(null));
  });

  // Query strings parse with qs: a repeated key is an array, `key[op]=` an object.
  test.each([
    ['GET', `/bot/events?instanceId[$ne]=x`, null],
    ['GET', `/bot/pods/${podId}/context?agentName=pixel&agentName=nova`, null],
    ['GET', `/bot/pods/${podId}/messages?agentName[$gt]=`, null],
    ['POST', '/bot/events/evt-1/ack', { instanceId: { $ne: 'x' } }],
    ['POST', `/bot/pods/${podId}/messages`, { agentName: ['pixel'], content: 'hi' }],
    ['POST', `/bot/threads/${podId}/comments`, { instanceId: ['default'], content: 'hi' }],
  ])('%s %s refuses a non-string agentName or instanceId before any query', async (method, path, body) => {
    const call = method === 'GET' ? request(app).get(`${BASE}${path}`) : request(app).post(`${BASE}${path}`).send(body);
    const res = await call;

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('agentName and instanceId must be strings');
    noQueryRan();
  });

  test('string identity values still reach the installation query unchanged', async () => {
    const res = await request(app).get(`${BASE}/bot/pods/${podId}/messages?agentName=pixel&instanceId=default`);

    expect(res.status).toBe(403);
    expect(mockInstallFindOne).toHaveBeenCalledWith({
      agentName: 'pixel',
      podId,
      instanceId: 'default',
      status: { $in: ['active', 'paused'] },
    });
  });

  test('a pod param that is not an ObjectId finds no installation and runs no query', async () => {
    const res = await request(app).get(`${BASE}/bot/pods/not-a-pod/messages`);

    expect(res.status).toBe(403);
    noQueryRan();
  });

  test('a body pod id that is an object finds no installation for a thread without a pod', async () => {
    mockPostFindById.mockReturnValue(chain({ _id: 'thread-1', podId: null }));

    const res = await request(app)
      .post(`${BASE}/bot/threads/thread-1/comments`)
      .send({ content: 'hi', podId: { $ne: null } });

    expect(res.status).toBe(403);
    noQueryRan();
  });

  test('POST /dm refuses a pod id that is not an ObjectId before any query', async () => {
    const res = await request(app).post(`${BASE}/dm`).send({ agentName: 'pixel', podId: { $ne: null } });

    expect(res.status).toBe(400);
    noQueryRan();
  });

  test('the bot routes now sit behind the per-token limiter: the 121st call in a minute is 429', async () => {
    mockUserFindById.mockReturnValue(lean({ isBot: false }));
    const statuses = [];
    for (let i = 0; i < 121; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .post(`${BASE}/bot/events/evt-1/ack`)
        .set('cf-connecting-ip', '198.51.100.9')
        .set('Authorization', 'Bearer bot-limit-token');
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 120).every((s) => s === 403)).toBe(true);
    expect(statuses[120]).toBe(429);
  }, 30_000);
});
