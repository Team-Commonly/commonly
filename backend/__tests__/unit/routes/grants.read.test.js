/**
 * Tools plan §6 — the three read routes the page needs, by their named tests.
 * RoomGrant runs on memory Mongo (the query shape is the thing under test);
 * the pod, the connection owner and the Postgres trail are mocked at their
 * module boundaries, as the pod-agents route suite does.
 */
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

// Human identity from a header so one app can be called as several people.
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const id = req.get('x-test-user');
  if (!id) return res.status(401).json({ error: 'unauthorized' });
  req.user = { id };
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
jest.mock('../../../models/ToolCall', () => ({
  listForGrant: jest.fn(),
  countsForGrant: jest.fn(),
}));
jest.mock('../../../services/dmService', () => ({
  canViewPod: jest.fn(async (userId, pod) => (pod.members || []).map(String).includes(String(userId))),
}));

const Pod = require('../../../models/Pod');
const Integration = require('../../../models/Integration');
const ToolCall = require('../../../models/ToolCall');

const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01'; // installed the App: every grant's granter
const MEMBER = 'bbbbbbbbbbbbbbbbbbbbbb02';
const STRANGER = 'bbbbbbbbbbbbbbbbbbbbbb03';
const SEAT = 'cccccccccccccccccccccc01'; // an agent user in the pod
const OTHER_SEAT = 'cccccccccccccccccccccc02';
const GONE = 'dddddddddddddddddddddd01'; // in the audience snapshot, no longer a member

let mongod;
let RoomGrant;
let app;

const grant = (over = {}) => ({
  grantId: `grant_${Math.random().toString(36).slice(2)}`,
  connectionId: 'conn-1',
  installationId: 'install-1',
  target: { kind: 'pod', id: POD },
  tools: ['github.list_issues', 'github.comment'],
  writeMode: 'write-with-confirm',
  budget: { calls: 10, windowMs: 60000 },
  audience: [SEAT, GONE],
  expiresAt: new Date('2026-10-01T00:00:00.000Z'),
  brokerId: 'broker-1',
  ...over,
});

const trailRow = (over = {}) => ({
  callId: 'call-1', grantId: 'g', podId: POD, installationId: 'install-1', agentUserId: SEAT,
  tool: 'github.list_issues', argsDigest: 'a'.repeat(64), at: new Date('2026-09-11T04:00:00.000Z'),
  outcome: 'ok', reason: undefined, approvalId: undefined, durationMs: 120,
  // What the trail must never carry, even if a row somehow did.
  args: { repo: 'secret/private' },
  ...over,
});

const FIELDS = ['grantId', 'installationId', 'target', 'tools', 'writeMode', 'budget', 'effectiveAudience',
  'expiresAt', 'revokedAt', 'parentGrantId', 'rootGrantId', 'createdAt', 'grantedBy'];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  RoomGrant = require('../../../models/RoomGrant');
  const grants = require('../../../routes/grants');
  app = express();
  app.use(express.json());
  app.use('/api/grants', grants);
  app.use('/api/pods', grants.podGrantsRouter);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await RoomGrant.deleteMany({});
  Pod.findById.mockImplementation((id) => ({
    select: () => ({ lean: async () => (String(id) === POD ? { _id: POD, type: 'team', members: [OWNER, MEMBER, SEAT, OTHER_SEAT] } : null) }),
  }));
  Integration.findById.mockResolvedValue(null);
  Integration.findOne.mockImplementation(async ({ installationId }) => (installationId === 'conn-1'
    ? { _id: 'conn-1', type: 'github-app', status: 'connected', createdBy: OWNER }
    : null));
  ToolCall.listForGrant.mockResolvedValue([]);
  ToolCall.countsForGrant.mockResolvedValue({ total: 0, ok: 0, refused: 0, pending_approval: 0, failed: 0 });
});

describe('GET /api/pods/:podId/grants', () => {
  test('the pod grants list refuses a non-member', async () => {
    await RoomGrant.create(grant());
    const stranger = await request(app).get(`/api/pods/${POD}/grants`).set('x-test-user', STRANGER);
    expect(stranger.status).toBe(403);
    expect(stranger.body.grants).toBeUndefined();
    const malformed = await request(app).get('/api/pods/not-an-id/grants').set('x-test-user', MEMBER);
    expect(malformed.status).toBe(403);
    const anon = await request(app).get(`/api/pods/${POD}/grants`);
    expect(anon.status).toBe(401);
  });

  test('a member sees the pod grants and the seat grants of seats in the pod, each in the field list', async () => {
    const podGrant = await RoomGrant.create(grant());
    const seatGrant = await RoomGrant.create(grant({ target: { kind: 'seat', id: SEAT }, audience: [SEAT] }));
    await RoomGrant.create(grant({ target: { kind: 'seat', id: 'eeeeeeeeeeeeeeeeeeeeee01' }, audience: ['eeeeeeeeeeeeeeeeeeeeee01'] })); // a seat elsewhere
    await RoomGrant.create(grant({ target: { kind: 'pod', id: 'aaaaaaaaaaaaaaaaaaaaaa02' } })); // another pod
    const res = await request(app).get(`/api/pods/${POD}/grants`).set('x-test-user', MEMBER);
    expect(res.status).toBe(200);
    expect(res.body.podId).toBe(POD);
    expect(res.body.grants.map((row) => row.grantId).sort()).toEqual([podGrant.grantId, seatGrant.grantId].sort());
    for (const row of res.body.grants) {
      expect(Object.keys(row).sort()).toEqual([...FIELDS].sort());
      expect(row.grantedBy).toBe(OWNER);
      expect(JSON.stringify(row)).not.toMatch(/conn-1|broker-1/);
    }
    const podRow = res.body.grants.find((row) => row.grantId === podGrant.grantId);
    // The raw snapshot names GONE; the page only ever sees the effective audience.
    expect(podRow.effectiveAudience).toEqual([SEAT]);
    expect(podRow.audience).toBeUndefined();
    const seatRow = res.body.grants.find((row) => row.grantId === seatGrant.grantId);
    expect(seatRow.effectiveAudience).toEqual([SEAT]);
  });
});

describe('GET /api/grants/:grantId/calls', () => {
  test('the trail refuses a non-member and never returns args', async () => {
    const row = await RoomGrant.create(grant());
    ToolCall.listForGrant.mockResolvedValue([trailRow({ grantId: row.grantId }), trailRow({ grantId: row.grantId, callId: 'call-2', outcome: 'refused', reason: 'not_in_audience' })]);
    ToolCall.countsForGrant.mockResolvedValue({ total: 3, ok: 1, refused: 1, pending_approval: 1, failed: 0 });

    const stranger = await request(app).get(`/api/grants/${row.grantId}/calls`).set('x-test-user', STRANGER);
    expect(stranger.status).toBe(403);
    expect(stranger.body.calls).toBeUndefined();

    const member = await request(app).get(`/api/grants/${row.grantId}/calls`).set('x-test-user', MEMBER);
    expect(member.status).toBe(200);
    expect(member.body.counts).toEqual({ total: 3, ok: 1, refused: 1, pending_approval: 1, failed: 0 });
    expect(member.body.calls).toHaveLength(2);
    for (const line of member.body.calls) {
      expect(line.argsDigest).toHaveLength(64);
      expect(line).not.toHaveProperty('args');
    }
    expect(JSON.stringify(member.body)).not.toContain('secret/private');
    expect(member.body.calls[1]).toMatchObject({ callId: 'call-2', outcome: 'refused', reason: 'not_in_audience', agentUserId: SEAT, tool: 'github.list_issues' });
    expect(ToolCall.listForGrant).toHaveBeenCalledWith(row.grantId, 100);

    // The seat the pod grant covers reads it too, on its runtime token.
    const seat = await request(app).get(`/api/grants/${row.grantId}/calls`).set('Authorization', 'Bearer cm_agent_x').set('x-test-agent', SEAT);
    expect(seat.status).toBe(200);
    const foreignAgent = await request(app).get(`/api/grants/${row.grantId}/calls`).set('Authorization', 'Bearer cm_agent_x').set('x-test-agent', 'eeeeeeeeeeeeeeeeeeeeee01');
    expect(foreignAgent.status).toBe(403);
  });

  test("a seat grant's trail is visible only to its granter and the seat", async () => {
    const row = await RoomGrant.create(grant({ target: { kind: 'seat', id: SEAT }, audience: [SEAT] }));
    const read = (headers) => request(app).get(`/api/grants/${row.grantId}/calls`).set(headers);
    expect((await read({ 'x-test-user': OWNER })).status).toBe(200);
    expect((await read({ Authorization: 'Bearer cm_agent_x', 'x-test-agent': SEAT })).status).toBe(200);
    // A pod member who is not the granter, and another seat in the same pod, both refused.
    expect((await read({ 'x-test-user': MEMBER })).status).toBe(403);
    expect((await read({ Authorization: 'Bearer cm_agent_x', 'x-test-agent': OTHER_SEAT })).status).toBe(403);
    expect((await read({ 'x-test-user': STRANGER })).status).toBe(403);
    // Membership never substitutes for the granter check on a seat grant.
    const dm = require('../../../services/dmService');
    expect(dm.canViewPod).not.toHaveBeenCalled();
  });

  test('an unknown grant is 404 and the limit is clamped', async () => {
    expect((await request(app).get('/api/grants/grant_nope/calls').set('x-test-user', MEMBER)).status).toBe(404);
    const row = await RoomGrant.create(grant());
    await request(app).get(`/api/grants/${row.grantId}/calls?limit=9999`).set('x-test-user', MEMBER);
    expect(ToolCall.listForGrant).toHaveBeenLastCalledWith(row.grantId, 500);
  });
});

describe('GET /api/grants/:grantId', () => {
  test('GET /api/grants/:id returns the field list and never connectionId or brokerId', async () => {
    const row = await RoomGrant.create(grant({ parentGrantId: null, rootGrantId: 'grant_root' }));
    const res = await request(app).get(`/api/grants/${row.grantId}`).set('x-test-user', MEMBER);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([...FIELDS].sort());
    expect(res.body).toMatchObject({
      grantId: row.grantId, installationId: 'install-1', target: { kind: 'pod', id: POD },
      tools: ['github.list_issues', 'github.comment'], writeMode: 'write-with-confirm',
      budget: { calls: 10, windowMs: 60000 }, effectiveAudience: [SEAT], revokedAt: null,
      parentGrantId: null, rootGrantId: 'grant_root', grantedBy: OWNER,
    });
    expect(res.body.connectionId).toBeUndefined();
    expect(res.body.brokerId).toBeUndefined();
    expect(res.body.audience).toBeUndefined();
    expect(res.body._id).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/conn-1|broker-1|dddddddddddddddddddddd01/);
    // Still member-scoped, as before the tightening.
    expect((await request(app).get(`/api/grants/${row.grantId}`).set('x-test-user', STRANGER)).status).toBe(403);
  });

  test("a seat grant's read is gated like its trail: granter and seat only (Vera 67727)", async () => {
    const row = await RoomGrant.create(grant({ target: { kind: 'seat', id: SEAT }, audience: [SEAT] }));
    const read = (headers) => request(app).get(`/api/grants/${row.grantId}`).set(headers);
    const owner = await read({ 'x-test-user': OWNER });
    expect(owner.status).toBe(200);
    expect(owner.body.grantedBy).toBe(OWNER);
    expect(owner.body.effectiveAudience).toEqual([SEAT]);
    expect((await read({ Authorization: 'Bearer cm_agent_x', 'x-test-agent': SEAT })).status).toBe(200);
    // A stranger in no pod, a pod member who is not the granter, another seat: 403, tools and granter unseen.
    for (const headers of [{ 'x-test-user': STRANGER }, { 'x-test-user': MEMBER }, { Authorization: 'Bearer cm_agent_x', 'x-test-agent': OTHER_SEAT }]) {
      const res = await read(headers);
      expect(res.status).toBe(403);
      expect(res.body.tools).toBeUndefined();
      expect(res.body.grantedBy).toBeUndefined();
    }
  });
});
