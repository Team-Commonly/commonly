// TASK-145 — the removal witness for `DELETE /api/integrations/:id`.
//
// Measured before the fix: the route deleted the row and nothing else, and the
// grant on it stayed `active`. The granter's own revoke route then answered 403
// `access_denied`, because ownership is resolved through `findConnection`
// (routes/grants.ts:421) and the row was gone — so the grants on a removed
// connection could never be ended by anyone (tools plan §10.5: the grants step
// runs before the material goes).
//
// Integration and RoomGrant are real rows on memory Mongo; the identity, the
// pod read and the Discord service are mocked at their module boundaries.
// testUtils and the routers pull jsonwebtoken, whose Node-version-incompatible
// SlowBuffer dependency is irrelevant to these suites.
jest.mock('jsonwebtoken', () => ({}));

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
}));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../services/discordService', () => jest.fn());
jest.mock('../../../models/ToolCall', () => ({
  listForGrant: jest.fn(),
  countsForGrant: jest.fn(),
}));
jest.mock('../../../controllers/podController', () => ({
  getAllPods: jest.fn(), getPodsByType: jest.fn(), getPodById: jest.fn(), createPod: jest.fn(),
  joinPod: jest.fn(), leavePod: jest.fn(), removeMember: jest.fn(), deletePod: jest.fn(),
}));
jest.mock('../../../services/dmService', () => ({
  canViewPod: jest.fn(async () => true),
}));

const User = require('../../../models/User');
const Pod = require('../../../models/Pod');

const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const OTHER_OWNER = 'bbbbbbbbbbbbbbbbbbbbbb02';
const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';

let mongod;
let Integration;
let RoomGrant;
let app;

const grantFixture = (overrides = {}) => ({
  grantId: new mongoose.Types.ObjectId().toString(),
  connectionId: 'placeholder',
  installationId: 'install-1',
  target: { kind: 'pod', id: POD },
  tools: ['github.list_issues'],
  writeMode: 'read',
  audience: [OWNER],
  expiresAt: new Date(Date.now() + 3_600_000),
  brokerId: 'github-app',
  ...overrides,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  Integration = require('../../../models/Integration');
  RoomGrant = require('../../../models/RoomGrant');
  await RoomGrant.syncIndexes();
  await Integration.syncIndexes();
  app = express();
  app.use(express.json());
  app.use('/api/integrations', require('../../../routes/integrations'));
  app.use('/api/grants', require('../../../routes/grants'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await RoomGrant.deleteMany({});
  await Integration.deleteMany({});
  User.findById.mockResolvedValue({ _id: OWNER, role: 'user' });
  Pod.findById.mockResolvedValue(null);
});

const seedConnection = async () => Integration.create({
  type: 'telegram',
  status: 'connected',
  podId: POD,
  createdBy: OWNER,
  isActive: true,
  installationId: 'install-live-1',
  config: { installationId: 'install-config-1', chatId: '42', liveRelay: true, linkedUserId: OWNER },
});

describe('DELETE /api/integrations/:id ends the connection\'s grants first', () => {
  it('removes the connection and leaves every grant on it revoked, recorded', async () => {
    const connection = await seedConnection();
    // Each fixture carries one of the two keys `resolveConnection` reads off
    // `grant.connectionId` (toolBrokerService.ts:446-451): the row's `_id` for
    // `findById`, the connection's top-level `installationId` for
    // `findOne({ installationId })`. A sweep that matched only one of them
    // would leave a grant the broker still honours.
    const root = grantFixture({ connectionId: String(connection._id), installationId: 'install-none-a' });
    // A second ROOT grant, so the lineage cascade cannot mask a missed
    // identifier: only the match itself can end this one.
    const second = grantFixture({ connectionId: 'install-live-1', installationId: 'install-none-b' });
    const child = grantFixture({
      connectionId: String(connection._id),
      installationId: 'install-none-c',
      parentGrantId: root.grantId,
    });
    const unrelated = grantFixture({
      connectionId: 'conn-other',
      installationId: 'install-other',
      audience: [OTHER_OWNER],
    });
    await RoomGrant.create([root, second, child, unrelated]);

    // The witness is the post-state, not the returned count: `revokeCascade`
    // counts only rows it moved, so 0 also describes "found none" (Vera 74459).
    const stillLive = () => RoomGrant.countDocuments({
      $or: [
        { connectionId: { $in: [String(connection._id), 'install-live-1'] } },
        { installationId: { $in: [String(connection._id), 'install-live-1'] } },
      ],
      revokedAt: null,
    });
    expect(await stillLive()).toBe(3);

    const res = await request(app)
      .delete(`/api/integrations/${connection._id}`)
      .set('x-test-user', OWNER);

    expect(res.status).toBe(200);
    expect(await Integration.findById(connection._id)).toBeNull();
    expect(await stillLive()).toBe(0);

    for (const grant of [root, second, child]) {
      const row = await RoomGrant.findOne({ grantId: grant.grantId }).lean();
      expect(row.revokedAt).toBeInstanceOf(Date);
      expect(row.revokedBy).toBe(OWNER);
    }
    const untouched = await RoomGrant.findOne({ grantId: unrelated.grantId }).lean();
    expect(untouched.revokedAt).toBeNull();
  });

  it('records the revocation even though the grant is no longer revocable through the route afterwards', async () => {
    const connection = await seedConnection();
    const root = grantFixture({ connectionId: String(connection._id) });
    await RoomGrant.create(root);

    await request(app).delete(`/api/integrations/${connection._id}`).set('x-test-user', OWNER);

    // The sequence this test exists for: remove, then revoke. The route still
    // 403s — the connection row is gone, so `findConnection` cannot resolve the
    // caller's ownership — but the grant is already dead, so nothing is left
    // for the granter to chase.
    const after = await request(app)
      .post(`/api/grants/${root.grantId}/revoke`)
      .set('x-test-user', OWNER);
    expect(after.status).toBe(403);
    expect(after.body).toEqual({ error: 'access_denied' });

    const row = await RoomGrant.findOne({ grantId: root.grantId }).lean();
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.revokedBy).toBe(OWNER);
  });

  it('does not touch grants when the caller may not delete the connection', async () => {
    const connection = await seedConnection();
    const root = grantFixture({ connectionId: String(connection._id) });
    await RoomGrant.create(root);
    User.findById.mockResolvedValue({ _id: OTHER_OWNER, role: 'user' });

    const res = await request(app)
      .delete(`/api/integrations/${connection._id}`)
      .set('x-test-user', OTHER_OWNER);

    expect(res.status).toBe(403);
    expect(await Integration.findById(connection._id)).not.toBeNull();
    const row = await RoomGrant.findOne({ grantId: root.grantId }).lean();
    expect(row.revokedAt).toBeNull();
  });

  it('refuses a caller with no identity instead of deleting past the grants step (Vera 74462)', async () => {
    const connection = await seedConnection();
    const root = grantFixture({ connectionId: String(connection._id) });
    await RoomGrant.create(root);

    const res = await request(app)
      .delete(`/api/integrations/${connection._id}`)
      .set('x-test-user', 'none');

    // The failure direction is the whole point: refusing is correct, and the
    // forbidden outcome is the delete happening anyway with the grants unrevoked.
    expect(res.status).toBe(401);
    expect(await Integration.findById(connection._id)).not.toBeNull();
    const row = await RoomGrant.findOne({ grantId: root.grantId }).lean();
    expect(row.revokedAt).toBeNull();
  });
});
