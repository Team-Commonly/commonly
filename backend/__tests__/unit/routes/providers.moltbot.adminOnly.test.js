// Every /api/providers/moltbot route acts through the instance's single moltbot
// provider, which the first /connect configures (gateway and API token). The
// router is therefore admin-only. adminAuth is the real middleware here; the
// provider module is mocked so "nothing was touched" is asserted on it.
const request = require('supertest');
const express = require('express');

let mockCaller = 'member-1';

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: mockCaller };
  next();
});
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));

const mockProvider = {
  initialize: jest.fn().mockResolvedValue(undefined),
  shutdown: jest.fn(),
  pushEvent: jest.fn(),
  getContext: jest.fn().mockResolvedValue({}),
  search: jest.fn().mockResolvedValue([]),
  write: jest.fn().mockResolvedValue({}),
  connection: { connected: true },
};
jest.mock('../../../providers/moltbot', () => ({
  getMoltbotProvider: jest.fn(() => mockProvider),
  ProviderManifest: { name: 'commonly' },
}));

const User = require('../../../models/User');
const { getMoltbotProvider } = require('../../../providers/moltbot');
const moltbotRoutes = require('../../../routes/providers/moltbot');

const app = express();
app.use(express.json());
app.use('/api/providers/moltbot', moltbotRoutes);

const setRole = (role) => User.findById.mockResolvedValue({ _id: mockCaller, role });

beforeEach(() => {
  jest.clearAllMocks();
  mockCaller = 'member-1';
  setRole('user');
});

const ROUTES = [
  ['post', '/connect', { gatewayUrl: 'ws://gateway.example.test', apiToken: 'tok' }],
  ['get', '/', undefined],
  ['post', '/disconnect', {}],
  ['post', '/push', { eventType: 'x', payload: {} }],
  ['get', '/context/pod-1', undefined],
  ['post', '/search/pod-1', { query: 'q' }],
  ['post', '/write/pod-1', { target: 'memory', content: 'c' }],
];

describe('moltbot provider routes are admin-only', () => {
  test.each(ROUTES)('a non-admin %s %s is a 403 and never reaches the provider', async (method, path, body) => {
    const res = await request(app)[method](`/api/providers/moltbot${path}`).send(body);

    expect(res.status).toBe(403);
    expect(getMoltbotProvider).not.toHaveBeenCalled();
    Object.values(mockProvider)
      .filter((value) => typeof value === 'function')
      .forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  test('an admin can connect, and the provider is configured from the request', async () => {
    mockCaller = 'admin-1';
    setRole('admin');

    const res = await request(app)
      .post('/api/providers/moltbot/connect')
      .send({ gatewayUrl: 'ws://gateway.example.test', apiToken: 'tok', defaultPodId: 'pod-1' });

    expect(res.status).toBe(200);
    expect(getMoltbotProvider).toHaveBeenCalledWith({
      gatewayUrl: 'ws://gateway.example.test', apiToken: 'tok', defaultPodId: 'pod-1',
    });
    expect(mockProvider.initialize).toHaveBeenCalledTimes(1);
  });

  test('an admin reaches a pod-scoped route', async () => {
    mockCaller = 'admin-1';
    setRole('admin');

    const res = await request(app).get('/api/providers/moltbot/context/pod-1');

    expect(res.status).toBe(200);
    expect(mockProvider.getContext).toHaveBeenCalledWith('pod-1', { task: undefined });
  });
});
