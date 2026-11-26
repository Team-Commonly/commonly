/**
 * ADR-037 §3 (F654): what happens when one of the two stores fails halfway.
 *
 * A card is posted to Mongo and its id is stored on the PostgreSQL record, so
 * either step can fail on its own. These tests run the real hand-back service,
 * the real decision cards (requestDecision, chooseDecision, closeDecision) on
 * real Mongo, and the shipped hand_backs migration on pg-mem. Only the chat
 * message store is stubbed, since the card's message is not under test.
 *
 * Also covered: the CAP read of one record is gated on DMService.canViewPod,
 * and a withdraw takes the card's ruling lock so it never races a ruling.
 */
jest.mock('../../config/db-pg', () => {
  // eslint-disable-next-line global-require
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  return { pool: new Pool() };
});

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { pool } = require('../../config/db-pg');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentEvent = require('../../models/AgentEvent');
const DecisionRequest = require('../../models/DecisionRequest');
const AttentionItem = require('../../models/AttentionItem');
const { AgentInstallation } = require('../../models/AgentRegistry');
const PGPod = require('../../models/pg/Pod');
const PGMessage = require('../../models/pg/Message');
const AgentMessageService = require('../../services/agentMessageService');
const threadRootResolver = require('../../services/threadRootResolver');
const decisions = require('../../services/decisionRequestService');
const handBacks = require('../../services/handBackService');
const { hash } = require('../../utils/secret');
const repo = require('../../repositories/handBackRepository');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const MIGRATION = fs.readFileSync(path.join(__dirname, '../../config/migrations/0029_hand_backs.sql'), 'utf8');

describe('hand-back recovery, read gate and withdraw lock (ADR-037 §3)', () => {
  let app;
  let seq = 0;
  let messageSeq = 1000;

  beforeAll(async () => {
    await setupMongoDb();
    await pool.query(MIGRATION);
    app = express();
    app.use(express.json());
    app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
    app.use('/api/hand-backs', require('../../routes/handBacks'));
    handBacks.registerHandBackSubject();
  });
  afterAll(async () => { await closeMongoDb(); });

  let postMessage;
  beforeEach(() => {
    // The card's chat message and the ruling's reply: a numeric id is all the
    // decision card needs from the message store.
    postMessage = jest.spyOn(AgentMessageService, 'postMessage').mockImplementation(async () => {
      messageSeq += 1;
      return { success: true, message: { id: String(messageSeq) } };
    });
    jest.spyOn(PGPod, 'findById').mockResolvedValue({ id: 'pg-pod' });
    jest.spyOn(PGMessage, 'create').mockImplementation(async () => { messageSeq += 1; return { id: messageSeq }; });
    jest.spyOn(PGMessage, 'findById').mockImplementation(async (id) => ({ id, content: 'ruling' }));
    jest.spyOn(threadRootResolver, 'resolveThreadRoot').mockResolvedValue(1);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await clearMongoDb();
    await pool.query('DELETE FROM hand_backs');
  });

  const person = async (name) => {
    seq += 1;
    return User.create({ username: `${name}-${seq}`, email: `${name}-${seq}@example.com`, password: 'unused' });
  };
  const agent = async (name) => {
    seq += 1;
    const raw = `cm_agent_${String(seq).padStart(4, '0')}${'e'.repeat(60)}`;
    const bot = await User.create({
      username: `bot${seq}${name}`, email: `bot${seq}${name}@agents.example.com`, password: 'unused', isBot: true,
      botMetadata: { agentName: name, instanceId: 'default' },
      agentRuntimeTokens: [{ tokenHash: hash(raw), label: 'test', createdAt: new Date() }],
    });
    return { bot, raw };
  };
  const install = (name, pod, installedBy) => AgentInstallation.create({
    agentName: name, instanceId: 'default', podId: pod._id, installedBy, version: '1.0.0', status: 'active',
  });

  /** alice owns claude; bob reviews; dave is installed in the pod but not a member of it. */
  const teamPod = async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const claude = await agent('claude');
    const dave = await agent('dave');
    const pod = await Pod.create({
      name: `Team ${seq}`, type: 'team', createdBy: alice._id, members: [alice._id, bob._id, claude.bot._id],
    });
    await install('claude', pod, alice._id);
    await install('dave', pod, alice._id);
    return {
      alice, bob, claude, dave, pod,
    };
  };

  const sendPlanRequest = (team) => request(app)
    .post(`/api/agents/runtime/pods/${team.pod._id}/hand-backs`)
    .set('Authorization', `Bearer ${team.claude.raw}`)
    .send({ reviewerUserId: String(team.bob._id), asked: { text: 'Fix the flaky login test' }, plan: 'Pin the clock.' });
  const sendPlan = async (team) => {
    const res = await sendPlanRequest(team);
    if (res.status !== 201) throw new Error(`plan-send: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.handBack;
  };
  const handBackRequest = (team, id) => request(app)
    .post(`/api/agents/runtime/hand-backs/${id}/hand-back`)
    .set('Authorization', `Bearer ${team.claude.raw}`)
    .send({ changed: [{ kind: 'pr', ref: 'https://example.com/pull/7' }], checked: [], unverified: [] });
  const choose = (team, decisionId, value = 'Accept') => decisions.chooseDecision({
    decisionId: String(decisionId), callerUserId: String(team.bob._id), value, reason: 'Reviewed it',
  });
  const onlyRecord = async () => {
    const { rows } = await pool.query('SELECT id FROM hand_backs');
    expect(rows).toHaveLength(1);
    return repo.findById(rows[0].id);
  };
  const acceptedPlan = async (team) => {
    const { id, decisionId } = await sendPlan(team);
    expect((await choose(team, decisionId)).status).toBe(200);
    return id;
  };
  // Past the card-post grace window.
  const later = () => new Date(Date.now() + 10 * 60 * 1000);
  const asAgent = (team) => ({ kind: 'agent', agentUserId: String(team.claude.bot._id), authorizedPod: () => true });

  describe('GET /hand-backs/:id is gated on canViewPod', () => {
    test('an agent whose token covers the pod but who cannot view it gets 404, and nothing is reconciled', async () => {
      const team = await teamPod();
      const { id, decisionId } = await sendPlan(team);
      // A ruled card the record has not caught up with yet: any read that
      // reaches reconcile would move the record to plan_accepted.
      await DecisionRequest.updateOne({ _id: decisionId }, {
        $set: { status: 'ruled', ruling: { value: 'Accept', reason: 'ok', byUserId: team.bob._id, at: new Date() } },
      });
      const denied = await request(app).get(`/api/agents/runtime/hand-backs/${id}`)
        .set('Authorization', `Bearer ${team.dave.raw}`);
      expect(denied.status).toBe(404);
      expect(denied.body.code).toBe('hand_back_not_found');
      expect(JSON.stringify(denied.body)).not.toContain('Pin the clock');
      expect((await repo.findById(id)).status).toBe('plan_sent');

      const read = await request(app).get(`/api/agents/runtime/hand-backs/${id}`)
        .set('Authorization', `Bearer ${team.claude.raw}`);
      expect(read.status).toBe(200);
      expect(read.body.handBack).toMatchObject({ id, status: 'plan_accepted' });
    });
  });

  describe('a card posted whose PostgreSQL attach failed', () => {
    test('plan stage: recovery attaches the same card, which can then be ruled; no second card', async () => {
      const team = await teamPod();
      jest.spyOn(repo, 'attachPlanDecision').mockRejectedValueOnce(new Error('pg blip'));
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const failed = await sendPlanRequest(team);
      expect(failed.status).toBe(500);
      const stranded = await onlyRecord();
      expect(stranded).toMatchObject({ status: 'plan_sent', planDecisionId: null });
      const [card] = await DecisionRequest.find({}).lean();
      expect(card.subject).toEqual({ type: 'hand_back', id: stranded.id, stage: 'plan' });

      await handBacks.sweepHandBacks();
      expect((await repo.findById(stranded.id)).planDecisionId).toBe(String(card._id));
      expect((await choose(team, card._id)).status).toBe(200);
      expect((await repo.findById(stranded.id)).status).toBe('plan_accepted');
      expect(await DecisionRequest.countDocuments()).toBe(1);
    });

    test('result stage: a read attaches the same card, which can then be ruled; no second card', async () => {
      const team = await teamPod();
      const id = await acceptedPlan(team);
      jest.spyOn(repo, 'attachHandbackDecision').mockRejectedValueOnce(new Error('pg blip'));
      jest.spyOn(console, 'error').mockImplementation(() => {});
      expect((await handBackRequest(team, id)).status).toBe(500);
      expect(await repo.findById(id)).toMatchObject({ status: 'handed_back', handbackDecisionId: null });

      const read = await request(app).get(`/api/agents/runtime/hand-backs/${id}`)
        .set('Authorization', `Bearer ${team.claude.raw}`);
      const resultCard = await DecisionRequest.findOne({ 'subject.stage': 'result' }).lean();
      expect(read.body.handBack).toMatchObject({ status: 'handed_back', handbackDecisionId: String(resultCard._id) });
      expect((await choose(team, resultCard._id)).status).toBe(200);
      expect((await repo.findById(id)).status).toBe('accepted');
      expect(await DecisionRequest.countDocuments({ 'subject.stage': 'result' })).toBe(1);
    });

    test('when recovery attached the card first, the poster still answers success', async () => {
      const team = await teamPod();
      const original = decisions.requestDecision;
      jest.spyOn(decisions, 'requestDecision').mockImplementation(async (input) => {
        const posted = await original(input);
        await handBacks.reconcile(await repo.findById(input.internal.subject.id));
        return posted;
      });
      const attach = jest.spyOn(repo, 'attachPlanDecision');
      const res = await sendPlanRequest(team);
      expect(res.status).toBe(201);
      // Recovery attached it; the poster's own attach then found it taken.
      expect(attach).toHaveBeenCalledTimes(2);
      await expect(attach.mock.results[1].value).resolves.toBeNull();
      expect(res.body.handBack).toMatchObject({ status: 'plan_sent' });
      const card = await DecisionRequest.findById(res.body.handBack.decisionId).lean();
      expect(card.status).toBe('pending');
      expect((await repo.findById(res.body.handBack.id)).planDecisionId).toBe(String(card._id));
    });
  });

  describe('a card post that failed and whose undo failed too', () => {
    test('result stage: inside the grace window the sweep waits; after it, plan_accepted is restored and a fresh hand-back works', async () => {
      const team = await teamPod();
      const id = await acceptedPlan(team);
      postMessage.mockResolvedValueOnce({ success: false });
      const original = repo.transition;
      jest.spyOn(repo, 'transition').mockImplementation(async (input) => {
        if (input.from === 'handed_back' && input.to === 'plan_accepted') throw new Error('pg blip');
        return original(input);
      });
      expect((await handBackRequest(team, id)).status).toBe(503);
      repo.transition.mockRestore();
      expect(await repo.findById(id)).toMatchObject({ status: 'handed_back', handbackDecisionId: null });

      await handBacks.sweepHandBacks(new Date());
      expect((await repo.findById(id)).status).toBe('handed_back');
      // The agent retrying inside the window still hears stale_state.
      expect((await handBackRequest(team, id)).body.code).toBe('stale_state');

      await handBacks.sweepHandBacks(later());
      expect(await repo.findById(id)).toMatchObject({
        status: 'plan_accepted', changed: null, checked: null, unverified: null, handedBackAt: null,
      });
      const again = await handBackRequest(team, id);
      expect(again.status).toBe(200);
      expect(again.body.handBack.status).toBe('handed_back');
      expect(await DecisionRequest.countDocuments({ 'subject.stage': 'result' })).toBe(1);
    });

    test('plan stage: inside the grace window the sweep waits; after it, the card-less record is removed', async () => {
      const team = await teamPod();
      postMessage.mockResolvedValueOnce({ success: false });
      jest.spyOn(repo, 'deleteUnposted').mockRejectedValueOnce(new Error('pg blip'));
      expect((await sendPlanRequest(team)).status).toBe(503);
      const stranded = await onlyRecord();
      expect(stranded).toMatchObject({ status: 'plan_sent', planDecisionId: null });

      await handBacks.sweepHandBacks(new Date());
      expect(await repo.findById(stranded.id)).not.toBeNull();
      await handBacks.sweepHandBacks(later());
      expect(await repo.findById(stranded.id)).toBeNull();
      expect(await DecisionRequest.countDocuments()).toBe(0);
    });

    test('a card that lands after its record moved on is closed, not left pending', async () => {
      const team = await teamPod();
      const id = await acceptedPlan(team);
      const original = decisions.requestDecision;
      jest.spyOn(decisions, 'requestDecision').mockImplementation(async (input) => {
        const posted = await original(input);
        // The sweep gave up on this post and put the record back meanwhile.
        await repo.transition({
          id, from: 'handed_back', to: 'plan_accepted',
          set: { changed: null, checked: null, unverified: null, handed_back_at: null }, now: new Date(),
        });
        return posted;
      });
      const res = await handBackRequest(team, id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('stale_state');
      const card = await DecisionRequest.findOne({ 'subject.stage': 'result' }).lean();
      expect(card.status).toBe('closed');
      expect(await repo.findById(id)).toMatchObject({ status: 'plan_accepted', handbackDecisionId: null });
    });

    test('a plan card that lands after its record was removed is closed', async () => {
      const team = await teamPod();
      const original = decisions.requestDecision;
      jest.spyOn(decisions, 'requestDecision').mockImplementation(async (input) => {
        const posted = await original(input);
        await pool.query('DELETE FROM hand_backs WHERE id = $1', [input.internal.subject.id]);
        return posted;
      });
      const res = await sendPlanRequest(team);
      expect(res.status).toBe(409);
      expect((await DecisionRequest.findOne({}).lean()).status).toBe('closed');
    });
  });

  describe('withdraw takes the ruling lock', () => {
    test('a ruling holding the lock: withdraw answers ruling_in_progress and changes nothing', async () => {
      const team = await teamPod();
      const { id, decisionId } = await sendPlan(team);
      const lock = { token: 'ruling-token', expiresAt: new Date(Date.now() + 60_000) };
      await DecisionRequest.updateOne({ _id: decisionId }, { $set: { rulingLock: lock } });
      const res = await request(app).post(`/api/hand-backs/${id}/withdraw`).set('Authorization', `Bearer ${team.claude.raw}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ruling_in_progress');
      expect((await repo.findById(id)).status).toBe('plan_sent');
      const card = await DecisionRequest.findById(decisionId).lean();
      expect(card).toMatchObject({ status: 'pending', rulingLock: { token: 'ruling-token' } });
    });

    test('withdraw holding the lock: a ruling gets 409, then decision_closed; the record is withdrawn', async () => {
      const team = await teamPod();
      const { id, decisionId } = await sendPlan(team);
      const original = repo.transition;
      let during;
      jest.spyOn(repo, 'transition').mockImplementation(async (input) => {
        if (input.to === 'withdrawn') during = await choose(team, decisionId);
        return original(input);
      });
      await expect(handBacks.withdraw({ id, caller: asAgent(team) })).resolves.toEqual({ handBack: { id, status: 'withdrawn' } });
      expect(during.status).toBe(409);
      expect(during.body.error).toMatch(/being ruled/);
      const after = await choose(team, decisionId);
      expect(after.status).toBe(409);
      expect(after.body.code).toBe('decision_closed');
      expect((await repo.findById(id)).status).toBe('withdrawn');
      const card = await DecisionRequest.findById(decisionId).lean();
      expect(card.status).toBe('closed');
      expect(card.rulingLock?.token).toBeUndefined();
    });

    test('a withdraw whose PostgreSQL move fails releases the lock; the card stays rulable', async () => {
      const team = await teamPod();
      const { id, decisionId } = await sendPlan(team);
      const original = repo.transition;
      jest.spyOn(repo, 'transition').mockImplementation(async (input) => {
        if (input.to === 'withdrawn') throw new Error('pg blip');
        return original(input);
      });
      await expect(handBacks.withdraw({ id, caller: asAgent(team) })).rejects.toThrow('pg blip');
      repo.transition.mockRestore();
      const card = await DecisionRequest.findById(decisionId).lean();
      expect(card.status).toBe('pending');
      expect(card.rulingLock?.token).toBeUndefined();
      expect((await choose(team, decisionId)).status).toBe(200);
      expect((await repo.findById(id)).status).toBe('plan_accepted');
    });

    test('a withdraw that loses the record to a ruling releases the lock and answers stale_state', async () => {
      const team = await teamPod();
      const { id, decisionId } = await sendPlan(team);
      const original = repo.transition;
      jest.spyOn(repo, 'transition').mockImplementation(async (input) => (
        input.to === 'withdrawn' ? null : original(input)
      ));
      await expect(handBacks.withdraw({ id, caller: asAgent(team) })).rejects.toMatchObject({ code: 'stale_state' });
      const card = await DecisionRequest.findById(decisionId).lean();
      expect(card.status).toBe('pending');
      expect(card.rulingLock?.token).toBeUndefined();
      expect(await AgentEvent.countDocuments({ type: 'decision.ruled' })).toBe(0);
    });
  });
  describe('card text, cleanup reporting and the handback.received claim', () => {
    test('a full-length ask still leaves room for the requester line on the card', async () => {
      const team = await teamPod();
      const res = await request(app).post(`/api/agents/runtime/pods/${team.pod._id}/hand-backs`)
        .set('Authorization', `Bearer ${team.claude.raw}`)
        .send({ reviewerUserId: String(team.bob._id), asked: { text: 'x'.repeat(2000) }, plan: 'Pin the clock.' });
      expect(res.status).toBe(201);
      const card = await DecisionRequest.findById(res.body.handBack.decisionId).lean();
      expect(card.context.length).toBeLessThanOrEqual(2000);
      expect(card.context).toContain("Requester: the agent's owner");
      // The record keeps the whole ask.
      expect((await repo.findById(res.body.handBack.id)).asked.text).toHaveLength(2000);
    });

    test('a card posted after a withdraw whose close failed is not reported as closed', async () => {
      const team = await teamPod();
      const original = decisions.requestDecision;
      jest.spyOn(decisions, 'requestDecision').mockImplementation(async (input) => {
        const posted = await original(input);
        await repo.transition({
          id: input.internal.subject.id, from: 'plan_sent', to: 'withdrawn', set: { withdrawn_at: new Date() }, now: new Date(),
        });
        return posted;
      });
      jest.spyOn(decisions, 'closeDecision').mockRejectedValueOnce(new Error('mongo blip'));
      const res = await sendPlanRequest(team);
      expect(res.status).toBe(201);
      expect(res.body.handBack).toMatchObject({ status: 'withdrawn', cardClosed: false });
      expect(res.body.handBack.note).not.toMatch(/has been closed/);
      expect((await DecisionRequest.findById(res.body.handBack.decisionId).lean()).status).toBe('pending');
    });

    test("the sweep resolves a withdrawn card's attention row left open by a failed resolve", async () => {
      const team = await teamPod();
      const { id, decisionId } = await sendPlan(team);
      expect(await AttentionItem.countDocuments({ 'source.id': String(decisionId), status: 'open' })).toBe(1);
      jest.spyOn(AttentionItem, 'updateMany').mockRejectedValueOnce(new Error('mongo blip'));
      await handBacks.withdraw({ id, caller: asAgent(team) });
      expect((await DecisionRequest.findById(decisionId).lean()).status).toBe('closed');
      expect(await AttentionItem.countDocuments({ 'source.id': String(decisionId), status: 'open' })).toBe(1);
      await handBacks.sweepHandBacks();
      expect(await AttentionItem.countDocuments({ 'source.id': String(decisionId), status: 'open' })).toBe(0);
    });

    // A degraded path fails toward a second delivery, never toward none.
    const acceptedWithNext = async (team) => {
      seq += 1;
      await User.create({
        username: `bot${seq}codex`, email: `bot${seq}codex@agents.example.com`, password: 'unused', isBot: true,
        botMetadata: { agentName: 'codex', instanceId: 'default' },
      });
      await install('codex', team.pod, team.alice._id);
      const sent = await request(app).post(`/api/agents/runtime/pods/${team.pod._id}/hand-backs`)
        .set('Authorization', `Bearer ${team.claude.raw}`)
        .send({
          reviewerUserId: String(team.bob._id), asked: { text: 'Fix it' }, plan: 'Pin the clock.', next: { agentName: 'codex' },
        });
      expect(sent.status).toBe(201);
      const { id, decisionId } = sent.body.handBack;
      expect((await choose(team, decisionId)).status).toBe(200);
      const back = await handBackRequest(team, id);
      expect(back.status).toBe(200);
      return { id, resultCard: back.body.handBack.decisionId };
    };
    const received = (id) => AgentEvent.countDocuments({ type: 'handback.received', 'payload.handBackId': id });
    const failReceivedOnce = () => {
      const AgentEventService = require('../../services/agentEventService');
      const enqueue = AgentEventService.enqueue;
      let failed = false;
      return jest.spyOn(AgentEventService, 'enqueue').mockImplementation((event, ...rest) => {
        if (event?.type === 'handback.received' && !failed) {
          failed = true;
          return Promise.reject(new Error('queue down'));
        }
        return enqueue.call(AgentEventService, event, ...rest);
      });
    };

    test('a failed enqueue leaves the record unstamped, and the next sweep delivers', async () => {
      const team = await teamPod();
      const { id, resultCard } = await acceptedWithNext(team);
      failReceivedOnce();
      expect((await choose(team, resultCard)).status).toBe(200);
      expect(await repo.findById(id)).toMatchObject({ status: 'accepted', receivedEnqueuedAt: null });
      expect(await received(id)).toBe(0);
      expect((await handBacks.sweepHandBacks(later())).delivered).toBe(1);
      expect(await received(id)).toBe(1);
      expect((await repo.findById(id)).receivedEnqueuedAt).toBeInstanceOf(Date);
    });

    test('a failed lookup for an event already queued stamps nothing, and the next sweep delivers', async () => {
      const team = await teamPod();
      const { id, resultCard } = await acceptedWithNext(team);
      failReceivedOnce();
      expect((await choose(team, resultCard)).status).toBe(200);
      jest.spyOn(AgentEvent, 'exists').mockRejectedValueOnce(new Error('mongo blip'));
      await handBacks.sweepHandBacks(later());
      expect(await repo.findById(id)).toMatchObject({ receivedEnqueuedAt: null });
      expect(await received(id)).toBe(0);
      expect((await handBacks.sweepHandBacks(later())).delivered).toBe(1);
      expect(await received(id)).toBe(1);
    });

    test('a crash after the enqueue and before the stamp is caught up by the next sweep, never lost', async () => {
      const team = await teamPod();
      const { id, resultCard } = await acceptedWithNext(team);
      jest.spyOn(repo, 'markReceivedEnqueued').mockRejectedValueOnce(new Error('pg blip'));
      expect((await choose(team, resultCard)).status).toBe(200);
      expect(await received(id)).toBe(1);
      expect((await repo.findById(id)).receivedEnqueuedAt).toBeNull();
      await handBacks.sweepHandBacks(later());
      // At least once: the sweep found the queued event and stamped it.
      expect(await received(id)).toBeGreaterThanOrEqual(1);
      expect((await repo.findById(id)).receivedEnqueuedAt).toBeInstanceOf(Date);
    });

    test('two overlapping sweeps deliver at least once; a second copy is the accepted cost', async () => {
      const team = await teamPod();
      const { id, resultCard } = await acceptedWithNext(team);
      failReceivedOnce();
      expect((await choose(team, resultCard)).status).toBe(200);
      await Promise.all([handBacks.sweepHandBacks(later()), handBacks.sweepHandBacks(later())]);
      expect(await received(id)).toBeGreaterThanOrEqual(1);
      expect((await repo.findById(id)).receivedEnqueuedAt).toBeInstanceOf(Date);
    });
  });

  describe('result attempts, orphan cards and the withdraw card link', () => {
    const resultFields = (at) => ({
      changed: [{ kind: 'url', ref: 'https://example.com/b' }], checked: [], unverified: [], handed_back_at: at,
    });

    test("attempt A's late card does not attach to attempt B, and is closed", async () => {
      const team = await teamPod();
      const id = await acceptedPlan(team);
      let attemptB;
      const original = decisions.requestDecision;
      jest.spyOn(decisions, 'requestDecision').mockImplementation(async (input) => {
        const posted = await original(input);
        // Recovery gave up on attempt A and put the record back...
        await repo.transition({
          id, from: 'handed_back', to: 'plan_accepted',
          set: { changed: null, checked: null, unverified: null, handed_back_at: null }, now: new Date(),
        });
        // ...and the agent submitted attempt B, whose card is still posting.
        attemptB = new Date(Date.now() + 1000);
        await repo.transition({ id, from: 'plan_accepted', to: 'handed_back', set: resultFields(attemptB), now: new Date() });
        return posted;
      });
      const res = await handBackRequest(team, id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('stale_state');
      const cardA = await DecisionRequest.findOne({ 'subject.stage': 'result' }).lean();
      expect(cardA.status).toBe('closed');
      const after = await repo.findById(id);
      expect(after).toMatchObject({
        status: 'handed_back', handbackDecisionId: null, changed: [{ kind: 'url', ref: 'https://example.com/b' }],
      });
      expect(after.handedBackAt.getTime()).toBe(attemptB.getTime());
    });

    test("a second reconcile of attempt A cannot clear attempt B's fields", async () => {
      const team = await teamPod();
      const id = await acceptedPlan(team);
      postMessage.mockResolvedValueOnce({ success: false });
      const original = repo.transition;
      jest.spyOn(repo, 'transition').mockImplementation(async (input) => {
        if (input.from === 'handed_back' && input.to === 'plan_accepted') throw new Error('pg blip');
        return original(input);
      });
      expect((await handBackRequest(team, id)).status).toBe(503);
      repo.transition.mockRestore();
      const staleA = await repo.findById(id);
      expect(staleA).toMatchObject({ status: 'handed_back', handbackDecisionId: null });

      await handBacks.reconcile(staleA, undefined, later());
      expect((await repo.findById(id)).status).toBe('plan_accepted');
      // Attempt B goes in, its card still posting.
      await repo.transition({
        id, from: 'plan_accepted', to: 'handed_back', set: resultFields(new Date(Date.now() + 1000)), now: new Date(),
      });
      // A reconcile still holding A's snapshot runs its reset again.
      await handBacks.reconcile(staleA, undefined, later());
      expect(await repo.findById(id)).toMatchObject({
        status: 'handed_back', changed: [{ kind: 'url', ref: 'https://example.com/b' }],
      });
    });

    test('a late card whose close failed is closed by the next sweep', async () => {
      const team = await teamPod();
      const original = decisions.requestDecision;
      jest.spyOn(decisions, 'requestDecision').mockImplementation(async (input) => {
        const posted = await original(input);
        await pool.query('DELETE FROM hand_backs WHERE id = $1', [input.internal.subject.id]);
        return posted;
      });
      jest.spyOn(decisions, 'closeDecision').mockRejectedValueOnce(new Error('mongo blip'));
      expect((await sendPlanRequest(team)).status).toBe(409);
      decisions.requestDecision.mockRestore();
      const orphan = await DecisionRequest.findOne({}).lean();
      expect(orphan.status).toBe('pending');
      // Inside the grace window the sweep leaves it.
      await handBacks.sweepHandBacks(new Date());
      expect((await DecisionRequest.findById(orphan._id).lean()).status).toBe('pending');
      const result = await handBacks.sweepHandBacks(later());
      expect(result.orphansClosed).toBe(1);
      expect((await DecisionRequest.findById(orphan._id).lean()).status).toBe('closed');
    });

    test('the orphan sweep leaves cards their records still wait on', async () => {
      const team = await teamPod();
      const { id, decisionId } = await sendPlan(team);
      const resultId = await acceptedPlan(team);
      const back = await handBackRequest(team, resultId);
      expect(back.status).toBe(200);
      const result = await handBacks.sweepHandBacks(later());
      expect(result.orphansClosed).toBe(0);
      expect((await DecisionRequest.findById(decisionId).lean()).status).toBe('pending');
      expect((await DecisionRequest.findById(back.body.handBack.decisionId).lean()).status).toBe('pending');
      expect((await repo.findById(id)).status).toBe('plan_sent');
    });

    test('a card that attaches between the read and the update sends the withdraw back through the lock', async () => {
      const team = await teamPod();
      const id = '00000000-0000-4000-8000-00000000c001';
      await repo.insertPlan({
        id, podId: String(team.pod._id), threadRootId: null, taskId: null,
        authorAgentUserId: String(team.claude.bot._id), agentName: 'claude', instanceId: 'default',
        ownerInstalledBy: String(team.alice._id), ownerUserId: null,
        asked: { text: 'Fix it', requesterUserId: String(team.alice._id), provenance: 'owner' },
        reviewerUserId: String(team.bob._id), plan: { text: 'Plan' }, next: null, supersedes: null, now: new Date(),
      });
      const original = repo.transition;
      let withdrawCalls = 0;
      let cardId;
      jest.spyOn(repo, 'transition').mockImplementation(async (input) => {
        if (input.to === 'withdrawn') {
          withdrawCalls += 1;
          if (withdrawCalls === 1) {
            const card = await decisions.requestDecision({
              podId: String(team.pod._id), agentUserId: String(team.claude.bot._id), agentName: 'claude',
              decisionClass: 'implementation', title: 'Plan for review', question: 'Plan',
              options: [{ label: 'Accept' }, { label: 'Refuse' }], deciderUserIds: [String(team.bob._id)],
              internal: { subject: { type: 'hand_back', id, stage: 'plan' } },
            });
            cardId = card.decisionId;
            await repo.attachPlanDecision(id, cardId, new Date());
          }
        }
        return original(input);
      });
      await expect(handBacks.withdraw({ id, caller: asAgent(team) })).resolves.toEqual({ handBack: { id, status: 'withdrawn' } });
      expect(withdrawCalls).toBe(2);
      expect((await repo.findById(id)).status).toBe('withdrawn');
      expect((await DecisionRequest.findById(cardId).lean()).status).toBe('closed');
    });
  });
});
