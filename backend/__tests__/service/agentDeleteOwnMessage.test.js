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
const mockPgQuery = jest.fn();
jest.mock('../../config/db-pg', () => ({ pool: { query: (...args) => mockPgQuery(...args) } }));
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
const { hash } = require('../../utils/secret');
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

  // A delete leaves nothing behind in the store, so the log line is the only
  // record that it happened — for an agent steered by a stranger, the record
  // of what it removed. One line per success; never the content.
  describe('every successful delete is logged, without content', () => {
    const deleteLines = (spy) => spy.mock.calls
      .map((args) => args.map(String).join(' '))
      .filter((line) => line.includes('message deleted'));

    test('an agent delete logs pod, message, caller and kind', async () => {
      const info = jest.spyOn(console, 'info').mockImplementation(() => {});
      const builder = await agent('builder', owner, [pod]);
      const msg = await post(builder.user, 'secret placeholder text');
      expect((await del(msg._id, builder.token)).status).toBe(200);
      const lines = deleteLines(info);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`pod=${pod._id}`);
      expect(lines[0]).toContain(`message=${msg._id}`);
      expect(lines[0]).toContain(`caller=${builder.user._id}`);
      expect(lines[0]).toContain('callerKind=agent');
      expect(lines[0]).not.toContain('secret placeholder text');
    });

    test('a human delete logs callerKind=human', async () => {
      const info = jest.spyOn(console, 'info').mockImplementation(() => {});
      const builder = await agent('builder', owner, [pod]);
      const msg = await post(builder.user, 'secret placeholder text');
      expect((await del(msg._id, generateTestToken(owner._id))).status).toBe(200);
      const lines = deleteLines(info);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`pod=${pod._id}`);
      expect(lines[0]).toContain(`message=${msg._id}`);
      expect(lines[0]).toContain(`caller=${owner._id}`);
      expect(lines[0]).toContain('callerKind=human');
      expect(lines[0]).not.toContain('secret placeholder text');
    });

    test('a refused delete logs no delete line, agent or human', async () => {
      const info = jest.spyOn(console, 'info').mockImplementation(() => {});
      const builder = await agent('builder', owner, [pod]);
      const stranger = await human('stranger');
      const msg = await post(owner);
      expect((await del(msg._id, builder.token)).status).toBe(403);
      expect((await del(msg._id, generateTestToken(stranger._id))).status).toBe(401);
      expect(deleteLines(info)).toEqual([]);
    });
  });

  // F438. A system line ("builder isn't connected yet", a task claim) is the
  // platform's record, stored under the account it is about (F434). Being that
  // account confers nothing: no agent deletes or retimes one, and a person
  // does so only as the pod's creator.
  describe('system lines stored under the caller (F438)', () => {
    const systemLine = (about) => MongoMessage.create({
      podId: pod._id, userId: about._id, content: 'builder isn\'t connected yet', messageType: 'system',
    });
    // A bot row holding a cm_ user bearer rides the human branch as req.botCaller (F149).
    const userBearerFor = async (botUser) => {
      seq += 1;
      const bearer = `cm_f438bot${seq}x`;
      await User.updateOne({ _id: botUser._id }, { $set: { apiTokenHash: hash(bearer) } });
      return bearer;
    };

    test('an agent runtime token cannot delete a system line stored under it', async () => {
      const builder = await agent('builder', owner, [pod]);
      const line = await systemLine(builder.user);
      const res = await del(line._id, builder.token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('system_line');
      expect(await exists(line)).toBe(true);
    });

    test('nor can the same agent through a cm_ user bearer', async () => {
      const builder = await agent('builder', owner, [pod]);
      const line = await systemLine(builder.user);
      const res = await del(line._id, await userBearerFor(builder.user));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('system_line');
      expect(await exists(line)).toBe(true);
    });

    test('a person a system line is stored under cannot delete it either', async () => {
      const member = await human('member');
      await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: member._id } });
      const line = await systemLine(member);
      const res = await del(line._id, generateTestToken(member._id));
      expect(res.status).toBe(401);
      expect(await exists(line)).toBe(true);
    });

    test('the pod creator still deletes a system line', async () => {
      const builder = await agent('builder', owner, [pod]);
      const line = await systemLine(builder.user);
      const res = await del(line._id, generateTestToken(owner._id));
      expect(res.status).toBe(200);
      expect(await exists(line)).toBe(false);
    });

    test('an agent cannot delete a PG system line stored under it', async () => {
      process.env.PG_HOST = 'pg.mocked';
      const builder = await agent('builder', owner, [pod]);
      const row = {
        id: 201, pod_id: String(pod._id), user_id: String(builder.user._id), content: 'offline', message_type: 'system',
      };
      PGMessage.resolveId = jest.fn(async () => '201');
      PGMessage.findById = jest.fn(async () => row);
      PGMessage.delete = jest.fn();
      const res = await del('201', builder.token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('system_line');
      expect(PGMessage.delete).not.toHaveBeenCalled();
    });

    describe('PATCH /api/messages/:id/created-at', () => {
      const retime = (id, bearer) => request(app)
        .patch(`/api/messages/${id}/created-at`)
        .set('Authorization', `Bearer ${bearer}`)
        .send({ created_at: '2026-11-01T10:00:00Z' });
      const pgRow = (about) => ({
        pgId: '301', pod_id: String(pod._id), user_id: String(about._id), message_type: 'system',
      });
      beforeEach(() => {
        mockPgQuery.mockReset();
        mockPgQuery.mockResolvedValue({ rowCount: 1, rows: [{ id: 301, created_at: '2026-11-01T10:00:00Z' }] });
      });

      test('an agent cannot retime a system line stored under it', async () => {
        const builder = await agent('builder', owner, [pod]);
        PGMessage.findById = jest.fn(async () => pgRow(builder.user));
        const res = await retime('301', await userBearerFor(builder.user));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('system_line');
        expect(mockPgQuery).not.toHaveBeenCalled();
      });

      test('a person a system line is stored under cannot retime it', async () => {
        const member = await human('member');
        PGMessage.findById = jest.fn(async () => pgRow(member));
        const res = await retime('301', generateTestToken(member._id));
        expect(res.status).toBe(403);
        expect(mockPgQuery).not.toHaveBeenCalled();
      });

      test('the pod creator retimes a system line', async () => {
        const builder = await agent('builder', owner, [pod]);
        PGMessage.findById = jest.fn(async () => pgRow(builder.user));
        const res = await retime('301', generateTestToken(owner._id));
        expect(res.status).toBe(200);
        expect(mockPgQuery).toHaveBeenCalledTimes(1);
      });
    });
  });

  // F440. The platform's cards and kernel posts are stored under the agent
  // they speak for (an approval or run-request card, an intro or nudge). The
  // agent did not write them, so it may not delete or move them. The ui card
  // an agent posts itself stays its own.
  describe('platform posts stored under the agent (F440)', () => {
    const approvalCard = (about) => MongoMessage.create({
      podId: pod._id,
      userId: about._id,
      content: '[approval needed] send the digest',
      messageType: 'card',
      payload: { kind: 'approval', approvalId: 'a1' },
    });
    const kernelPost = (about) => MongoMessage.create({
      podId: pod._id, userId: about._id, content: 'Hi, I just joined', messageType: 'text', authorKind: 'kernel',
    });
    const userBearerFor = async (botUser) => {
      seq += 1;
      const bearer = `cm_f440bot${seq}x`;
      await User.updateOne({ _id: botUser._id }, { $set: { apiTokenHash: hash(bearer) } });
      return bearer;
    };

    test('an agent cannot delete the approval card the platform posted under it', async () => {
      const builder = await agent('builder', owner, [pod]);
      const card = await approvalCard(builder.user);
      const res = await del(card._id, builder.token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('platform_post');
      expect(await exists(card)).toBe(true);
    });

    test('nor through a cm_ user bearer', async () => {
      const builder = await agent('builder', owner, [pod]);
      const card = await approvalCard(builder.user);
      const res = await del(card._id, await userBearerFor(builder.user));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('platform_post');
      expect(await exists(card)).toBe(true);
    });

    test('an agent cannot delete its kernel intro', async () => {
      const builder = await agent('builder', owner, [pod]);
      const intro = await kernelPost(builder.user);
      const res = await del(intro._id, builder.token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('platform_post');
      expect(await exists(intro)).toBe(true);
    });

    test('an agent still deletes a ui card it posted itself', async () => {
      const builder = await agent('builder', owner, [pod]);
      const own = await MongoMessage.create({
        podId: pod._id,
        userId: builder.user._id,
        content: 'status',
        messageType: 'card',
        payload: { kind: 'ui', v: 1, lang: 'openui@1' },
      });
      const res = await del(own._id, builder.token);
      expect(res.status).toBe(200);
      expect(await exists(own)).toBe(false);
    });

    test('the pod creator still deletes a platform card', async () => {
      const builder = await agent('builder', owner, [pod]);
      const card = await approvalCard(builder.user);
      const res = await del(card._id, generateTestToken(owner._id));
      expect(res.status).toBe(200);
      expect(await exists(card)).toBe(false);
    });

    test('an agent cannot delete a PG run-request card stored under it', async () => {
      process.env.PG_HOST = 'pg.mocked';
      const builder = await agent('builder', owner, [pod]);
      const row = {
        id: 401,
        pod_id: String(pod._id),
        user_id: String(builder.user._id),
        content: '[approval needed] run it',
        message_type: 'card',
        payload: { kind: 'approval', actionType: 'run_request' },
      };
      PGMessage.resolveId = jest.fn(async () => '401');
      PGMessage.findById = jest.fn(async () => row);
      PGMessage.delete = jest.fn();
      const res = await del('401', builder.token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('platform_post');
      expect(PGMessage.delete).not.toHaveBeenCalled();
    });

    test('an agent cannot retime a platform card stored under it', async () => {
      mockPgQuery.mockReset();
      const builder = await agent('builder', owner, [pod]);
      PGMessage.findById = jest.fn(async () => ({
        pgId: '402', pod_id: String(pod._id), user_id: String(builder.user._id),
        message_type: 'card', payload: { kind: 'approval' },
      }));
      const res = await request(app)
        .patch('/api/messages/402/created-at')
        .set('Authorization', `Bearer ${await userBearerFor(builder.user)}`)
        .send({ created_at: '2026-11-01T10:00:00Z' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('platform_post');
      expect(mockPgQuery).not.toHaveBeenCalled();
    });
  });
});
