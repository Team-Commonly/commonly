/**
 * F141 / TASK-773 — an agent deletes a message it posted.
 *
 * On 11-04 a Builder agent posted a stray placeholder and had no way to remove
 * it: `DELETE /api/messages/:id` took a human JWT only. The route now takes
 * `dualAuth`, and an agent may delete only a message it authored, and only
 * while it holds an active AgentInstallation in that message's pod. It never
 * gets the pod-creator override a human has.
 *
 * Real mongod, real `routes/messages` (rate limiter, dualAuth,
 * agentRuntimeAuth, controller), and tokens minted the way drivers get them
 * (`issueRuntimeTokenForAgent`). The Mongo store is real; the PG store is the
 * same jest automock `messages.test.js` uses, with PG_HOST toggled per block,
 * because the PG path's claim is about which store the controller consults
 * and deletes, not about SQL.
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const {
  setupMongoDb, closeMongoDb, clearMongoDb, generateTestToken,
} = require('../utils/testUtils');

jest.mock('../../models/pg/Message');
jest.mock('../../services/starterTaskService', () => ({ completeConnectAgentStarterTask: jest.fn() }));

const priorPgHost = process.env.PG_HOST;
process.env.PG_HOST = '';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const MongoMessage = require('../../models/Message');
const PGMessage = require('../../models/pg/Message');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');
const { issueRuntimeTokenForAgent } = require('../../routes/registry/tokens');
const messageRoutes = require('../../routes/messages');

jest.setTimeout(60_000);

const app = express();
app.use(express.json());
app.use('/api/messages', messageRoutes);

let seq = 0;
const human = async (name) => {
  seq += 1;
  return User.create({ username: `${name}${seq}`, email: `${name}${seq}@t.test`, password: 'Password123!' });
};

const install = (agentName, podId, installedBy, status = 'active') => AgentInstallation.create({
  agentName,
  instanceId: 'default',
  podId,
  installedBy,
  status,
  displayName: agentName,
  version: '1.0.0',
});

/** An agent identity installed (active) in `pods`, listed in each pod's members, with a runtime token. */
const agent = async (agentName, owner, pods) => {
  const agentUser = await AgentIdentityService.getOrCreateAgentUser(agentName, { instanceId: 'default' });
  const installations = [];
  for (const pod of pods) {
    installations.push(await install(agentName, pod._id, owner._id));
    await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: agentUser._id } });
  }
  const issued = await issueRuntimeTokenForAgent(agentUser, 'test key', installations[0], { ownerUserId: owner._id });
  expect(issued.token).toMatch(/^cm_agent_/);
  return { user: agentUser, token: issued.token };
};

const podFor = (owner, name = 'Pod') => Pod.create({
  name, type: 'chat', createdBy: owner._id, members: [owner._id],
});

const del = (id, bearer) => request(app).delete(`/api/messages/${id}`).set('Authorization', `Bearer ${bearer}`);

describe('DELETE /api/messages/:id — agent delete-own-message (Mongo store)', () => {
  let owner;
  let pod;
  const post = (author, content = 'placeholder') => MongoMessage.create({
    podId: pod._id, userId: author._id, content, messageType: 'text',
  });
  const exists = async (msg) => Boolean(await MongoMessage.findById(msg._id));

  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => {
    await closeMongoDb();
    if (priorPgHost === undefined) delete process.env.PG_HOST; else process.env.PG_HOST = priorPgHost;
  });
  beforeEach(async () => {
    await clearMongoDb();
    process.env.PG_HOST = '';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    owner = await human('owner');
    pod = await podFor(owner);
  });
  afterEach(() => jest.restoreAllMocks());

  test('an agent runtime token deletes its own message', async () => {
    const builder = await agent('builder', owner, [pod]);
    const msg = await post(builder.user);
    const res = await del(msg._id, builder.token);
    expect(res.status).toBe(200);
    expect(await exists(msg)).toBe(false);
  });

  test('the token is also accepted on x-commonly-agent-token alone', async () => {
    const builder = await agent('builder', owner, [pod]);
    const msg = await post(builder.user);
    const res = await request(app).delete(`/api/messages/${msg._id}`).set('x-commonly-agent-token', builder.token);
    expect(res.status).toBe(200);
    expect(await exists(msg)).toBe(false);
  });

  test("an agent cannot delete a human's message, even in a pod its installer created", async () => {
    const builder = await agent('builder', owner, [pod]);
    const msg = await post(owner);
    const res = await del(msg._id, builder.token);
    expect(res.status).toBe(403);
    expect(await exists(msg)).toBe(true);
  });

  test("an agent cannot delete another agent's message", async () => {
    const builder = await agent('builder', owner, [pod]);
    const other = await agent('reviewer', owner, [pod]);
    const msg = await post(other.user);
    const res = await del(msg._id, builder.token);
    expect(res.status).toBe(403);
    expect(await exists(msg)).toBe(true);
  });

  test('an agent that created the pod itself still gets no creator override', async () => {
    const builder = await agent('builder', owner, [pod]);
    const ownPod = await Pod.create({
      name: 'Agent pod', type: 'chat', createdBy: builder.user._id, members: [builder.user._id, owner._id],
    });
    await install('builder', ownPod._id, owner._id);
    const msg = await MongoMessage.create({ podId: ownPod._id, userId: owner._id, content: 'hi', messageType: 'text' });
    const res = await del(msg._id, builder.token);
    expect(res.status).toBe(403);
    expect(await exists(msg)).toBe(true);
  });

  test('an agent with no active installation in the pod is refused, even for its own message', async () => {
    const home = await podFor(owner, 'Home');
    const builder = await agent('builder', owner, [home]);
    // Still listed as a member of `pod` (stale membership), but never installed there.
    await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: builder.user._id } });
    const msg = await post(builder.user);
    const res = await del(msg._id, builder.token);
    expect(res.status).toBe(403);
    expect(await exists(msg)).toBe(true);
  });

  test('an agent uninstalled from the pod cannot delete there, even its own message', async () => {
    const home = await podFor(owner, 'Home');
    const builder = await agent('builder', owner, [home, pod]);
    const msg = await post(builder.user);
    await AgentInstallation.updateOne({ agentName: 'builder', podId: pod._id }, { $set: { status: 'uninstalled' } });
    // Membership left behind on purpose: the installation is what decides.
    const res = await del(msg._id, builder.token);
    expect(res.status).toBe(403);
    expect(await exists(msg)).toBe(true);
  });

  describe('human paths are unchanged', () => {
    test('a human deletes their own message', async () => {
      const member = await human('member');
      await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: member._id } });
      const msg = await post(member);
      const res = await del(msg._id, generateTestToken(member._id));
      expect(res.status).toBe(200);
      expect(await exists(msg)).toBe(false);
    });

    test("the pod creator deletes someone else's message, an agent's included", async () => {
      const builder = await agent('builder', owner, [pod]);
      const msg = await post(builder.user);
      const res = await del(msg._id, generateTestToken(owner._id));
      expect(res.status).toBe(200);
      expect(await exists(msg)).toBe(false);
    });

    test("a stranger cannot delete someone else's message", async () => {
      const stranger = await human('stranger');
      const msg = await post(owner);
      const res = await del(msg._id, generateTestToken(stranger._id));
      expect(res.status).toBe(401);
      expect(await exists(msg)).toBe(true);
    });
  });

  describe('PG store (PG_HOST set)', () => {
    let rows;
    beforeEach(() => {
      process.env.PG_HOST = 'pg.mocked';
      rows = new Map();
      PGMessage.resolveId = jest.fn(async (id) => (rows.has(String(id)) ? String(id) : null));
      PGMessage.findById = jest.fn(async (id) => rows.get(String(id)) || null);
      PGMessage.delete = jest.fn(async (id) => { const row = rows.get(String(id)); rows.delete(String(id)); return row; });
    });
    const pgPost = (author, id) => {
      rows.set(String(id), { id, pod_id: String(pod._id), user_id: String(author._id), content: 'placeholder' });
      return String(id);
    };

    test('an agent deletes its own PG message', async () => {
      const builder = await agent('builder', owner, [pod]);
      const id = pgPost(builder.user, 101);
      const res = await del(id, builder.token);
      expect(res.status).toBe(200);
      expect(PGMessage.delete).toHaveBeenCalledWith(id);
      expect(rows.has(id)).toBe(false);
    });

    test("an agent cannot delete a human's PG message in its installer's pod", async () => {
      const builder = await agent('builder', owner, [pod]);
      const id = pgPost(owner, 102);
      const res = await del(id, builder.token);
      expect(res.status).toBe(403);
      expect(PGMessage.delete).not.toHaveBeenCalled();
    });

    test('an agent uninstalled from the pod cannot delete its own PG message', async () => {
      const home = await podFor(owner, 'Home');
      const builder = await agent('builder', owner, [home, pod]);
      const id = pgPost(builder.user, 103);
      await AgentInstallation.updateOne({ agentName: 'builder', podId: pod._id }, { $set: { status: 'uninstalled' } });
      const res = await del(id, builder.token);
      expect(res.status).toBe(403);
      expect(PGMessage.delete).not.toHaveBeenCalled();
    });

    test("the pod creator still deletes someone else's PG message", async () => {
      const builder = await agent('builder', owner, [pod]);
      const id = pgPost(builder.user, 104);
      const res = await del(id, generateTestToken(owner._id));
      expect(res.status).toBe(200);
      expect(PGMessage.delete).toHaveBeenCalledWith(id);
    });
  });

  // Unused id guard: a well-formed id that names nothing is a 404 for an agent too.
  test('an agent gets 404 for a message that does not exist', async () => {
    const builder = await agent('builder', owner, [pod]);
    const res = await del(new mongoose.Types.ObjectId().toHexString(), builder.token);
    expect(res.status).toBe(404);
  });
});
