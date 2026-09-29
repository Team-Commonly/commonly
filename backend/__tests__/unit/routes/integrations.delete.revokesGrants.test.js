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

// The catalogue is empty on this head, so a hosted removal reaches the sequence
// but never a real entry. `findHostedMcpEntry` is the one seam the sequence
// reads, and a page entry has to be reachable through the ROUTE for the
// response's `revokeAt` to have a witness at all — nothing else asserts that
// the route passes it on. Setting the override is the only arm that does.
let mockHostedEntryOverride = null;
jest.mock('../../../integrations/hostedMcp/entries', () => {
  const actual = jest.requireActual('../../../integrations/hostedMcp/entries');
  return {
    ...actual,
    findHostedMcpEntry: (entries, id) => mockHostedEntryOverride
      || actual.findHostedMcpEntry(entries, id),
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

// TASK-172 §10 step 6 — the same route, over a hosted-MCP row. A hosted row is
// the only type whose removal has a provider step, so it takes the whole §9
// sequence rather than the grants-then-delete path the arms above pin.
describe('DELETE /api/integrations/:id over a hosted-MCP row', () => {
  // §2: a hosted row is a per-person Connection, so `scope: 'user'` and no
  // `podId` — the schema requires `podId` only when `scope === 'pod'`, which is
  // also what keeps pod deletion from ever reaching one of these rows.
  const seedHostedRow = async () => Integration.create({
    type: 'hosted-mcp',
    status: 'connected',
    scope: 'user',
    createdBy: OWNER,
    isActive: true,
    config: {
      entryId: 'linear',
      credentialRef: 'access-ref',
      refreshTokenRef: 'refresh-ref',
    },
  });

  it('refuses with provider_revoke_failed and keeps the row, its refs and its grants state', async () => {
    const connection = await seedHostedRow();
    const root = grantFixture({
      connectionId: String(connection._id),
      installationId: 'install-none-hosted',
    });
    await RoomGrant.create(root);

    const res = await request(app)
      .delete(`/api/integrations/${connection._id}`)
      .set('x-test-user', OWNER);

    // `HOSTED_MCP_ENTRIES` is empty on this head, so every hosted removal takes
    // the "no known entry" branch. That is the shipped state, and it is worth an
    // arm of its own: it proves the route dispatches to the sequence rather than
    // falling through to the delete, and that a removal which cannot finish
    // answers a named state instead of a 500 or a silent success.
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('provider_revoke_failed');
    expect(res.body.message).toMatch(/names no known entry/);

    const row = await Integration.findById(connection._id).lean();
    expect(row).not.toBeNull();
    // Step 2 ran before the entry lookup, so the row the broker would still
    // honour is refused from the instant of the failed attempt.
    expect(row.status).toBe('disconnected');
    expect(row.revokedAt).toBeInstanceOf(Date);
    // The material is untouched, which is what makes the retry possible: the
    // refresh token the vendor revoke needs is still there.
    expect(row.config.credentialRef).toBe('access-ref');
    expect(row.config.refreshTokenRef).toBe('refresh-ref');
    // And the row is not active-flagged off, or the orphan sweep would take the
    // material out from under the retry.
    expect(row.isActive).toBe(true);

    const grant = await RoomGrant.findOne({ grantId: root.grantId }).lean();
    expect(grant.revokedAt).toBeInstanceOf(Date);
  });

  it('carries a page entry back as revokeAt and completes the removal', async () => {
    const page = 'https://linear.app/settings/security';
    mockHostedEntryOverride = {
      id: 'linear',
      title: 'Linear',
      resource: 'https://mcp.linear.app/mcp',
      issuer: 'https://mcp.linear.app',
      client: 'cimd',
      scopes: ['read'],
      revoke: { page },
      tools: [],
    };
    try {
      // Real secret-id-shaped refs: the page path completes the removal, so
      // unlike the refusal arm above it reaches `material` — and a real
      // `ConnectorSecret.deleteOne` on a non-ObjectId ref is a CastError, not a
      // no-op. The refs are what the sequence must destroy, so they have to be
      // the shape the sequence is handed in production.
      const connection = await Integration.create({
        type: 'hosted-mcp',
        status: 'connected',
        scope: 'user',
        createdBy: OWNER,
        isActive: true,
        config: {
          entryId: 'linear',
          credentialRef: new mongoose.Types.ObjectId().toString(),
          refreshTokenRef: new mongoose.Types.ObjectId().toString(),
        },
      });
      const root = grantFixture({
        connectionId: String(connection._id),
        installationId: 'install-page-hosted',
      });
      await RoomGrant.create(root);

      const res = await request(app)
        .delete(`/api/integrations/${connection._id}`)
        .set('x-test-user', OWNER);

      // §10.5: a page entry calls no vendor, so the removal completes — and the
      // response has to name the page a person finishes at, or the last step of
      // the removal is a URL only the entry knows.
      expect(res.status).toBe(200);
      expect(res.body.revokeAt).toBe(page);
      expect(await Integration.findById(connection._id).lean()).toBeNull();
      const grant = await RoomGrant.findOne({ grantId: root.grantId }).lean();
      expect(grant.revokedAt).toBeInstanceOf(Date);
    } finally {
      // A leaked override would silently rewrite every arm that follows.
      mockHostedEntryOverride = null;
    }
  });
});
