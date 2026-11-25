// F626: a hosted-MCP removal that fails after the vendor revoke answers fixed text
// per code, with `code` and `providerRevoked` intact; the cause goes to the log.
jest.mock('jsonwebtoken', () => ({}));
let mockDepsOverride = {};
jest.mock('../../../services/connectionRemovalService', () => {
  const actual = jest.requireActual('../../../services/connectionRemovalService');
  return {
    ...actual,
    removeConnection: (options) => actual.removeConnection({
      ...options,
      deps: { ...(options.deps || {}), ...mockDepsOverride },
    }),
  };
});

const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const id = req.get('x-test-user');
  if (!id) return res.status(401).json({ error: 'unauthorized' });
  // The route's own identity floor is the thing under test, so a sentinel lets
  // the caller be authenticated by the middleware and still carry no id.
  if (id === 'none') {
    req.user = {};
    return next();
  }
  req.user = { id };
  req.userId = id;
  return next();
});
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
  ingestIngressRateLimit: (_req, _res, next) => next(),
  ingestIntegrationsRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../services/discordService', () => jest.fn());
jest.mock('../../../models/ToolCall', () => ({
  listForGrant: jest.fn(),
  countsForGrant: jest.fn(),
}));
jest.mock('../../../controllers/podController', () => ({
  updatePodParent: jest.fn(),
  getAllPods: jest.fn(), getPodsByType: jest.fn(), getPodById: jest.fn(), createPod: jest.fn(),
  joinPod: jest.fn(), leavePod: jest.fn(), removeMember: jest.fn(), deletePod: jest.fn(),
}));
jest.mock('../../../services/dmService', () => ({
  canViewPod: jest.fn(async () => true),
}));

const User = require('../../../models/User');
const Pod = require('../../../models/Pod');

const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const LEAK = 'connection <db.internal.example:27017> timed out';

let mongod;
let Integration;
let app;
let errorSpy;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  Integration = require('../../../models/Integration');
  app = express();
  app.use(express.json());
  app.use('/api/integrations', require('../../../routes/integrations'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  await Integration.deleteMany({});
  User.findById.mockResolvedValue({ _id: OWNER, role: 'user' });
  Pod.findById.mockResolvedValue(null);
  mockDepsOverride = {};
});
afterEach(() => errorSpy.mockRestore());

const seedHostedRow = () => Integration.create({
  type: 'hosted-mcp',
  status: 'connected',
  scope: 'user',
  createdBy: OWNER,
  isActive: true,
  config: { entryId: 'linear', credentialRef: 'access-ref', refreshTokenRef: 'refresh-ref' },
});

describe('DELETE /api/integrations/:id hosted removal failures (F626)', () => {
  it('a database error after the vendor revoke answers fixed text, keeps code and providerRevoked', async () => {
    mockDepsOverride = {
      revokeAtVendor: jest.fn(async () => {}),
      secrets: {
        writeGenerationOf: jest.fn(async () => 1),
        get: jest.fn(async () => 'refresh-token-value'),
        revoke: jest.fn(async () => {}),
      },
      remove: jest.fn(async () => { throw new Error(LEAK); }),
    };
    const connection = await seedHostedRow();
    const res = await request(app).delete(`/api/integrations/${connection._id}`).set('x-test-user', OWNER);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('provider_revoked_removal_incomplete');
    expect(res.body.providerRevoked).toBe(true);
    expect(typeof res.body.message).toBe('string');
    expect(res.text).not.toContain('db.internal.example');
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('db.internal.example');
  });

  it('a secret-store error before the vendor call answers fixed text, keeps the code', async () => {
    mockDepsOverride = {
      secrets: {
        writeGenerationOf: jest.fn(async () => { throw new Error(LEAK); }),
        get: jest.fn(),
        revoke: jest.fn(),
      },
    };
    const connection = await seedHostedRow();
    const res = await request(app).delete(`/api/integrations/${connection._id}`).set('x-test-user', OWNER);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('provider_revoke_failed');
    expect(res.text).not.toContain('db.internal.example');
  });
});
