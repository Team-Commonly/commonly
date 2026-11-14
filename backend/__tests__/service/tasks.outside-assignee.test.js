/**
 * F127 (D244 finding 13): a human member of a pod can hand one board row to an
 * agent outside the pod. The grant covers that row only: claim, notes,
 * complete and a status-only PATCH. It never opens the pod's board, messages
 * or other rows, and clearing it releases the agent's claim at once.
 */

process.env.PG_HOST = '';
process.env.JWT_SECRET = 'tasks-outside-assignee-test-secret';

jest.mock('../../services/taskEventService', () => {
  const actual = jest.requireActual('../../services/taskEventService');
  return { ...actual, notifyPodAgents: jest.fn().mockResolvedValue(undefined) };
});
jest.mock('../../services/systemActionLineService', () => ({
  emitSystemActionLine: jest.fn().mockResolvedValue(undefined),
}));

const express = require('express');
const request = require('supertest');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const User = require('../../models/User');
const { AgentInstallation } = require('../../models/AgentRegistry');
const tasksApiRoutes = require('../../routes/tasksApi');
const { hash } = require('../../utils/secret');
const {
  setupMongoDb, closeMongoDb, clearMongoDb, generateTestToken,
} = require('../utils/testUtils');

const OUTSIDE_TOKEN = 'cm_agent_outside_builder_test';
const STRANGER_TOKEN = 'cm_agent_outside_stranger_test';
const MEMBER_AGENT_TOKEN = 'cm_agent_outside_member_test';
// A bot may also hold a cm_ user token, which rides the human branch of auth.
const OUTSIDE_USER_TOKEN = 'cm_outsidebuilderusertoken000000000001';
const MEMBER_USER_TOKEN = 'cm_memberagentusertoken0000000000000001';

describe('F127: a one-row grant to an agent outside the pod', () => {
  let app;
  let owner; let rival; let admin; let outside; let stranger; let memberAgent;
  let team; let build;
  let ownerToken; let rivalToken; let adminToken;

  const human = (name, extra = {}) => User.create({
    username: `${name}-${Date.now()}`, email: `${name}-${Date.now()}@test.com`, password: 'Password123!', verified: true, ...extra,
  });
  const bot = (agentName, token, displayName = agentName) => User.create({
    username: agentName,
    email: `${agentName}-${Date.now()}@agents.commonly.local`,
    password: 'Password123!',
    verified: true,
    isBot: true,
    botType: 'agent',
    botMetadata: { agentName, instanceId: 'default', displayName },
    agentRuntimeTokens: [{ tokenHash: hash(token), label: agentName, createdAt: new Date() }],
  });

  beforeAll(async () => {
    await setupMongoDb();
    await Task.init();
    app = express();
    app.use(express.json());
    app.use('/api/v1/tasks', tasksApiRoutes);
  });

  beforeEach(async () => {
    await clearMongoDb();
    owner = await human('owner');
    rival = await human('rival');
    admin = await human('admin', { role: 'admin' });
    outside = await bot('outside-builder', OUTSIDE_TOKEN, 'Builder');
    stranger = await bot('outside-stranger', STRANGER_TOKEN, 'Builder');
    memberAgent = await bot('member-agent', MEMBER_AGENT_TOKEN);
    team = await Pod.create({
      name: 'Team board', type: 'team', createdBy: owner._id, members: [owner._id, rival._id, memberAgent._id],
    });
    // The outside agent lives in its own pod, which its installer (owner) is not in.
    build = await Pod.create({
      name: 'Build', type: 'team', createdBy: owner._id, members: [outside._id], 
    });
    await AgentInstallation.create({
      agentName: 'outside-builder', instanceId: 'default', podId: build._id, version: '1.0.0', installedBy: owner._id,
    });
    const strangerPod = await Pod.create({
      name: 'Elsewhere', type: 'team', createdBy: admin._id, members: [stranger._id], 
    });
    await AgentInstallation.create({
      agentName: 'outside-stranger', instanceId: 'default', podId: strangerPod._id, version: '1.0.0', installedBy: admin._id,
    });
    await AgentInstallation.create({
      agentName: 'member-agent', instanceId: 'default', podId: team._id, version: '1.0.0', installedBy: owner._id,
    });
    await User.updateOne({ _id: outside._id }, { $set: { apiTokenHash: hash(OUTSIDE_USER_TOKEN) } });
    await User.updateOne({ _id: memberAgent._id }, { $set: { apiTokenHash: hash(MEMBER_USER_TOKEN) } });
    ownerToken = generateTestToken(owner._id);
    rivalToken = generateTestToken(rival._id);
    adminToken = generateTestToken(admin._id);
    await Task.create({
      podId: team._id, taskNum: 1, taskId: 'TASK-001', title: 'the row', status: 'pending', 
    });
    await Task.create({
      podId: team._id, taskNum: 2, taskId: 'TASK-002', title: 'another row', status: 'pending', 
    });
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  const base = (taskId = 'TASK-001') => `/api/v1/tasks/${team._id}/${taskId}`;
  const grant = (token, body) => request(app)
    .put(`${base()}/outside-assignee`).set('Authorization', `Bearer ${token}`)
    .send(body || { agentName: 'outside-builder', instanceId: 'default' });
  const revoke = (token) => request(app).delete(`${base()}/outside-assignee`).set('Authorization', `Bearer ${token}`);
  const claim = (token, taskId) => request(app).post(`${base(taskId)}/claim`).set('Authorization', `Bearer ${token}`).send({});
  const note = (token, body = { text: 'progress' }) => request(app).post(`${base()}/updates`).set('Authorization', `Bearer ${token}`).send(body);
  const patch = (token, body) => request(app).patch(base()).set('Authorization', `Bearer ${token}`).send(body);
  const complete = (token) => request(app).post(`${base()}/complete`).set('Authorization', `Bearer ${token}`).send({});

  test('the installer grants the row; the agent claims, notes and completes it from outside', async () => {
    const granted = await grant(ownerToken);
    expect(granted.status).toBe(200);
    expect(granted.body.task.outsideAssignee).toEqual(expect.objectContaining({
      userId: String(outside._id), agentName: 'outside-builder', instanceId: 'default', grantedBy: String(owner._id),
    }));

    const claimed = await claim(OUTSIDE_TOKEN);
    expect(claimed.status).toBe(200);
    expect(claimed.body.task.claimedByUserId).toBe(String(outside._id));
    expect(claimed.body.task.updates.at(-1).text).toBe(`Claimed by outside-builder (assigned by ${owner.username}, from outside this pod)`);

    // No freshness hold: that answer carries previews of pod messages.
    expect((await note(OUTSIDE_TOKEN)).status).toBe(200);
    const done = await complete(OUTSIDE_TOKEN);
    expect(done.status).toBe(200);
    expect(done.body.task.status).toBe('done');
  });

  test('a member who shares a pod with the agent may grant it; one who neither installed nor shares a pod may not', async () => {
    expect((await grant(rivalToken)).status).toBe(403);
    await Pod.create({
      name: 'Shared', type: 'team', createdBy: rival._id, members: [rival._id, outside._id], 
    });
    expect((await grant(rivalToken)).status).toBe(200);
  });

  test('an agent that was not granted the row is refused, even one with the same display name', async () => {
    await grant(ownerToken);
    expect((await claim(STRANGER_TOKEN)).status).toBe(403);
    expect((await note(STRANGER_TOKEN)).status).toBe(403);
    expect((await complete(STRANGER_TOKEN)).status).toBe(403);
  });

  test('the grant reaches one row only', async () => {
    await grant(ownerToken);
    expect((await claim(OUTSIDE_TOKEN, 'TASK-002')).status).toBe(403);
  });

  test('an agent cannot grant, not even a member agent of the pod', async () => {
    const res = await grant(MEMBER_AGENT_TOKEN);
    expect(res.status).toBe(403);
    expect((await Task.findOne({ taskId: 'TASK-001' }).lean()).outsideAssignee).toBeNull();
  });

  test('a non-member admin cannot grant', async () => {
    expect((await grant(adminToken)).status).toBe(403);
  });

  test('a request that only collides with an agent username grants nothing', async () => {
    // foo/bar builds the username foo-bar, the same as foo-bar/default.
    await bot('foo-bar', 'cm_agent_outside_collision_test');
    await Pod.create({
      name: 'Collide', type: 'team', createdBy: owner._id, members: [owner._id, await User.findOne({ username: 'foo-bar' }).then((u) => u._id)], 
    });
    expect((await grant(ownerToken, { agentName: 'foo-bar', instanceId: 'default' })).status).toBe(200);
    await revoke(ownerToken);
    const res = await grant(ownerToken, { agentName: 'foo', instanceId: 'bar' });
    expect(res.status).toBe(404);
    expect((await Task.findOne({ taskId: 'TASK-001' }).lean()).outsideAssignee).toBeNull();
  });

  test('an agent already in the pod, or one that does not exist, is not granted', async () => {
    expect((await grant(ownerToken, { agentName: 'member-agent', instanceId: 'default' })).status).toBe(400);
    expect((await grant(ownerToken, { agentName: 'no-such-agent', instanceId: 'default' })).status).toBe(404);
    expect((await grant(ownerToken, { agentName: { $ne: null }, instanceId: 'default' })).status).toBe(400);
  });

  test('the outside agent may change status only', async () => {
    await grant(ownerToken);
    await claim(OUTSIDE_TOKEN);
    expect((await patch(OUTSIDE_TOKEN, { status: 'blocked' })).status).toBe(200);
    const refused = await [{ title: 'rewritten' }, { status: 'pending', assignee: 'someone' }, { notes: 'x' }, { outsideAssignee: null }]
      .reduce(async (prior, body) => [...await prior, (await patch(OUTSIDE_TOKEN, body)).status], Promise.resolve([]));
    expect(refused).toEqual([403, 403, 403, 403]);
    expect((await note(OUTSIDE_TOKEN, { text: 'up it', priority: 'P0' })).status).toBe(403);
    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row.title).toBe('the row');
    expect(row.outsideAssignee.userId).toBe(String(outside._id));
  });

  test('a person sets the grant through its own route, not PATCH', async () => {
    const res = await patch(ownerToken, { outsideAssignee: { agentName: 'outside-builder', instanceId: 'default' } });
    expect(res.status).toBe(400);
  });

  test('clearing the grant releases the agent claim, and its next call is refused', async () => {
    await grant(ownerToken);
    await claim(OUTSIDE_TOKEN);
    const cleared = await revoke(ownerToken);
    expect(cleared.status).toBe(200);
    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row).toEqual(expect.objectContaining({
      outsideAssignee: null, status: 'pending', claimedBy: null, claimedByUserId: null, claimExpiresAt: null,
    }));
    expect((await claim(OUTSIDE_TOKEN)).status).toBe(403);
    expect((await note(OUTSIDE_TOKEN)).status).toBe(403);
    // Free for a member at once, not at the lease end.
    expect((await claim(MEMBER_AGENT_TOKEN)).status).toBe(200);
  });

  test('clearing leaves a member claim alone', async () => {
    await grant(ownerToken);
    await claim(MEMBER_AGENT_TOKEN);
    await revoke(ownerToken);
    expect((await Task.findOne({ taskId: 'TASK-001' }).lean()).claimedByUserId).toBe(String(memberAgent._id));
  });

  test('the grantee still cannot read the board', async () => {
    await grant(ownerToken);
    const res = await request(app).get(`/api/v1/tasks/${team._id}`).set('Authorization', `Bearer ${OUTSIDE_TOKEN}`);
    expect([403, 404]).toContain(res.status);
  });

  test('assigned-to-me lists the agent its own outside rows, with only the pod id and name', async () => {
    await grant(ownerToken);
    const mine = await request(app).get('/api/v1/tasks/assigned-to-me').set('Authorization', `Bearer ${OUTSIDE_TOKEN}`);
    expect(mine.status).toBe(200);
    expect(mine.body.tasks).toHaveLength(1);
    expect(mine.body.tasks[0]).toEqual(expect.objectContaining({
      taskId: 'TASK-001', title: 'the row', status: 'pending', pod: { id: String(team._id), name: 'Team board' },
    }));
    expect(mine.body.tasks[0].updates).toBeUndefined();
    const theirs = await request(app).get('/api/v1/tasks/assigned-to-me').set('Authorization', `Bearer ${STRANGER_TOKEN}`);
    expect(theirs.body.tasks).toEqual([]);
    const person = await request(app).get('/api/v1/tasks/assigned-to-me').set('Authorization', `Bearer ${ownerToken}`);
    expect(person.status).toBe(403);
  });

  describe('an agent on a cm_ user token', () => {
    test('cannot grant, though auth treats its token as a person', async () => {
      await Pod.create({
        name: 'Peers', type: 'team', createdBy: owner._id, members: [memberAgent._id, outside._id], 
      });
      const res = await grant(MEMBER_USER_TOKEN);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('outside_assignee_person_only');
    });

    test('as the grantee, is held to a member live lease like any seat', async () => {
      await grant(ownerToken);
      expect((await claim(MEMBER_AGENT_TOKEN)).status).toBe(200);
      expect((await patch(OUTSIDE_USER_TOKEN, { status: 'pending' })).status).toBe(409);
      expect((await complete(OUTSIDE_USER_TOKEN)).status).toBe(409);
      expect((await patch(OUTSIDE_USER_TOKEN, { status: 'claimed' })).status).toBe(400);
      expect((await Task.findOne({ taskId: 'TASK-001' }).lean()).claimedByUserId).toBe(String(memberAgent._id));
    });

    test('lists its outside rows', async () => {
      await grant(ownerToken);
      const res = await request(app).get('/api/v1/tasks/assigned-to-me').set('Authorization', `Bearer ${OUTSIDE_USER_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.tasks.map((row) => row.taskId)).toEqual(['TASK-001']);
    });
  });

  test('the grantee may attach a PR link on completion but not rewrite the notes', async () => {
    await grant(ownerToken);
    await claim(OUTSIDE_TOKEN);
    const refused = await request(app).post(`${base()}/complete`).set('Authorization', `Bearer ${OUTSIDE_TOKEN}`).send({ notes: 'rewritten' });
    expect(refused.status).toBe(403);
    const done = await request(app).post(`${base()}/complete`).set('Authorization', `Bearer ${OUTSIDE_TOKEN}`)
      .send({ prUrl: 'https://github.com/example/repo/pull/1' });
    expect(done.status).toBe(200);
    expect(done.body.task.notes).toBeNull();
  });

  test('a member who takes the row after the grantee lapses keeps it through a revoke', async () => {
    await grant(ownerToken);
    await claim(OUTSIDE_TOKEN);
    await Task.updateOne({ taskId: 'TASK-001' }, { $set: { claimExpiresAt: new Date(Date.now() - 1000) } });
    expect((await claim(MEMBER_AGENT_TOKEN)).status).toBe(200);
    expect((await revoke(ownerToken)).status).toBe(200);
    const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
    expect(row).toEqual(expect.objectContaining({ status: 'claimed', claimedByUserId: String(memberAgent._id), outsideAssignee: null }));
  });

  test('clearing a row with no grant answers 404 and writes nothing', async () => {
    const res = await revoke(ownerToken);
    expect(res.status).toBe(404);
    expect((await Task.findOne({ taskId: 'TASK-001' }).lean()).updates).toEqual([]);
  });
});
