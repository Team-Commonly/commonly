// F360: a pod's creator adds a teammate already on the instance, by username.
// Real mongod and the real pods router: every claim here is about who may write
// pod membership, and which accounts the route will and won't reveal.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../models/pg/Message', () => ({
  findByPodId: jest.fn().mockResolvedValue([]),
  getLatestByPodIds: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../config/socket', () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));
const mockMirrorMemberAdded = jest.fn().mockResolvedValue(true);
jest.mock('../../services/pgMirrorWrite', () => ({
  ...jest.requireActual('../../services/pgMirrorWrite'),
  mirrorMemberAdded: (...args) => mockMirrorMemberAdded(...args),
}));

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');

const SECRET = 'pod-member-add-test';
const bearer = (user) => `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`;

let app;
let previousSecret;
let creator;
let teammate;
let stranger;
let member;
let agent;
let pod;

const mk = (username, extra = {}) => User.create({
  username, email: `${username}@x.test`, password: 'x'.repeat(12), ...extra,
});
const add = (as, username, podId = pod._id) => request(app)
  .post(`/api/pods/${podId}/members`)
  .set('Authorization', bearer(as))
  .send({ username });
const memberIds = async (podId = pod._id) => (await Pod.findById(podId).lean()).members.map(String);

beforeAll(async () => {
  previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  await setupMongoDb();
  app = express();
  app.use(express.json());
  app.use('/api/pods', require('../../routes/pods'));
});

afterAll(async () => {
  process.env.JWT_SECRET = previousSecret;
  await closeMongoDb();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await Promise.all([User.deleteMany({}), Pod.deleteMany({})]);
  creator = await mk('creator');
  teammate = await mk('teammate');
  stranger = await mk('stranger');
  member = await mk('member');
  agent = await mk('helper-bot', { isBot: true, botMetadata: { agentName: 'helper', instanceId: 'default' } });
  pod = await Pod.create({ name: 'build', type: 'chat', createdBy: creator._id, members: [creator._id, member._id] });
  // The creator and the teammate already work together in another pod.
  await Pod.create({ name: 'ops', type: 'chat', createdBy: teammate._id, members: [teammate._id, creator._id] });
});

it('adds a teammate the creator shares a pod with, by username, and mirrors the add', async () => {
  const res = await add(creator, 'teammate');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true, alreadyMember: false, member: { _id: String(teammate._id), username: 'teammate' } });
  expect(await memberIds()).toContain(String(teammate._id));
  expect(mockMirrorMemberAdded).toHaveBeenCalledWith(String(pod._id), String(teammate._id));
});

it('takes a leading @ and surrounding spaces', async () => {
  const res = await add(creator, '  @teammate ');
  expect(res.status).toBe(200);
  expect(await memberIds()).toContain(String(teammate._id));
});

it('is idempotent: an existing member answers alreadyMember and writes nothing', async () => {
  const res = await add(creator, 'member');
  expect(res.status).toBe(200);
  expect(res.body.alreadyMember).toBe(true);
  expect(mockMirrorMemberAdded).not.toHaveBeenCalled();
  expect((await memberIds()).filter((id) => id === String(member._id))).toHaveLength(1);
});

it('refuses anyone but the pod creator, a member included', async () => {
  const res = await add(member, 'teammate');
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('not_pod_creator');
  expect(await memberIds()).not.toContain(String(teammate._id));
});

it('gives one answer for an unknown username, a banned account and a person the creator shares no pod with', async () => {
  await mk('banned-one', { banned: true });
  await Pod.create({ name: 'old', type: 'chat', createdBy: creator._id, members: [creator._id] });
  const answers = await Promise.all(['nobody-here', 'banned-one', 'stranger'].map((u) => add(creator, u)));
  answers.forEach((res) => {
    expect(res.status).toBe(404);
    expect(res.body).toEqual(answers[0].body);
    expect(res.body.code).toBe('teammate_not_found');
  });
  expect(await memberIds()).toHaveLength(2);
});

it('a shared public community pod does not make someone a teammate', async () => {
  await Pod.create({ name: 'hq', type: 'chat', publicRead: true, createdBy: stranger._id, members: [stranger._id, creator._id] });
  const res = await add(creator, 'stranger');
  expect(res.status).toBe(404);
  expect(res.body.code).toBe('teammate_not_found');
});

it.each(['agent-dm', 'agent-admin'])('a shared %s pod does not make someone a teammate', async (type) => {
  // An agent's Admin: pod holds every installer of that agent and every
  // instance admin, put there by the system, not by anyone's choice.
  await Pod.create({ name: 'personal', type, createdBy: agent._id, members: [agent._id, stranger._id, creator._id] });
  const res = await add(creator, 'stranger');
  expect(res.status).toBe(404);
  expect(res.body.code).toBe('teammate_not_found');
});

// A browser session for an agent account is refused by auth itself; an agent
// reaches user routes only with a cm_ user token, so that is the path tested.
it('refuses an agent caller on its cm_ user token, even on a pod the agent created', async () => {
  const row = await User.findById(agent._id);
  const token = row.generateApiToken();
  await row.save();
  const own = await Pod.create({ name: 'agent-made', type: 'chat', createdBy: agent._id, members: [agent._id, creator._id] });
  // The agent shares an ordinary pod with the teammate, so only the caller rule stops it.
  await Pod.create({ name: 'shared', type: 'chat', createdBy: creator._id, members: [creator._id, agent._id, teammate._id] });
  const res = await request(app).post(`/api/pods/${own._id}/members`).set('Authorization', `Bearer ${token}`).send({ username: 'teammate' });
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('agent_caller_refused');
  expect(await memberIds(own._id)).not.toContain(String(teammate._id));
});

it('refuses a third person in a 1:1 DM pod', async () => {
  const room = await Pod.create({ name: 'helper', type: 'agent-room', createdBy: creator._id, members: [creator._id, agent._id] });
  const res = await add(creator, 'teammate', room._id);
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('dm_membership_refused');
  expect(await memberIds(room._id)).not.toContain(String(teammate._id));
});

it('refuses a missing or non-string username, and an unknown pod', async () => {
  for (const username of [undefined, '', '   ', 42, { $ne: null }, 'x'.repeat(65)]) {
    const res = await add(creator, username);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('username_required');
  }
  const missing = await add(creator, 'teammate', '64b000000000000000000099');
  expect(missing.status).toBe(404);
  expect(missing.body.code).toBe('pod_not_found');
  expect(await memberIds()).toHaveLength(2);
});

it('needs a signed-in caller', async () => {
  const res = await request(app).post(`/api/pods/${pod._id}/members`).send({ username: 'teammate' });
  expect(res.status).toBe(401);
});
