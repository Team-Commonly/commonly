// F619: every member add is one atomic write that bumps the pod's version.
// F605 fixed ensureAgentInPod; this covers the rest of the writers:
//   - POST /api/agents/runtime/pods, the dedup-by-name join;
//   - POST /api/registry/admin/agents/claude-code/session-token, the attach;
//   - redeemPodInvite and podController.joinPod, already atomic, now bumping __v.
// A concurrent join landing between a route's read and its write must leave the
// member in `members` once, a pod that became a 1:1 DM meanwhile must be refused
// at the write, and a doc loaded before the add that rewrites `members` whole
// (removeAgentFromPod, leavePod) must get a VersionError rather than undo it.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { PodInvite } = require('../../models/PodInvite');
const { AgentRegistry } = require('../../models/AgentRegistry');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

// The join policy check runs between each route's pod read and its member
// write, so a one-shot hook here lands a concurrent writer in that window.
let mockInWindow = null;
const mockRunWindow = async () => {
  const hook = mockInWindow;
  mockInWindow = null;
  if (hook) await hook();
};
jest.mock('../../services/outsiderGrantAgentJoinPolicy', () => {
  const actual = jest.requireActual('../../services/outsiderGrantAgentJoinPolicy');
  return {
    ...actual,
    assertAgentRuntimeMayJoinPod: jest.fn(async () => mockRunWindow()),
    assertInstalledAgentMayJoinPod: jest.fn(async () => mockRunWindow()),
  };
});
jest.mock('../../services/pgMirrorWrite', () => ({
  mirrorMemberAdded: jest.fn().mockResolvedValue(true),
  mirrorUser: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../services/agentEventService', () => ({
  enqueue: jest.fn(async () => ({ _id: 'stub-event' })),
}));

const { mirrorMemberAdded } = require('../../services/pgMirrorWrite');
const AgentIdentityService = require('../../services/agentIdentityService');
const { redeemPodInvite } = require('../../services/podInviteRedemption');
const podController = require('../../controllers/podController');
const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');

const JWT_SECRET = 'test-jwt-secret-f619-member-add';

jest.setTimeout(60000);

let n = 0;
const makeUser = (fields = {}) => {
  n += 1;
  return User.create({
    username: `f619-user-${n}`, email: `f619-${n}@example.test`, password: 'Password123!', ...fields,
  });
};
const membersOf = async (podId) => (await Pod.findById(podId).lean()).members.map(String);
// The invite-redeem / joinPod member write as another request would land it.
const concurrentJoin = (podId, userId) => Pod.updateOne(
  { _id: podId }, { $addToSet: { members: userId }, $set: { updatedAt: new Date() } },
);
const mirroredFor = (userId) => mirrorMemberAdded.mock.calls.filter(([, u]) => u === String(userId));
// A doc loaded before the add, rewriting `members` whole as removeAgentFromPod does.
const staleRemoveSave = async (stale, removeId) => {
  // eslint-disable-next-line no-param-reassign
  stale.members = stale.members.filter((m) => String(m) !== String(removeId));
  return stale.save();
};

const registryRow = (agentName) => ({
  agentName,
  displayName: agentName,
  description: `Test agent ${agentName}`,
  registry: 'commonly-official',
  verified: true,
  manifest: {
    name: agentName,
    version: '1.0.0',
    capabilities: [{ name: 'memory', description: 'memory' }],
    context: { required: ['context:read'] },
    runtime: { type: 'standalone', connection: 'rest' },
  },
  latestVersion: '1.0.0',
  versions: [{ version: '1.0.0', publishedAt: new Date() }],
});

let app;
let admin;
let adminToken;
let bot;
let botToken;

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  await setupMongoDb();
  app = express();
  app.use(express.json());
  app.use('/api/registry', registryRoutes);
  app.use('/api/agents/runtime', agentsRuntimeRoutes);

  admin = await makeUser({ role: 'admin' });
  adminToken = jwt.sign({ id: admin._id.toString() }, JWT_SECRET);
  const home = await Pod.create({ name: 'f619-home', type: 'chat', createdBy: admin._id, members: [admin._id] });
  await AgentRegistry.create(registryRow('f619-bot'));
  await request(app).post('/api/registry/install').set('Authorization', `Bearer ${adminToken}`)
    .send({ agentName: 'f619-bot', podId: home._id.toString(), scopes: ['context:read'] });
  const res = await request(app).post(`/api/registry/pods/${home._id}/agents/f619-bot/runtime-tokens`)
    .set('Authorization', `Bearer ${adminToken}`).send({ label: 'f619 token' });
  expect(res.status).toBe(200);
  botToken = res.body.token;
  bot = await User.findOne({ isBot: true, 'botMetadata.agentName': 'f619-bot' });
});

beforeEach(() => {
  mockInWindow = null;
  mirrorMemberAdded.mockClear();
});

afterAll(closeMongoDb);

describe('POST /api/agents/runtime/pods dedup join (F619)', () => {
  let owner;
  beforeEach(async () => { owner = await makeUser(); });

  const joinablePod = (name, fields = {}) => Pod.create({
    name,
    type: 'chat',
    createdBy: owner._id,
    members: [owner._id],
    publicRead: true,
    communityListed: true,
    joinPolicy: 'open',
    ...fields,
  });
  const createByName = (name) => request(app)
    .post('/api/agents/runtime/pods')
    .set('Authorization', `Bearer ${botToken}`)
    .send({ name, type: 'chat' });

  it('a concurrent join of the same agent leaves it in members once and answers 200', async () => {
    const pod = await joinablePod('f619-dedup-race');
    mockInWindow = () => concurrentJoin(pod._id, bot._id);

    const res = await createByName('f619-dedup-race');

    expect(res.status).toBe(200);
    expect(String(res.body._id)).toBe(String(pod._id));
    const members = await membersOf(pod._id);
    expect(members.filter((m) => m === String(bot._id))).toHaveLength(1);
    // The join that won mirrored its own add.
    expect(mirroredFor(bot._id)).toHaveLength(0);
  });

  it('a pod that becomes a 1:1 DM between the read and the write is refused at the write', async () => {
    const pod = await joinablePod('f619-dedup-flip');
    const human = await makeUser();
    mockInWindow = () => Pod.updateOne(
      { _id: pod._id }, { $set: { type: 'agent-dm' }, $addToSet: { members: human._id } },
    );

    const res = await createByName('f619-dedup-flip');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('pod_name_unavailable');
    expect((await membersOf(pod._id)).sort()).toEqual([String(owner._id), String(human._id)].sort());
    expect(mirroredFor(bot._id)).toHaveLength(0);
  });

  it('a pod deleted between the read and the write answers 404 and adds nothing', async () => {
    const pod = await joinablePod('f619-dedup-gone');
    mockInWindow = () => Pod.deleteOne({ _id: pod._id });

    const res = await createByName('f619-dedup-gone');

    expect(res.status).toBe(404);
    expect(await Pod.countDocuments({ name: 'f619-dedup-gone' })).toBe(0);
    expect(mirroredFor(bot._id)).toHaveLength(0);
  });

  it('a plain join adds once, mirrors once, and a stale whole-array save after it gets VersionError', async () => {
    const other = await makeUser();
    const pod = await joinablePod('f619-dedup-stale');
    await concurrentJoin(pod._id, other._id);
    const stale = await Pod.findById(pod._id);

    const res = await createByName('f619-dedup-stale');
    expect(res.status).toBe(200);
    expect(res.body.members.map((m) => String(m._id || m))).toContain(String(bot._id));
    expect(mirroredFor(bot._id)).toHaveLength(1);

    await expect(staleRemoveSave(stale, other._id)).rejects.toHaveProperty('name', 'VersionError');
    expect((await membersOf(pod._id)).sort())
      .toEqual([String(owner._id), String(other._id), String(bot._id)].sort());
  });
});

describe('POST /api/registry/admin/agents/claude-code/session-token attach (F619)', () => {
  let owner;
  let sessionBot;
  let instanceId;
  beforeEach(async () => {
    owner = await makeUser();
    instanceId = `f619-sess-${n}`;
    // Exists before the call, so a concurrent join in the window can add it.
    sessionBot = await AgentIdentityService.getOrCreateAgentUser('claude-code', {
      instanceId, displayName: `${instanceId} (Claude Code)`,
    });
  });

  const attach = (podId) => request(app)
    .post('/api/registry/admin/agents/claude-code/session-token')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ podId: String(podId), instanceId, displayName: `${instanceId} (Claude Code)` });

  it('a concurrent join of the same session agent leaves it in members once and answers 200', async () => {
    const pod = await Pod.create({ name: 'f619-attach-race', type: 'chat', createdBy: owner._id, members: [owner._id] });
    mockInWindow = () => concurrentJoin(pod._id, sessionBot._id);

    const res = await attach(pod._id);

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^cm_agent_/);
    expect((await membersOf(pod._id)).filter((m) => m === String(sessionBot._id))).toHaveLength(1);
    expect(mirroredFor(sessionBot._id)).toHaveLength(0);
  });

  it('a pod that becomes a 1:1 DM between the read and the write is refused with the DM 403', async () => {
    const pod = await Pod.create({ name: 'f619-attach-flip', type: 'chat', createdBy: owner._id, members: [owner._id] });
    const human = await makeUser();
    mockInWindow = () => Pod.updateOne(
      { _id: pod._id }, { $set: { type: 'agent-room' }, $addToSet: { members: human._id } },
    );

    const res = await attach(pod._id);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/DM pods are 1:1/);
    expect(res.body.token).toBeUndefined();
    expect((await membersOf(pod._id)).sort()).toEqual([String(owner._id), String(human._id)].sort());
    expect(mirroredFor(sessionBot._id)).toHaveLength(0);
  });

  it('a pod deleted between the read and the write answers 404', async () => {
    const pod = await Pod.create({ name: 'f619-attach-gone', type: 'chat', createdBy: owner._id, members: [owner._id] });
    mockInWindow = () => Pod.deleteOne({ _id: pod._id });

    const res = await attach(pod._id);

    expect(res.status).toBe(404);
    expect(res.body.token).toBeUndefined();
    expect(mirroredFor(sessionBot._id)).toHaveLength(0);
  });

  it('agent-admin stays attachable: the site keeps its own DM rule', async () => {
    const pod = await Pod.create({ name: 'f619-attach-admin', type: 'agent-admin', createdBy: owner._id, members: [owner._id] });

    const res = await attach(pod._id);

    expect(res.status).toBe(200);
    expect(await membersOf(pod._id)).toContain(String(sessionBot._id));
    expect(mirroredFor(sessionBot._id)).toHaveLength(1);
  });

  it('a plain attach adds once, mirrors once, and a stale whole-array save after it gets VersionError', async () => {
    const other = await makeUser();
    const pod = await Pod.create({ name: 'f619-attach-stale', type: 'chat', createdBy: owner._id, members: [owner._id] });
    await concurrentJoin(pod._id, other._id);
    const stale = await Pod.findById(pod._id);

    const res = await attach(pod._id);
    expect(res.status).toBe(200);
    expect(mirroredFor(sessionBot._id)).toHaveLength(1);

    await expect(staleRemoveSave(stale, other._id)).rejects.toHaveProperty('name', 'VersionError');
    expect((await membersOf(pod._id)).sort())
      .toEqual([String(owner._id), String(other._id), String(sessionBot._id)].sort());
  });
});

describe('the invite and joinPod adds bump the pod version (F619)', () => {
  it('a stale whole-array save after an invite redemption gets VersionError', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const joiner = await makeUser();
    const pod = await Pod.create({ name: 'f619-invite', type: 'chat', createdBy: owner._id, members: [owner._id] });
    await concurrentJoin(pod._id, other._id);
    n += 1;
    const invite = await PodInvite.create({
      token: n.toString(16).padStart(32, 'f'), podId: pod._id, createdBy: owner._id,
    });
    const stale = await Pod.findById(pod._id);

    expect(await redeemPodInvite(invite.token, joiner._id)).toMatchObject({ ok: true, alreadyMember: false });

    await expect(staleRemoveSave(stale, other._id)).rejects.toHaveProperty('name', 'VersionError');
    expect((await membersOf(pod._id)).sort())
      .toEqual([String(owner._id), String(other._id), String(joiner._id)].sort());
  });

  it('a stale whole-array save after joinPod gets VersionError', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const joiner = await makeUser();
    const pod = await Pod.create({
      name: 'f619-join',
      type: 'chat',
      createdBy: owner._id,
      members: [owner._id],
      publicRead: true,
      communityListed: true,
      joinPolicy: 'open',
    });
    await concurrentJoin(pod._id, other._id);
    const stale = await Pod.findById(pod._id);

    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    await podController.joinPod({ params: { id: String(pod._id) }, userId: joiner._id, user: { id: joiner._id } }, res);
    expect(res.statusCode).toBe(200);

    await expect(staleRemoveSave(stale, other._id)).rejects.toHaveProperty('name', 'VersionError');
    expect((await membersOf(pod._id)).sort())
      .toEqual([String(owner._id), String(other._id), String(joiner._id)].sort());
  });
});
