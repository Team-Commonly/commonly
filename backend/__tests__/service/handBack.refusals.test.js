/**
 * ADR-037 §3–§4 (F654): who may review a plan, and who it is for, decided on
 * the server before anything is posted. Real Mongo (users, pods, installs,
 * agent events, the runtime token check); the hand_backs table is the shipped
 * migration on pg-mem. Every request goes through the real routes and the real
 * agentRuntimeAuth / auth / dualAuth middleware.
 */
jest.mock('../../config/db-pg', () => {
  // eslint-disable-next-line global-require
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  return { pool: new Pool() };
});

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { pool } = require('../../config/db-pg');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentEvent = require('../../models/AgentEvent');
const DecisionRequest = require('../../models/DecisionRequest');
const { AgentInstallation } = require('../../models/AgentRegistry');
const Task = require('../../models/Task');
const { hash } = require('../../utils/secret');
const repo = require('../../repositories/handBackRepository');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const MIGRATION = fs.readFileSync(path.join(__dirname, '../../config/migrations/0029_hand_backs.sql'), 'utf8');

describe('hand-back people rules (ADR-037 §3, §4)', () => {
  let app;
  let seq = 0;

  beforeAll(async () => {
    await setupMongoDb();
    await pool.query(MIGRATION);
    app = express();
    app.use(express.json());
    app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
    app.use('/api/pods', require('../../routes/handBacks').podHandBacksRouter);
    app.use('/api/hand-backs', require('../../routes/handBacks'));
    require('../../services/handBackService').registerHandBackSubject();
  });
  afterAll(async () => { await closeMongoDb(); });
  afterEach(async () => {
    await clearMongoDb();
    await pool.query('DELETE FROM hand_backs');
    jest.restoreAllMocks();
  });

  const person = async (name) => {
    seq += 1;
    return User.create({ username: `${name}-${seq}`, email: `${name}-${seq}@example.com`, password: 'unused' });
  };
  const tokenFor = (user) => jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET);
  const agent = async (name, { ownerUserId } = {}) => {
    seq += 1;
    const raw = `cm_agent_${String(seq).padStart(4, '0')}${'c'.repeat(60)}`;
    const bot = await User.create({
      username: `bot${seq}${name}`, email: `bot${seq}${name}@agents.example.com`, password: 'unused', isBot: true,
      botMetadata: { agentName: name, instanceId: 'default', ...(ownerUserId ? { ownerUserId: String(ownerUserId) } : {}) },
      agentRuntimeTokens: [{ tokenHash: hash(raw), label: 'test', createdAt: new Date() }],
    });
    return { bot, raw };
  };
  const install = (name, pod, installedBy) => AgentInstallation.create({
    agentName: name, instanceId: 'default', podId: pod._id, installedBy, version: '1.0.0', status: 'active',
  });

  /** A team pod: alice owns claude; bob and carol are people; codex is bob's agent. */
  const teamPod = async ({ withCarol = true, ownerUserIdOnly = false } = {}) => {
    const alice = await person('alice');
    const bob = await person('bob');
    const carol = withCarol ? await person('carol') : null;
    const claude = await agent('claude', ownerUserIdOnly ? { ownerUserId: alice._id } : {});
    const codex = await agent('codex', { ownerUserId: bob._id });
    const pod = await Pod.create({
      name: `Team ${seq}`, type: 'team', createdBy: alice._id,
      members: [alice._id, bob._id, ...(carol ? [carol._id] : []), claude.bot._id, codex.bot._id],
    });
    // An ownerUserId-only owner: the installation names the agent itself
    // (ADR-004 C1), so alice is the owner only through botMetadata.ownerUserId.
    await install('claude', pod, ownerUserIdOnly ? claude.bot._id : alice._id);
    await install('codex', pod, bob._id);
    return { alice, bob, carol, claude, codex, pod };
  };

  const sendPlan = (agentRaw, podId, body) => request(app)
    .post(`/api/agents/runtime/pods/${podId}/hand-backs`)
    .set('Authorization', `Bearer ${agentRaw}`)
    .send({ asked: { text: 'Fix the flaky login test' }, plan: 'Retry the network mock, then pin the clock.', ...body });

  const delivered = (podId, messageId, userId, overrides = {}) => AgentEvent.create({
    agentName: 'claude', instanceId: 'default', podId, type: 'chat.mention', status: 'delivered',
    payload: { messageId, userId: String(userId), content: 'please fix it' }, ...overrides,
  });

  test('the requester is refused as reviewer', async () => {
    const { alice, bob, claude, pod } = await teamPod();
    await delivered(pod._id, '501', bob._id);
    const res = await sendPlan(claude.raw, pod._id, {
      reviewerUserId: String(bob._id), asked: { text: 'Fix it', sourceMessageId: '501' },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'reviewer_ineligible', reason: 'is_requester' });
    expect(await DecisionRequest.countDocuments()).toBe(0);
    expect((await pool.query('SELECT * FROM hand_backs')).rows).toEqual([]);
    expect(String(alice._id)).toBeTruthy();
  });

  test('the installer-owner is refused as reviewer', async () => {
    const { alice, carol, claude, pod } = await teamPod();
    await delivered(pod._id, '511', carol._id);
    const res = await sendPlan(claude.raw, pod._id, {
      reviewerUserId: String(alice._id), asked: { text: 'Fix it', sourceMessageId: '511' },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'reviewer_ineligible', reason: 'is_owner' });
    // With no source message the owner is also the requester: still refused.
    const noSource = await sendPlan(claude.raw, pod._id, { reviewerUserId: String(alice._id) });
    expect(noSource.body).toMatchObject({ code: 'reviewer_ineligible', reason: 'is_requester' });
  });

  test('an owner known only through botMetadata.ownerUserId is refused as reviewer', async () => {
    const { alice, bob, claude, pod } = await teamPod({ ownerUserIdOnly: true });
    await delivered(pod._id, '502', bob._id);
    const res = await sendPlan(claude.raw, pod._id, {
      reviewerUserId: String(alice._id), asked: { text: 'Fix it', sourceMessageId: '502' },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'reviewer_ineligible', reason: 'is_owner' });
  });

  test('a bot is refused as reviewer, and so is a person outside the pod', async () => {
    const { codex, claude, pod } = await teamPod();
    const res = await sendPlan(claude.raw, pod._id, { reviewerUserId: String(codex.bot._id) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'reviewer_ineligible', reason: 'not_a_person' });
    const outsider = await person('outsider');
    const outside = await sendPlan(claude.raw, pod._id, { reviewerUserId: String(outsider._id) });
    expect(outside.body).toMatchObject({ code: 'reviewer_ineligible', reason: 'not_a_member' });
  });

  test('a pod with one human answers no_eligible_reviewer', async () => {
    const alice = await person('alice');
    const claude = await agent('claude');
    const pod = await Pod.create({
      name: 'Solo', type: 'team', createdBy: alice._id, members: [alice._id, claude.bot._id],
    });
    await install('claude', pod, alice._id);
    const res = await sendPlan(claude.raw, pod._id, { reviewerUserId: String(alice._id) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_eligible_reviewer');
    expect(res.body.message).toMatch(/invite a reviewer/i);
    expect(await DecisionRequest.countDocuments()).toBe(0);
  });

  test('a sourceMessageId not delivered to this agent is refused source_not_delivered', async () => {
    const { bob, carol, claude, pod } = await teamPod();
    // Delivered to another agent, still pending for this one, and a digest fold: none count.
    await delivered(pod._id, '601', bob._id, { agentName: 'codex' });
    await delivered(pod._id, '602', bob._id, { status: 'pending' });
    await delivered(pod._id, '603', bob._id, { deliveryMode: 'digest' });
    for (const id of ['601', '602', '603', '604']) {
      const res = await sendPlan(claude.raw, pod._id, {
        reviewerUserId: String(carol._id), asked: { text: 'Fix it', sourceMessageId: id },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('source_not_delivered');
    }
  });

  // Review note 7: the delivery has to be a wake, and in this pod.
  test('a delivery in another pod, or of a non-wake event type, is refused source_not_delivered', async () => {
    const { alice, bob, carol, claude, pod } = await teamPod();
    const elsewhere = await Pod.create({
      name: `Elsewhere ${seq}`, type: 'team', createdBy: alice._id, members: [alice._id, bob._id, claude.bot._id],
    });
    await install('claude', elsewhere, alice._id);
    await delivered(elsewhere._id, '611', bob._id);
    await delivered(pod._id, '612', bob._id, { type: 'heartbeat' });
    await delivered(pod._id, '613', bob._id, { type: 'decision.ruled' });
    for (const id of ['611', '612', '613']) {
      const res = await sendPlan(claude.raw, pod._id, {
        reviewerUserId: String(carol._id), asked: { text: 'Fix it', sourceMessageId: id },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('source_not_delivered');
    }
    // Control: the same message delivered as a wake in this pod is accepted as the source.
    await delivered(pod._id, '614', bob._id);
    const ok = await sendPlan(claude.raw, pod._id, {
      reviewerUserId: String(carol._id), asked: { text: 'Fix it', sourceMessageId: '614' },
    });
    expect(ok.body.code).not.toBe('source_not_delivered');
  });

  // Review note 5: a task the author agent made itself does not name who asked.
  test("the author agent's own task falls back to the owner; a person's task names that person", async () => {
    const { alice, bob, carol, claude, pod } = await teamPod();
    await Task.create({
      podId: pod._id, taskNum: 1, taskId: 'TASK-1', title: 'Self-made', createdByUserId: String(claude.bot._id),
    });
    await Task.create({ podId: pod._id, taskNum: 2, taskId: 'TASK-2', title: 'From bob', createdByUserId: String(bob._id) });
    jest.spyOn(require('../../services/decisionRequestService'), 'requestDecision')
      .mockResolvedValue({ decisionId: '0123456789abcdef01234567', messageId: '1' });
    const own = await sendPlan(claude.raw, pod._id, {
      reviewerUserId: String(carol._id), asked: { text: 'Fix it', taskId: 'TASK-1' },
    });
    expect(own.status).toBe(201);
    expect((await repo.findById(own.body.handBack.id)).asked).toMatchObject({
      provenance: 'owner', requesterUserId: String(alice._id),
    });
    const bobs = await sendPlan(claude.raw, pod._id, {
      reviewerUserId: String(carol._id), asked: { text: 'Fix it', taskId: 'TASK-2' },
    });
    expect(bobs.status).toBe(201);
    expect((await repo.findById(bobs.body.handBack.id)).asked).toMatchObject({
      provenance: 'task', requesterUserId: String(bob._id),
    });
  });

  test('a message coalesced into a delivered wake names its own author', async () => {
    const { alice, bob, carol, claude, pod } = await teamPod();
    await delivered(pod._id, '700', alice._id, {
      payload: { messageId: '700', userId: String(alice._id), coalesced: [{ messageId: '701', userId: String(bob._id) }] },
    });
    // bob asked in the coalesced message, so bob can't review; carol can't be refused for that.
    const asBob = await sendPlan(claude.raw, pod._id, {
      reviewerUserId: String(bob._id), asked: { text: 'Fix it', sourceMessageId: '701' },
    });
    expect(asBob.body).toMatchObject({ code: 'reviewer_ineligible', reason: 'is_requester' });
    expect(carol).toBeTruthy();
  });

  test('a message from an agent maps to that agent\'s human owner', async () => {
    const { bob, carol, codex, claude, pod } = await teamPod();
    await delivered(pod._id, '801', codex.bot._id);
    const res = await sendPlan(claude.raw, pod._id, {
      reviewerUserId: String(bob._id), asked: { text: 'Fix it', sourceMessageId: '801' },
    });
    expect(res.body).toMatchObject({ code: 'reviewer_ineligible', reason: 'is_requester' });
    expect(carol).toBeTruthy();
  });

  test('an agent whose owners are both bots or missing is refused owner_unresolved', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const claude = await agent('claude');
    const pod = await Pod.create({
      name: 'No owner', type: 'team', createdBy: alice._id, members: [alice._id, bob._id, claude.bot._id],
    });
    await install('claude', pod, claude.bot._id);
    const res = await sendPlan(claude.raw, pod._id, { reviewerUserId: String(bob._id) });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('owner_unresolved');
  });

  test('agent-only fields and unknown fields are refused; the requester cannot be typed in', async () => {
    const { bob, claude, pod } = await teamPod();
    const res = await sendPlan(claude.raw, pod._id, {
      reviewerUserId: String(bob._id), asked: { text: 'x', requesterUserId: String(bob._id) },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unsupported_fields');
    const extra = await sendPlan(claude.raw, pod._id, { reviewerUserId: String(bob._id), allowedValues: [] });
    expect(extra.body.code).toBe('unsupported_fields');
  });

  test('a non-member cannot read GET /api/pods/:podId/hand-backs; a member can', async () => {
    const { alice, bob, claude, pod } = await teamPod();
    await repo.insertPlan({
      id: crypto.randomUUID(), podId: String(pod._id), threadRootId: null, taskId: null,
      authorAgentUserId: String(claude.bot._id), agentName: 'claude', instanceId: 'default',
      ownerInstalledBy: String(alice._id), ownerUserId: null,
      asked: { text: 'Fix it', requesterUserId: String(alice._id), provenance: 'owner' },
      reviewerUserId: String(bob._id), plan: { text: 'Plan' }, next: null, supersedes: null, now: new Date(),
    });
    const outsider = await person('outsider');
    const refused = await request(app).get(`/api/pods/${pod._id}/hand-backs`)
      .set('Authorization', `Bearer ${tokenFor(outsider)}`);
    expect(refused.status).toBe(404);
    expect(JSON.stringify(refused.body)).not.toContain('Fix it');
    const read = await request(app).get(`/api/pods/${pod._id}/hand-backs`)
      .set('Authorization', `Bearer ${tokenFor(bob)}`);
    expect(read.status).toBe(200);
    expect(read.body.handBacks).toHaveLength(1);
    expect(read.body.handBacks[0]).toMatchObject({
      status: 'plan_sent', asked: { text: 'Fix it', provenance: 'owner' }, reviewerUserId: String(bob._id),
    });
    expect(read.body.people[String(alice._id)]).toBe(alice.username);
  });

  test('withdraw: an owner or the author may; another member may not; a second withdraw is stale', async () => {
    const { alice, bob, claude, codex, pod } = await teamPod();
    const id = crypto.randomUUID();
    await repo.insertPlan({
      id, podId: String(pod._id), threadRootId: null, taskId: null,
      authorAgentUserId: String(claude.bot._id), agentName: 'claude', instanceId: 'default',
      ownerInstalledBy: String(alice._id), ownerUserId: null,
      asked: { text: 'Fix it', requesterUserId: String(alice._id), provenance: 'owner' },
      reviewerUserId: String(bob._id), plan: { text: 'Plan' }, next: null, supersedes: null, now: new Date(),
    });
    const asBob = await request(app).post(`/api/hand-backs/${id}/withdraw`).set('Authorization', `Bearer ${tokenFor(bob)}`);
    expect(asBob.status).toBe(403);
    const asCodex = await request(app).post(`/api/hand-backs/${id}/withdraw`).set('Authorization', `Bearer ${codex.raw}`);
    expect(asCodex.status).toBe(403);
    const asAlice = await request(app).post(`/api/hand-backs/${id}/withdraw`)
      .set('Authorization', `Bearer ${tokenFor(alice)}`).send({ reason: 'Wrong approach' });
    expect(asAlice.status).toBe(200);
    expect(asAlice.body).toEqual({ handBack: { id, status: 'withdrawn' } });
    const again = await request(app).post(`/api/hand-backs/${id}/withdraw`).set('Authorization', `Bearer ${claude.raw}`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('stale_state');
    const stored = await repo.findById(id);
    expect(stored).toMatchObject({ status: 'withdrawn', withdrawnBy: { kind: 'owner', userId: String(alice._id), reason: 'Wrong approach' } });
  });
});
