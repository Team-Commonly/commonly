/**
 * Grant owner binding at the routes. The mint records the connection row and
 * its owner. Revoke and the seat-grant read take the owner from that binding
 * and refuse an unbound grant. Fixtures follow grants.mint and grants.read.
 */
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const id = req.get('x-test-user');
  if (!id) return res.status(401).json({ error: 'unauthorized' });
  req.user = { id, role: req.get('x-test-role') || 'user' };
  req.userId = id;
  return next();
});
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  const id = req.get('x-test-agent');
  if (!id) return res.status(401).json({ error: 'agent_token_invalid' });
  req.agentUser = { _id: id };
  return next();
});
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/Installable', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/githubAppService', () => ({}));
jest.mock('../../../models/ToolCall', () => ({
  __esModule: true,
  default: {},
  digestArgs: jest.fn(),
  reserveBudgetLineage: jest.fn(),
  listForGrant: jest.fn(),
  countsForGrant: jest.fn(),
}));
jest.mock('../../../services/outsiderGrantPodEligibility', () => ({
  outsiderGrantPodRefusal: jest.fn(async () => null),
  outsiderGrantRefusalMessage: jest.fn(() => ''),
}));

const Pod = require('../../../models/Pod');
const Integration = require('../../../models/Integration');
const Installable = require('../../../models/Installable');
const { buildGithubToolInstallable } = require('../../../services/installable/toolInstallables');

const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const STRANGER = 'bbbbbbbbbbbbbbbbbbbbbb03';
const SEAT = 'cccccccccccccccccccccc01';
const CONN_ROW = 'aaaaaaaaaaaaaaaaaaaaaa77';

let mongod;
let RoomGrant;
let app;

const mint = (body) => request(app).post('/api/grants').set('x-test-user', OWNER).send({
  connectionId: 'conn-1',
  target: { kind: 'pod', id: POD },
  tools: ['github.list_issues'],
  writeMode: 'read',
  budget: { calls: 10, windowMs: 60000 },
  expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  ...body,
});

const seatGrant = (over = {}) => RoomGrant.create({
  grantId: `grant_${Math.random().toString(36).slice(2)}`,
  connectionId: 'install-1',
  installationId: 'install-1',
  target: { kind: 'seat', id: SEAT },
  tools: ['github.list_issues'],
  writeMode: 'read',
  audience: [SEAT],
  expiresAt: new Date(Date.now() + 86400000),
  brokerId: 'broker-1',
  ...over,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  RoomGrant = require('../../../models/RoomGrant');
  app = express();
  app.use(express.json());
  app.use('/api/grants', require('../../../routes/grants'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await RoomGrant.deleteMany({});
  Pod.findById.mockImplementation((id) => ({
    select: () => ({ lean: async () => (String(id) === POD ? { _id: POD, type: 'team', members: [OWNER, SEAT] } : null) }),
  }));
  Integration.findById.mockResolvedValue(null);
  Integration.findOne.mockImplementation(async ({ installationId }) => (installationId === 'conn-1'
    ? {
      _id: CONN_ROW, type: 'github-app', status: 'connected', createdBy: OWNER,
      installationId: 'install-1', config: { installationId: 'install-1', owner: 'octo', repo: 'demo' },
    }
    : null));
  Installable.findOne.mockReturnValue({ lean: async () => buildGithubToolInstallable() });
});

describe('mint binds the grant to the connection row and its owner', () => {
  test('the stored grant carries the row _id and the owner, never the body', async () => {
    const res = await mint({ ownerId: STRANGER, connectionRowId: 'forged' });
    expect(res.status).toBe(201);
    const stored = await RoomGrant.findOne({ grantId: res.body.grantId }).lean();
    expect(stored.connectionRowId).toBe(CONN_ROW);
    expect(stored.ownerId).toBe(OWNER);
  });
});

describe('revoke refuses an unbound grant', () => {
  test('an unbound grant cannot be revoked, even by the caller who once owned it', async () => {
    const grant = await seatGrant({ ownerId: null, connectionRowId: null });
    const res = await request(app).post(`/api/grants/${grant.grantId}/revoke`).set('x-test-user', OWNER);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'grant_unbound' });
    expect((await RoomGrant.findOne({ grantId: grant.grantId }).lean()).revokedAt).toBeNull();
  });

  test('an admin can revoke an unbound grant, and a non-admin still gets grant_unbound', async () => {
    const grant = await seatGrant({ ownerId: null, connectionRowId: null });
    const member = await request(app).post(`/api/grants/${grant.grantId}/revoke`).set('x-test-user', STRANGER);
    expect(member.status).toBe(403);
    expect(member.body).toMatchObject({ error: 'grant_unbound' });

    const admin = await request(app).post(`/api/grants/${grant.grantId}/revoke`)
      .set('x-test-user', STRANGER).set('x-test-role', 'admin');
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ revoked: 1 });
    const stored = await RoomGrant.findOne({ grantId: grant.grantId }).lean();
    expect(stored.revokedAt).toBeInstanceOf(Date);
    expect(stored.revokedBy).toBe(STRANGER);
  });

  test('a bound grant is revoked by its owner and refused to anyone else', async () => {
    const grant = await seatGrant({ ownerId: OWNER, connectionRowId: CONN_ROW });
    const stranger = await request(app).delete(`/api/grants/${grant.grantId}`).set('x-test-user', STRANGER);
    expect(stranger.status).toBe(403);
    expect(stranger.body).toMatchObject({ error: 'access_denied' });

    const owner = await request(app).delete(`/api/grants/${grant.grantId}`).set('x-test-user', OWNER);
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ revoked: 1 });
  });
});

describe('the seat-grant read refuses an unbound grant', () => {
  test('neither the owner nor the seat reads an unbound seat grant', async () => {
    const grant = await seatGrant({ ownerId: null, connectionRowId: null });
    const human = await request(app).get(`/api/grants/${grant.grantId}`).set('x-test-user', OWNER);
    expect(human.status).toBe(403);
    expect(human.body).toMatchObject({ error: 'grant_unbound' });

    const seat = await request(app).get(`/api/grants/${grant.grantId}`)
      .set({ Authorization: 'Bearer cm_agent_x', 'x-test-agent': SEAT });
    expect(seat.status).toBe(403);
    expect(seat.body).toMatchObject({ error: 'grant_unbound' });
  });

  test('a bound seat grant is read by its granter (positive control)', async () => {
    const grant = await seatGrant({ ownerId: OWNER, connectionRowId: CONN_ROW });
    const res = await request(app).get(`/api/grants/${grant.grantId}`).set('x-test-user', OWNER);
    expect(res.status).toBe(200);
    expect(res.body.grantedBy).toBe(OWNER);
  });

  // The changed-hands grant as the read sees it after backfill: the connection
  // id now names a row whose owner is someone else. The read must not hand the
  // grant to that holder, and must not treat the grant as the holder's either.
  test('after the id changed hands, the new holder cannot read the old grant', async () => {
    const grant = await seatGrant({ ownerId: null, connectionRowId: null });
    Integration.findOne.mockImplementation(async () => ({
      _id: 'aaaaaaaaaaaaaaaaaaaaaa78', type: 'github-app', status: 'connected', createdBy: STRANGER,
      installationId: 'install-1',
    }));
    const res = await request(app).get(`/api/grants/${grant.grantId}`).set('x-test-user', STRANGER);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'grant_unbound' });
  });
});
