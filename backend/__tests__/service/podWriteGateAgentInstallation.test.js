/**
 * F149 — the shared dualAuth pod write gate decides agents by the agent's OWN
 * active installation in the pod.
 *
 * `podWriteAccessService.callerHasPodWriteAccess` looked agents up with
 * `AgentInstallation.findOne({ podId, installedBy: agentUser._id })`.
 * `installedBy` is the HUMAN who installed the agent, so the lookup missed for
 * every ordinary install and the gate fell back to `Pod.members` — a row an
 * uninstall can leave behind. An uninstalled agent still listed as a member
 * could react, follow threads and set collapse state in that pod.
 *
 * Every dualAuth route that reaches the gate is exercised here, through the
 * real `routes/messages` (rate limiter, dualAuth, agentRuntimeAuth,
 * controller) with real runtime tokens and a real mongod. PG is a stub: the
 * claim is about who the gate admits, not about SQL. The stub answers the
 * one message row the controllers read to learn the pod.
 *
 * Callers of the gate, and where each is covered:
 *   reactionController.addReaction       POST   /:messageId/reactions        (here)
 *   reactionController.removeReaction    DELETE /:messageId/reactions/:emoji (here)
 *   threadStateController.followThread   POST   /:messageId/follow           (here)
 *   threadStateController.unfollowThread DELETE /:messageId/follow           (here)
 *   threadStateController.setThreadCollapsed PUT /:messageId/collapsed       (here)
 *   threadStateController.listThreadState GET   /threads/state?podId=        (here)
 *   messageController.deleteMessage      DELETE /:id  (agentDeleteOwnMessage.test.js;
 *                                         already gated on the installation by F141)
 *   postController.addComment / likePost  `auth` only, no agent branch reachable
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const {
  setupMongoDb, closeMongoDb, clearMongoDb, generateTestToken,
} = require('../utils/testUtils');

const mockPgRows = new Map();
jest.mock('../../config/db-pg', () => ({
  pool: {
    query: jest.fn(async (sql, params = []) => {
      if (/FROM messages WHERE id = \$1/.test(sql)) {
        const row = mockPgRows.get(Number(params[0]));
        if (!row) return { rows: [] };
        return { rows: [{ ...row, root_id: row.id }] };
      }
      return { rows: [] };
    }),
  },
}));
jest.mock('../../models/pg/Message');
jest.mock('../../models/pg/MessageReaction', () => ({
  __esModule: true,
  default: {
    add: jest.fn(async () => false),
    remove: jest.fn(async () => true),
    listForMessage: jest.fn(async () => []),
  },
}));
jest.mock('../../models/pg/ThreadUserState', () => ({
  follow: jest.fn(async () => ({ followed_at: null })),
  unfollow: jest.fn(async () => undefined),
  setCollapsed: jest.fn(async () => undefined),
  effectiveStateForPod: jest.fn(async () => []),
}));
jest.mock('../../services/reactionAttributionService', () => ({
  decorateReactionSummaries: jest.fn(async (s) => s),
}));
jest.mock('../../services/starterTaskService', () => ({ completeConnectAgentStarterTask: jest.fn() }));

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const PGMessage = require('../../models/pg/Message');
const MongoMessage = require('../../models/Message');
const { hash } = require('../../utils/secret');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');
const { issueRuntimeTokenForAgent } = require('../../routes/registry/tokens');
const messageRoutes = require('../../routes/messages');

jest.setTimeout(60000);

beforeAll(async () => { await setupMongoDb(); });
afterAll(async () => { await closeMongoDb(); });

const app = express();
app.use(express.json());
app.use('/api/messages', messageRoutes);

let seq = 0;
const human = async (name) => {
  seq += 1;
  return User.create({ username: `${name}${seq}`, email: `${name}${seq}@t.test`, password: 'Password123!' });
};

const install = (agentName, podId, installedBy, status = 'active') => AgentInstallation.create({
  agentName, instanceId: 'default', podId, installedBy, status, displayName: agentName, version: '1.0.0',
});

/** An agent identity installed (active) in `pods`, listed in each pod's members, with a runtime token. */
const agent = async (agentName, owner, pods) => {
  const agentUser = await AgentIdentityService.getOrCreateAgentUser(agentName, { instanceId: 'default' });
  const installations = [];
  // Sequential on purpose: each install and membership write is one fixture step.
  // eslint-disable-next-line no-restricted-syntax
  for (const pod of pods) {
    // eslint-disable-next-line no-await-in-loop
    installations.push(await install(agentName, pod._id, owner._id));
    // eslint-disable-next-line no-await-in-loop
    await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: agentUser._id } });
  }
  const issued = await issueRuntimeTokenForAgent(agentUser, 'test key', installations[0], { ownerUserId: owner._id });
  expect(issued.token).toMatch(/^cm_agent_/);
  return { user: agentUser, token: issued.token };
};

const podFor = (owner, name = 'Pod', type = 'chat') => Pod.create({
  name, type, createdBy: owner._id, members: [owner._id],
});

let nextPgId = 500;
const pgMessage = (pod, author) => {
  nextPgId += 1;
  mockPgRows.set(nextPgId, { id: nextPgId, pod_id: String(pod._id), user_id: String(author._id) });
  return nextPgId;
};

// Every route that reaches the shared gate, as (label, request builder).
const ROUTES = [
  ['POST reaction', (id, pod, bearer) => request(app).post(`/api/messages/${id}/reactions`)
    .set('Authorization', `Bearer ${bearer}`).send({ emoji: '👍' })],
  ['DELETE reaction', (id, pod, bearer) => request(app).delete(`/api/messages/${id}/reactions/${encodeURIComponent('👍')}`)
    .set('Authorization', `Bearer ${bearer}`)],
  ['POST follow', (id, pod, bearer) => request(app).post(`/api/messages/${id}/follow`)
    .set('Authorization', `Bearer ${bearer}`)],
  ['DELETE follow', (id, pod, bearer) => request(app).delete(`/api/messages/${id}/follow`)
    .set('Authorization', `Bearer ${bearer}`)],
  ['PUT collapsed', (id, pod, bearer) => request(app).put(`/api/messages/${id}/collapsed`)
    .set('Authorization', `Bearer ${bearer}`).send({ collapsed: true })],
  ['GET thread state', (id, pod, bearer) => request(app).get(`/api/messages/threads/state?podId=${pod._id}`)
    .set('Authorization', `Bearer ${bearer}`)],
];

describe('F149: the shared pod write gate admits an agent by its own installation in the pod', () => {
  let owner;
  let pod;

  beforeEach(async () => {
    await clearMongoDb();
    mockPgRows.clear();
    PGMessage.resolveId = jest.fn(async (id) => (mockPgRows.has(Number(id)) ? String(id) : null));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    owner = await human('owner');
    pod = await podFor(owner);
  });
  afterEach(() => jest.restoreAllMocks());

  describe.each(ROUTES)('%s', (_label, call) => {
    test('an agent uninstalled from the pod but still listed in members is refused', async () => {
      const home = await podFor(owner, 'Home');
      const builder = await agent('builder', owner, [home, pod]);
      const id = pgMessage(pod, owner);
      await AgentInstallation.updateOne({ agentName: 'builder', podId: pod._id }, { $set: { status: 'uninstalled' } });
      // The membership row the uninstall left behind is the whole defect.
      expect((await Pod.findById(pod._id).lean()).members.map(String)).toContain(String(builder.user._id));
      const res = await call(id, pod, builder.token);
      expect(res.status).toBe(403);
    });

    test('an agent listed in members but installed only in a different pod is refused', async () => {
      const home = await podFor(owner, 'Home');
      const builder = await agent('builder', owner, [home]);
      await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: builder.user._id } });
      const id = pgMessage(pod, owner);
      const res = await call(id, pod, builder.token);
      expect(res.status).toBe(403);
    });

    test('an agent with an active installation in the pod is allowed', async () => {
      const builder = await agent('builder', owner, [pod]);
      const id = pgMessage(pod, owner);
      const res = await call(id, pod, builder.token);
      expect(res.status).toBe(200);
    });

    test('a human member is allowed', async () => {
      const id = pgMessage(pod, owner);
      const res = await call(id, pod, generateTestToken(owner._id));
      expect(res.status).toBe(200);
    });

    test('a human non-member is refused', async () => {
      const stranger = await human('stranger');
      const id = pgMessage(pod, owner);
      const res = await call(id, pod, generateTestToken(stranger._id));
      expect(res.status).toBe(403);
    });
  });

  // The agent's admin DM (`agent-admin`) carries no AgentInstallation: the
  // runtime post path authorizes it by membership (agentRuntimeAuth's
  // agentAuthorizedPodIds), and so does this gate. Unchanged by F149.
  describe('agent-admin pods keep their membership rule', () => {
    test('a member agent reacts in its admin DM without an installation there', async () => {
      const builder = await agent('builder', owner, [pod]);
      const adminPod = await Pod.create({
        name: 'builder admin', type: 'agent-admin', createdBy: owner._id, members: [owner._id, builder.user._id],
      });
      const id = pgMessage(adminPod, owner);
      const res = await ROUTES[0][1](id, adminPod, builder.token);
      expect(res.status).toBe(200);
    });

    test('a non-member agent is refused in someone else\'s admin DM', async () => {
      const builder = await agent('builder', owner, [pod]);
      const adminPod = await Pod.create({
        name: 'other admin', type: 'agent-admin', createdBy: owner._id, members: [owner._id],
      });
      const id = pgMessage(adminPod, owner);
      const res = await ROUTES[0][1](id, adminPod, builder.token);
      expect(res.status).toBe(403);
    });
  });
});

// A bot User can hold a cm_ user API token (auth.ts admits it for REST/MCP
// access). That lands on the gate's HUMAN branch, with no req.agentUser, so
// before F149 a left-behind members row admitted an uninstalled bot here too.
// A bot on that branch must pass the agent rule as well: an active
// installation in the pod for its own agentName/instanceId.
describe('F149: a bot with a cm_ user API token on the human branch also needs its installation', () => {
  let owner;
  let pod;
  let tokenSeq = 0;
  const cmToken = async (user) => {
    tokenSeq += 1;
    const token = `cm_f149bot${tokenSeq}${new mongoose.Types.ObjectId().toHexString()}`;
    await User.updateOne({ _id: user._id }, { $set: { apiTokenHash: hash(token) } });
    return token;
  };
  const bot = () => AgentIdentityService.getOrCreateAgentUser('builder', { instanceId: 'default' });

  beforeEach(async () => {
    await clearMongoDb();
    mockPgRows.clear();
    PGMessage.resolveId = jest.fn(async (id) => (mockPgRows.has(Number(id)) ? String(id) : null));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    owner = await human('owner');
    pod = await podFor(owner);
  });
  afterEach(() => jest.restoreAllMocks());

  describe.each(ROUTES)('%s', (_label, call) => {
    test('an uninstalled bot still listed in members is refused', async () => {
      const b = await bot();
      await install('builder', pod._id, owner._id, 'uninstalled');
      await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: b._id } });
      const res = await call(pgMessage(pod, owner), pod, await cmToken(b));
      expect(res.status).toBe(403);
    });

    test('a bot listed in members but installed only in a different pod is refused', async () => {
      const b = await bot();
      const home = await podFor(owner, 'Home');
      await install('builder', home._id, owner._id);
      await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: b._id } });
      const res = await call(pgMessage(pod, owner), pod, await cmToken(b));
      expect(res.status).toBe(403);
    });

    test('an installed bot listed in members is allowed', async () => {
      const b = await bot();
      await install('builder', pod._id, owner._id);
      await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: b._id } });
      const res = await call(pgMessage(pod, owner), pod, await cmToken(b));
      expect(res.status).toBe(200);
    });

    test('an installed bot NOT listed in members stays refused, as before', async () => {
      const b = await bot();
      await install('builder', pod._id, owner._id);
      const res = await call(pgMessage(pod, owner), pod, await cmToken(b));
      expect(res.status).toBe(403);
    });

    test('a human member with a cm_ token is allowed, unchanged', async () => {
      const res = await call(pgMessage(pod, owner), pod, await cmToken(owner));
      expect(res.status).toBe(200);
    });
  });
});

describe('F149: a bot holding a cm_ user API token gets no pod-creator override on DELETE /api/messages/:id', () => {
  const priorPgHost = process.env.PG_HOST;

  afterAll(() => {
    if (priorPgHost === undefined) delete process.env.PG_HOST; else process.env.PG_HOST = priorPgHost;
  });
  beforeEach(async () => {
    await clearMongoDb();
    process.env.PG_HOST = '';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const del = (id, bearer) => request(app).delete(`/api/messages/${id}`).set('Authorization', `Bearer ${bearer}`);
  const withApiToken = async (user, token) => {
    await User.updateOne({ _id: user._id }, { $set: { apiTokenHash: hash(token) } });
    return token;
  };

  test("a bot User that created the pod cannot delete a human's message with a cm_ user token", async () => {
    const owner = await human('owner');
    const bot = await AgentIdentityService.getOrCreateAgentUser('builder', { instanceId: 'default' });
    // agentsRuntime creates pods with createdBy: agentUser._id, so this shape is real.
    const botPod = await Pod.create({
      name: 'Bot pod', type: 'chat', createdBy: bot._id, members: [bot._id, owner._id],
    });
    const msg = await MongoMessage.create({
      podId: botPod._id, userId: owner._id, content: 'hi', messageType: 'text', 
    });
    const token = await withApiToken(bot, `cm_${new mongoose.Types.ObjectId().toHexString()}x`);
    const res = await del(msg._id, token);
    expect(res.status).toBe(401);
    expect(await MongoMessage.findById(msg._id)).not.toBeNull();
  });

  test('an uninstalled bot cannot delete even its own message with a cm_ user token', async () => {
    const owner = await human('owner');
    const bot = await AgentIdentityService.getOrCreateAgentUser('builder', { instanceId: 'default' });
    const botPod = await Pod.create({
      name: 'Bot pod', type: 'chat', createdBy: bot._id, members: [bot._id, owner._id],
    });
    const msg = await MongoMessage.create({
      podId: botPod._id, userId: bot._id, content: 'mine', messageType: 'text',
    });
    const token = await withApiToken(bot, `cm_${new mongoose.Types.ObjectId().toHexString()}y`);
    const res = await del(msg._id, token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('agent_not_installed_in_pod');
    expect(await MongoMessage.findById(msg._id)).not.toBeNull();
  });

  test('an installed bot deletes its own message with a cm_ user token', async () => {
    const owner = await human('owner');
    const bot = await AgentIdentityService.getOrCreateAgentUser('builder', { instanceId: 'default' });
    const botPod = await Pod.create({
      name: 'Bot pod', type: 'chat', createdBy: owner._id, members: [bot._id, owner._id],
    });
    await install('builder', botPod._id, owner._id);
    const msg = await MongoMessage.create({
      podId: botPod._id, userId: bot._id, content: 'mine', messageType: 'text',
    });
    const token = await withApiToken(bot, `cm_${new mongoose.Types.ObjectId().toHexString()}w`);
    const res = await del(msg._id, token);
    expect(res.status).toBe(200);
    expect(await MongoMessage.findById(msg._id)).toBeNull();
  });

  test("a human pod creator with a cm_ user token still deletes someone else's message", async () => {
    const owner = await human('owner');
    const member = await human('member');
    const humanPod = await Pod.create({
      name: 'Human pod', type: 'chat', createdBy: owner._id, members: [owner._id, member._id],
    });
    const msg = await MongoMessage.create({
      podId: humanPod._id, userId: member._id, content: 'x', messageType: 'text', 
    });
    const token = await withApiToken(owner, `cm_${new mongoose.Types.ObjectId().toHexString()}z`);
    const res = await del(msg._id, token);
    expect(res.status).toBe(200);
    expect(await MongoMessage.findById(msg._id)).toBeNull();
  });
});
