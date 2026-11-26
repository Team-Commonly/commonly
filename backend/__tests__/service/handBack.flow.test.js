/**
 * ADR-037 §7 (F654), Phase 1 end to end on real Mongo and real PostgreSQL:
 * a pod with two people (alice, bob) and their agents (claude, codex).
 * alice asks claude; claude sends a plan with alice's message as its source,
 * bob as reviewer and codex as next; bob accepts with a reason; claude hands
 * back with a PR link; bob accepts with a reason; codex receives
 * handback.received carrying the five fields.
 *
 * No model, message-store, auth or event-queue mocks: the routes, the
 * decision cards, the hand_backs table (migration 0029, applied by the boot
 * runner in setupPgDb) and the agent inboxes are the real ones.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const DecisionRequest = require('../../models/DecisionRequest');
const AgentEvent = require('../../models/AgentEvent');
const AttentionItem = require('../../models/AttentionItem');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { hash } = require('../../utils/secret');
const {
  setupMongoDb, closeMongoDb, setupPgDb, closePgDb,
} = require('../utils/testUtils');

const describeTier1 = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;

describeTier1('hand-back loop on real Mongo + PostgreSQL (ADR-037 Phase 1)', () => {
  let app;
  let pg;
  let alice;
  let bob;
  let carol;
  let pod;
  let seq = 0;
  const tokens = {};
  const agents = {};
  let handBacks;
  let repo;

  const runCapBefore = process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP;
  beforeAll(async () => {
    // claude posts many cards in a row across these tests; the monologue cap
    // (agentMessageService) is not what is under test here.
    process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP = '0';
    await setupMongoDb();
    pg = await setupPgDb();
    app = express();
    app.use(express.json());
    app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
    app.use('/api/activity', require('../../routes/activity'));
    app.use('/api/pods', require('../../routes/handBacks').podHandBacksRouter);
    app.use('/api/hand-backs', require('../../routes/handBacks'));
    handBacks = require('../../services/handBackService');
    repo = require('../../repositories/handBackRepository');
    handBacks.registerHandBackSubject();

    // codex counts as a cloud runtime, which its owner must be entitled to.
    const human = async (name) => User.create({
      username: `hb-${name}`, email: `hb-${name}@test.com`, password: 'password123', entitlements: { cloudAgents: true },
    });
    alice = await human('alice');
    bob = await human('bob');
    carol = await human('carol');
    for (const [name, owner] of [['claude', alice], ['codex', bob]]) {
      const token = `cm_agent_hand_back_${name}_${'d'.repeat(40)}`;
      agents[name] = await User.create({
        username: `hbagent${name}`, email: `hb-${name}@agents.test.com`, password: 'password123', isBot: true,
        botMetadata: { agentName: name, instanceId: 'default', displayName: name, ownerUserId: String(owner._id) },
        agentRuntimeTokens: [{ tokenHash: hash(token), lastUsedAt: new Date() }],
      });
      tokens[name] = token;
    }
    pod = await Pod.create({
      name: 'Hand-back team', type: 'team', createdBy: alice._id,
      members: [alice._id, bob._id, carol._id, agents.claude._id, agents.codex._id],
    });
    for (const user of [alice, bob, carol, agents.claude, agents.codex]) {
      await pg.query('INSERT INTO users (_id, username) VALUES ($1, $2)', [String(user._id), user.username]);
    }
    await AgentInstallation.create({
      agentName: 'claude', instanceId: 'default', podId: pod._id, installedBy: alice._id, version: '1.0.0', status: 'active',
    });
    await AgentInstallation.create({
      agentName: 'codex', instanceId: 'default', podId: pod._id, installedBy: bob._id, version: '1.0.0', status: 'active',
    });
  });

  afterAll(async () => {
    if (runCapBefore === undefined) delete process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP;
    else process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP = runCapBefore;
    const { pool } = require('../../config/db-pg');
    if (pool) await pool.end();
    await closePgDb();
    await closeMongoDb();
  });

  beforeEach(() => {
    require('../../services/cloudRuntimeOwnership').clearCloudRuntimeCache();
  });

  const jwtFor = (user) => jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET);
  const poll = async (name) => {
    const res = await request(app).get('/api/agents/runtime/events').set('Authorization', `Bearer ${tokens[name]}`);
    if (res.status !== 200) throw new Error(`poll ${name}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.events;
  };
  const eventsOf = async (name, type) => (await poll(name)).filter((event) => event.type === type);
  const choose = (user, decisionId, body) => request(app).post(`/api/activity/decisions/${decisionId}/choose`)
    .set('Authorization', `Bearer ${jwtFor(user)}`).send(body);
  const askedBy = async (user) => {
    seq += 1;
    const messageId = String(90000 + seq);
    await AgentEvent.create({
      agentName: 'claude', instanceId: 'default', podId: pod._id, type: 'chat.mention', status: 'acked',
      payload: { messageId, userId: String(user._id), content: '@claude fix the login flake' },
    });
    return messageId;
  };
  const sendPlan = async (overrides = {}) => {
    const sourceMessageId = await askedBy(alice);
    const res = await request(app).post(`/api/agents/runtime/pods/${pod._id}/hand-backs`)
      .set('Authorization', `Bearer ${tokens.claude}`)
      .send({
        reviewerUserId: String(bob._id),
        asked: { text: 'Fix the flaky login test', sourceMessageId },
        // Each card differs, so the recent-duplicate guard never drops one.
        plan: `Pin the clock in the login spec and retry the network mock once. (${sourceMessageId})`,
        next: { agentName: 'codex' },
        ...overrides,
      });
    if (res.status !== 201) throw new Error(`plan-send: ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  };
  const handBack = (id, body = {}) => request(app).post(`/api/agents/runtime/hand-backs/${id}/hand-back`)
    .set('Authorization', `Bearer ${tokens.claude}`)
    .send({
      changed: [{ kind: 'pr', ref: 'https://github.com/example/app/pull/7', note: 'clock pinned' }],
      checked: [{ what: 'login spec', how: 'ran it 50 times locally, all green' }],
      unverified: [{ what: 'CI on Windows', why: 'no runner here' }],
      ...body,
    });
  const record = async (id) => repo.findById(id);

  test('plan → accept → hand-back → accept, and the next agent receives the five fields', async () => {
    await poll('claude');
    await poll('codex');
    const sent = await sendPlan();
    expect(sent.status).toBe(201);
    const { id, decisionId: planCard, messageId } = sent.body.handBack;
    expect(sent.body.handBack.status).toBe('plan_sent');
    expect(await record(id)).toMatchObject({
      status: 'plan_sent', reviewerUserId: String(bob._id), authorAgentUserId: String(agents.claude._id),
      ownerInstalledBy: String(alice._id), ownerUserId: String(alice._id),
      asked: { text: 'Fix the flaky login test', requesterUserId: String(alice._id), provenance: 'message' },
      next: { agentUserId: String(agents.codex._id), agentName: 'codex', instanceId: 'default' },
    });
    // One message: the card's own source, carrying the hand-back kind, and showing the provenance.
    const { rows: [cardMessage] } = await pg.query('SELECT content, payload FROM messages WHERE id = $1', [Number(messageId)]);
    expect(cardMessage.content).toContain('Requester: @hb-alice, from the message that asked.');
    const card = await DecisionRequest.findById(planCard).lean();
    expect(card).toMatchObject({
      status: 'pending', deciderFallback: 'none', subject: { type: 'hand_back', id, stage: 'plan' },
      deciders: [expect.objectContaining({ userId: bob._id })],
      allowedValues: [{ value: 'Accept', reasonRequired: true }, { value: 'Refuse', reasonRequired: true }],
    });
    // Only bob's Needs-you row: neither alice (requester, owner) nor carol.
    const rows = await AttentionItem.find({ 'source.id': String(planCard) }).lean();
    expect(rows.map((row) => String(row.recipientUserId))).toEqual([String(bob._id)]);

    await choose(bob, planCard, { value: 'Accept', reason: 'Pinning the clock is the right fix' }).expect(200);
    expect((await record(id))).toMatchObject({
      status: 'plan_accepted',
      planRuling: { verdict: 'Accept', reason: 'Pinning the clock is the right fix', byUserId: String(bob._id) },
    });
    const ruled = await eventsOf('claude', 'decision.ruled');
    expect(ruled).toHaveLength(1);
    expect(ruled[0].payload).toMatchObject({
      decisionId: String(planCard), pick: 'Accept', reason: 'Pinning the clock is the right fix',
      handBack: { id, status: 'plan_accepted' },
    });

    const back = await handBack(id);
    expect(back.status).toBe(200);
    const resultCard = back.body.handBack.decisionId;
    expect(back.body.handBack.status).toBe('handed_back');
    // The agent fields are write-once: a second hand-back loses.
    expect((await handBack(id, { changed: [{ kind: 'url', ref: 'https://example.com/other' }] })).body.code)
      .toBe('stale_state');

    await choose(bob, resultCard, { value: 'Accept', reason: 'Green 50 times, Windows gap noted' }).expect(200);
    const done = await record(id);
    expect(done).toMatchObject({
      status: 'accepted',
      changed: [{ kind: 'pr', ref: 'https://github.com/example/app/pull/7', note: 'clock pinned' }],
      handbackRuling: { verdict: 'Accept', reason: 'Green 50 times, Windows gap noted' },
    });
    const received = await eventsOf('codex', 'handback.received');
    expect(received).toHaveLength(1);
    expect(received[0].payload).toMatchObject({
      handBackId: id,
      asked: { text: 'Fix the flaky login test', requesterUserId: String(alice._id), provenance: 'message' },
      plan: { text: expect.stringContaining('Pin the clock in the login spec') },
      changed: [{ kind: 'pr', ref: 'https://github.com/example/app/pull/7', note: 'clock pinned' }],
      checked: [{ what: 'login spec', how: 'ran it 50 times locally, all green' }],
      unverified: [{ what: 'CI on Windows', why: 'no runner here' }],
      acceptedBy: { userId: String(bob._id), reason: 'Green 50 times, Windows gap noted' },
    });
    expect(received[0].payload.content).toContain('CI on Windows');
    // Exactly once, even when a read reconciles again.
    await request(app).get(`/api/agents/runtime/hand-backs/${id}`).set('Authorization', `Bearer ${tokens.codex}`).expect(200);
    await handBacks.sweepHandBacks();
    expect(await AgentEvent.countDocuments({ type: 'handback.received', 'payload.handBackId': id })).toBe(1);
  });

  test('refuse with a reason; a hand-back cannot skip plan_accepted', async () => {
    const sent = await sendPlan();
    const { id, decisionId } = sent.body.handBack;
    expect((await handBack(id)).body.code).toBe('stale_state');
    await choose(bob, decisionId, { value: 'Refuse', reason: 'Fix the race, not the clock' }).expect(200);
    expect(await record(id)).toMatchObject({
      status: 'plan_refused', planRuling: { verdict: 'Refuse', reason: 'Fix the race, not the clock' },
    });
    const refusedBack = await handBack(id);
    expect(refusedBack.status).toBe(409);
    expect(refusedBack.body).toMatchObject({ code: 'stale_state', status: 'plan_refused' });
    // A redo names what it supersedes.
    const redo = await sendPlan({ supersedes: id, plan: 'Find the race in the session refresh.' });
    expect(redo.status).toBe(201);
    expect((await record(redo.body.handBack.id)).supersedes).toBe(id);
  });

  test('the web ruling path refuses a missing reason, a disallowed value and another member', async () => {
    const { decisionId } = (await sendPlan()).body.handBack;
    const noReason = await choose(bob, decisionId, { value: 'Accept' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('reason_required');
    const blank = await choose(bob, decisionId, { value: 'Refuse', reason: '   ' });
    expect(blank.body.code).toBe('reason_required');
    const other = await choose(bob, decisionId, { value: 'Ship it anyway', reason: 'why not' });
    expect(other.status).toBe(400);
    expect(other.body.code).toBe('value_not_allowed');
    const notReviewer = await choose(carol, decisionId, { value: 'Accept', reason: 'looks fine' });
    expect(notReviewer.status).toBe(403);
    expect((await DecisionRequest.findById(decisionId).lean()).status).toBe('pending');
  });

  test('a ruling on a withdrawn card gets 409 and its attention row closes', async () => {
    const { id, decisionId } = (await sendPlan()).body.handBack;
    await request(app).post(`/api/hand-backs/${id}/withdraw`).set('Authorization', `Bearer ${tokens.claude}`)
      .send({ reason: 'Asked the wrong question' }).expect(200);
    expect((await DecisionRequest.findById(decisionId).lean()).status).toBe('closed');
    const ruling = await choose(bob, decisionId, { value: 'Accept', reason: 'ok' });
    expect(ruling.status).toBe(409);
    expect(ruling.body.code).toBe('decision_closed');
    expect(await AttentionItem.countDocuments({ 'source.id': String(decisionId), status: 'open' })).toBe(0);
    expect(await record(id)).toMatchObject({ status: 'withdrawn', withdrawnBy: { kind: 'agent', reason: 'Asked the wrong question' } });
  });

  test('a card whose record moved on is refused subject_stage_mismatch; no check registered fails closed', async () => {
    const { id, decisionId } = (await sendPlan()).body.handBack;
    // The record is withdrawn, but the card's close step "failed": still pending.
    await repo.transition({ id, from: 'plan_sent', to: 'withdrawn', set: { withdrawn_at: new Date() }, now: new Date() });
    const ruling = await choose(bob, decisionId, { value: 'Accept', reason: 'ok' });
    expect(ruling.status).toBe(409);
    expect(ruling.body.code).toBe('subject_stage_mismatch');
    // The sweep re-closes the pending card of a withdrawn record.
    expect(await handBacks.sweepHandBacks()).toMatchObject({ closed: 1 });
    expect((await DecisionRequest.findById(decisionId).lean()).status).toBe('closed');

    const second = (await sendPlan()).body.handBack;
    require('../../services/decisionSubjectRegistry').unregisterDecisionSubject('hand_back');
    try {
      const refused = await choose(bob, second.decisionId, { value: 'Accept', reason: 'ok' });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('subject_check_missing');
    } finally {
      // Re-register through the registry: the service's own guard says it already did.
      require('../../services/decisionSubjectRegistry').registerDecisionSubject('hand_back', {
        checkStage: handBacks.checkStage, onRuled: handBacks.applyRuling,
      });
    }
  });

  test('double hand-back race: exactly one wins, the other gets stale_state', async () => {
    const { id, decisionId } = (await sendPlan()).body.handBack;
    await choose(bob, decisionId, { value: 'Accept', reason: 'go' }).expect(200);
    const results = await Promise.all([handBack(id), handBack(id)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(results.find((res) => res.status === 409).body.code).toBe('stale_state');
    expect(await DecisionRequest.countDocuments({ 'subject.id': id, 'subject.stage': 'result' })).toBe(1);
  });

  test('withdraw vs a refusing ruling: one wins, the loser gets 409, the record stays consistent', async () => {
    const { id, decisionId } = (await sendPlan()).body.handBack;
    const [withdrawn, ruled] = await Promise.all([
      request(app).post(`/api/hand-backs/${id}/withdraw`).set('Authorization', `Bearer ${jwtFor(alice)}`),
      choose(bob, decisionId, { value: 'Refuse', reason: 'not now' }),
    ]);
    const final = await record(id);
    if (withdrawn.status === 200) {
      expect(final.status).toBe('withdrawn');
      // The ruling either lost outright, or finalized on the card without being copied.
      if (ruled.status !== 200) expect(ruled.status).toBe(409);
      expect(final.planRuling).toBeNull();
    } else {
      expect(withdrawn.status).toBe(409);
      // ruling_in_progress: the ruling held the card's lock when the withdraw tried to take it.
      expect(['stale_state', 'ruling_in_progress']).toContain(withdrawn.body.code);
      expect(ruled.status).toBe(200);
      expect(final.status).toBe('plan_refused');
    }
    // A ruling finalized after a withdraw is never copied into the record.
    const card = await DecisionRequest.findById(decisionId).lean();
    if (card.status === 'ruled' && final.status === 'withdrawn') {
      await handBacks.applyRuling(card);
      expect((await record(id)).status).toBe('withdrawn');
    }
  });

  test("with deciderFallback 'none', the plan card waits when its reviewer leaves", async () => {
    const { decisionId } = (await sendPlan()).body.handBack;
    await Pod.updateOne({ _id: pod._id }, { $pull: { members: bob._id } });
    try {
      const refused = await choose(carol, decisionId, { value: 'Accept', reason: 'fine' });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('not_a_decider');
      const { recordDecision } = require('../../services/attentionItemService');
      await recordDecision(await DecisionRequest.findById(decisionId).lean());
      expect(await AttentionItem.countDocuments({ 'source.id': String(decisionId), recipientUserId: carol._id })).toBe(0);
    } finally {
      await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: bob._id } });
    }
  });

  test('a failed copy of a ruling is caught up on the next read', async () => {
    const { id, decisionId } = (await sendPlan()).body.handBack;
    const spy = jest.spyOn(repo, 'transition').mockRejectedValueOnce(new Error('pg blip'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await choose(bob, decisionId, { value: 'Accept', reason: 'go' }).expect(200);
    } finally {
      spy.mockRestore();
    }
    expect((await record(id)).status).toBe('plan_sent');
    const read = await request(app).get(`/api/agents/runtime/hand-backs/${id}`)
      .set('Authorization', `Bearer ${tokens.claude}`).expect(200);
    expect(read.body.handBack).toMatchObject({ id, status: 'plan_accepted', planRuling: { verdict: 'Accept', reason: 'go' } });
  });

  const acceptedHandBack = async () => {
    const { id, decisionId } = (await sendPlan()).body.handBack;
    await choose(bob, decisionId, { value: 'Accept', reason: 'go' }).expect(200);
    const back = await handBack(id);
    return { id, resultCard: back.body.handBack.decisionId };
  };
  const receivedCount = (id) => AgentEvent.countDocuments({ type: 'handback.received', 'payload.handBackId': id });
  const later = () => new Date(Date.now() + 3 * 60 * 1000);

  // Review note 2: a failed enqueue is retried by the sweep, and never doubled.
  test('a failed handback.received enqueue is retried by the sweep, exactly once', async () => {
    const { id, resultCard } = await acceptedHandBack();
    const AgentEventService = require('../../services/agentEventService');
    const original = AgentEventService.enqueue;
    const spy = jest.spyOn(AgentEventService, 'enqueue').mockImplementation((event, ...rest) => (
      event?.type === 'handback.received' ? Promise.reject(new Error('queue down')) : original.call(AgentEventService, event, ...rest)
    ));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await choose(bob, resultCard, { value: 'Accept', reason: 'fine' }).expect(200);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
    expect(await record(id)).toMatchObject({ status: 'accepted', receivedEnqueuedAt: null });
    expect(await receivedCount(id)).toBe(0);
    // Inside the grace window the sweep leaves it to the ruling's writer.
    expect((await handBacks.sweepHandBacks()).delivered).toBe(0);
    expect((await handBacks.sweepHandBacks(later())).delivered).toBe(1);
    expect(await receivedCount(id)).toBe(1);
    expect((await record(id)).receivedEnqueuedAt).toBeInstanceOf(Date);
    expect((await handBacks.sweepHandBacks(later())).delivered).toBe(0);
    // A crash after the enqueue but before the stamp: the sweep stamps, never re-queues.
    await pg.query('UPDATE hand_backs SET received_enqueued_at = NULL WHERE id = $1', [id]);
    expect((await handBacks.sweepHandBacks(later())).delivered).toBe(0);
    expect(await receivedCount(id)).toBe(1);
    expect((await record(id)).receivedEnqueuedAt).toBeInstanceOf(Date);
  });

  test('the ruling that wins stamps handback.received as queued', async () => {
    const { id, resultCard } = await acceptedHandBack();
    await choose(bob, resultCard, { value: 'Accept', reason: 'fine' }).expect(200);
    expect((await record(id)).receivedEnqueuedAt).toBeInstanceOf(Date);
    expect((await handBacks.sweepHandBacks(later())).delivered).toBe(0);
    expect(await receivedCount(id)).toBe(1);
  });

  // Review note 3: closing never takes a card from under a live ruling.
  test('closeDecision leaves a card under a live ruling lock and closes it once the lock expires', async () => {
    const { decisionId } = (await sendPlan()).body.handBack;
    const { closeDecision } = require('../../services/decisionRequestService');
    await DecisionRequest.updateOne({ _id: decisionId }, {
      $set: { rulingLock: { token: 't', expiresAt: new Date(Date.now() + 60_000) } },
    });
    expect(await closeDecision(decisionId)).toBe(false);
    expect((await DecisionRequest.findById(decisionId).lean()).status).toBe('pending');
    await DecisionRequest.updateOne({ _id: decisionId }, { $set: { 'rulingLock.expiresAt': new Date(Date.now() - 1000) } });
    expect(await closeDecision(decisionId)).toBe(true);
    expect((await DecisionRequest.findById(decisionId).lean()).status).toBe('closed');
  });

  // Review note 4: a withdraw that lands while the card is being posted.
  test('a record withdrawn while its plan card posts still learns the card, which is closed', async () => {
    const service = require('../../services/decisionRequestService');
    const original = service.requestDecision;
    const spy = jest.spyOn(service, 'requestDecision').mockImplementation(async (input) => {
      const posted = await original(input);
      await repo.transition({
        id: input.internal.subject.id, from: 'plan_sent', to: 'withdrawn',
        set: { withdrawn_by: { kind: 'owner', userId: String(alice._id) }, withdrawn_at: new Date() }, now: new Date(),
      });
      return posted;
    });
    let res;
    try {
      const sourceMessageId = await askedBy(alice);
      res = await request(app).post(`/api/agents/runtime/pods/${pod._id}/hand-backs`)
        .set('Authorization', `Bearer ${tokens.claude}`)
        .send({ reviewerUserId: String(bob._id), asked: { text: 'Mid-send', sourceMessageId }, plan: `Plan ${sourceMessageId}` });
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(201);
    expect(res.body.handBack).toMatchObject({ status: 'withdrawn', decisionId: expect.any(String) });
    expect(res.body.code).toBeUndefined();
    const { id, decisionId } = res.body.handBack;
    expect((await record(id)).planDecisionId).toBe(decisionId);
    expect((await DecisionRequest.findById(decisionId).lean()).status).toBe('closed');
  });

  test('a result card posted after a withdraw is attached and closed too', async () => {
    const { id, decisionId } = (await sendPlan()).body.handBack;
    await choose(bob, decisionId, { value: 'Accept', reason: 'go' }).expect(200);
    const service = require('../../services/decisionRequestService');
    const original = service.requestDecision;
    const spy = jest.spyOn(service, 'requestDecision').mockImplementation(async (input) => {
      const posted = await original(input);
      await repo.transition({ id, from: 'handed_back', to: 'withdrawn', set: { withdrawn_at: new Date() }, now: new Date() });
      return posted;
    });
    let back;
    try {
      back = await handBack(id);
    } finally {
      spy.mockRestore();
    }
    expect(back.status).toBe(200);
    expect(back.body.handBack.status).toBe('withdrawn');
    expect((await record(id)).handbackDecisionId).toBe(back.body.handBack.decisionId);
    expect((await DecisionRequest.findById(back.body.handBack.decisionId).lean()).status).toBe('closed');
  });

  // Review note 8: a card whose record is older than the newest page.
  test('GET /api/pods/:podId/hand-backs?ids= reads records past the newest 50', async () => {
    const oldest = (await sendPlan()).body.handBack.id;
    for (let i = 0; i < 50; i += 1) {
      await repo.insertPlan({
        id: `filler-${i}-${oldest}`, podId: String(pod._id), threadRootId: null, taskId: null,
        authorAgentUserId: String(agents.claude._id), agentName: 'claude', instanceId: 'default',
        ownerInstalledBy: String(alice._id), ownerUserId: null,
        asked: { text: 'filler', requesterUserId: String(alice._id), provenance: 'owner' },
        reviewerUserId: String(bob._id), plan: { text: 'filler' }, next: null, supersedes: null,
        now: new Date(Date.now() + 1000 + i),
      });
    }
    const page = await request(app).get(`/api/pods/${pod._id}/hand-backs`)
      .set('Authorization', `Bearer ${jwtFor(carol)}`).expect(200);
    expect(page.body.handBacks.map((item) => item.id)).not.toContain(oldest);
    const byId = await request(app).get(`/api/pods/${pod._id}/hand-backs`).query({ ids: oldest })
      .set('Authorization', `Bearer ${jwtFor(carol)}`).expect(200);
    expect(byId.body.handBacks.map((item) => item.id)).toEqual([oldest]);
    expect(byId.body.people[String(alice._id)]).toBe('hb-alice');
    const outsider = await User.create({ username: 'hb-outsider', email: 'hb-outsider@test.com', password: 'password123' });
    await request(app).get(`/api/pods/${pod._id}/hand-backs`).query({ ids: oldest })
      .set('Authorization', `Bearer ${jwtFor(outsider)}`).expect(404);
  });
});
