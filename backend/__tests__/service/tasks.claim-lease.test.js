/**
 * ADR-018 D4 — task claims are leases, never permanent.
 *
 * Before this, `claimedBy` had no deadline: a dead claimant held the task
 * forever, invisibly — the exact bug message claims were built to avoid.
 * The contract under test:
 *  - a fresh claim stamps claimExpiresAt (~30 min out)
 *  - a live lease refuses a second claimant with the holder AND the expiry
 *  - the holder re-claiming wins against itself (renewal, fresh lease)
 *  - a lapsed lease is claimable by a peer
 *  - a LEGACY claim (claimExpiresAt null) derives its effective expiry from
 *    claimedAt: recent → refused, stale → claimable. No migration needed.
 */

process.env.PG_HOST = '';
process.env.JWT_SECRET = 'tasks-claim-lease-test-secret';

// Partial mock so the renewal-gating tests below can assert WHO gets woken.
// Everything else is the real module: emitTaskUpdated stays a socket no-op in
// tests, and notifyPodAgents becomes observable without changing behavior.
jest.mock('../../services/taskEventService', () => {
  const actual = jest.requireActual('../../services/taskEventService');
  return { ...actual, notifyPodAgents: jest.fn().mockResolvedValue(undefined) };
});
jest.mock('../../services/systemActionLineService', () => ({
  emitSystemActionLine: jest.fn().mockResolvedValue(undefined),
}));

const express = require('express');
const request = require('supertest');
const { notifyPodAgents } = require('../../services/taskEventService');
const { emitSystemActionLine } = require('../../services/systemActionLineService');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const User = require('../../models/User');
const { AgentInstallation } = require('../../models/AgentRegistry');
const KernelWorkSweepService = require('../../services/kernelWorkSweepService').default;
const tasksApiRoutes = require('../../routes/tasksApi');
const { hash } = require('../../utils/secret');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
  generateTestToken,
} = require('../utils/testUtils');

const LEASE_MS = 30 * 60 * 1000;
const AGENT_TOKEN = 'cm_agent_task_claim_audit';

describe('POST /api/v1/tasks/:podId/:taskId/claim — lease semantics (ADR-018 D4)', () => {
  let app;
  let owner;
  let rival;
  let agent;
  let pod;
  let ownerToken;
  let rivalToken;

  beforeAll(async () => {
    await setupMongoDb();
    await Task.init();
    app = express();
    app.use(express.json());
    app.use('/api/v1/tasks', tasksApiRoutes);
  });

  beforeEach(async () => {
    await clearMongoDb();
    emitSystemActionLine.mockClear();
    owner = await User.create({
      username: `lease-owner-${Date.now()}`,
      email: `lease-owner-${Date.now()}@test.com`,
      password: 'Password123!',
      verified: true,
    });
    rival = await User.create({
      username: `lease-rival-${Date.now()}`,
      email: `lease-rival-${Date.now()}@test.com`,
      password: 'Password123!',
      verified: true,
    });
    agent = await User.create({
      username: 'claim-audit-agent',
      email: `claim-audit-agent-${Date.now()}@agents.commonly.local`,
      password: 'Password123!',
      verified: true,
      isBot: true,
      botType: 'agent',
      botMetadata: { agentName: 'claim-audit-agent', instanceId: 'default', displayName: 'Audit Agent' },
      agentRuntimeTokens: [{
        tokenHash: hash(AGENT_TOKEN),
        label: 'task-claim-audit',
        createdAt: new Date(),
      }],
    });
    pod = await Pod.create({
      name: 'Claim lease pod',
      type: 'team',
      createdBy: owner._id,
      members: [owner._id, rival._id, agent._id],
    });
    await AgentInstallation.create({
      agentName: 'claim-audit-agent', instanceId: 'default', podId: pod._id,
      version: '1.0.0', installedBy: owner._id,
    });
    ownerToken = generateTestToken(owner._id);
    rivalToken = generateTestToken(rival._id);
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  const seedTask = (overrides = {}) => Task.create({
    podId: pod._id,
    taskNum: 1,
    taskId: 'T-1',
    title: 'the contended task',
    status: 'pending',
    ...overrides,
  });

  const claim = (token) => request(app)
    .post(`/api/v1/tasks/${pod._id}/T-1/claim`)
    .set('Authorization', `Bearer ${token}`)
    .send({});

  test('a runtime agent claim names the agent in the audit log while retaining its stable lease key', async () => {
    await seedTask();
    const res = await claim(AGENT_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.task.claimedBy).toBe(agent._id.toString());
    expect(res.body.task.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: 'Claimed by claim-audit-agent',
        author: 'claim-audit-agent',
        authorId: agent._id.toString(),
      }),
    ]));
    expect(emitSystemActionLine).toHaveBeenCalledWith(expect.objectContaining({
      actorName: 'Audit Agent',
      actorUsername: 'claim-audit-agent',
      actorIsBot: true,
    }));
  });

  test('a fresh claim stamps a lease ~30 minutes out', async () => {
    await seedTask();
    const before = Date.now();
    const res = await claim(ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('claimed');
    const expires = new Date(res.body.task.claimExpiresAt).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + LEASE_MS - 5000);
    expect(expires).toBeLessThanOrEqual(Date.now() + LEASE_MS + 5000);
    expect(emitSystemActionLine).toHaveBeenCalledWith({
      podId: pod._id.toString(),
      actorUserId: owner._id.toString(),
      actorName: owner.username,
      actorUsername: owner.username,
      actorAvatarUrl: null,
      actorIsBot: false,
      action: 'task-claimed',
      taskId: 'T-1',
    });
  });

  test('a live lease refuses a rival, naming the holder and when the lease frees', async () => {
    await seedTask();
    await claim(ownerToken);
    const res = await claim(rivalToken);
    expect(res.status).toBe(409);
    expect(res.body.claimedBy).toBe(owner._id.toString());
    expect(res.body.claimExpiresAt).toBeTruthy();
  });

  test('the holder re-claiming wins against itself and gets a fresh lease (renewal)', async () => {
    await seedTask();
    const first = await claim(ownerToken);
    const firstExpiry = new Date(first.body.task.claimExpiresAt).getTime();
    await new Promise((r) => { setTimeout(r, 25); });
    const renewed = await claim(ownerToken);
    expect(renewed.status).toBe(200);
    expect(new Date(renewed.body.task.claimExpiresAt).getTime()).toBeGreaterThan(firstExpiry);
    expect(emitSystemActionLine).toHaveBeenCalledTimes(1);
  });

  test('a lapsed lease is claimable by a peer — dead claimants never hold work forever', async () => {
    await seedTask({
      status: 'claimed',
      claimedBy: 'ghost-agent',
      claimedAt: new Date(Date.now() - 2 * LEASE_MS),
      claimExpiresAt: new Date(Date.now() - LEASE_MS),
    });
    const res = await claim(rivalToken);
    expect(res.status).toBe(200);
    expect(res.body.task.claimedBy).toBe(rival._id.toString());
    expect(emitSystemActionLine).toHaveBeenCalledTimes(1);
  });

  test('a RECENT legacy claim (no lease field) is still protected', async () => {
    await seedTask({
      status: 'claimed',
      claimedBy: 'legacy-agent',
      claimedAt: new Date(Date.now() - 60 * 1000),
      claimExpiresAt: null,
    });
    const res = await claim(rivalToken);
    expect(res.status).toBe(409);
    expect(res.body.claimedBy).toBe('legacy-agent');
  });

  test('a STALE legacy claim derives its expiry from claimedAt and becomes claimable', async () => {
    await seedTask({
      status: 'claimed',
      claimedBy: 'legacy-ghost',
      claimedAt: new Date(Date.now() - 2 * LEASE_MS),
      claimExpiresAt: null,
    });
    const res = await claim(rivalToken);
    expect(res.status).toBe(200);
    expect(res.body.task.claimedBy).toBe(rival._id.toString());
    expect(res.body.task.claimExpiresAt).toBeTruthy();
  });

  // Every test above drives the CAS directly, which is why the suite could go
  // green while a lapsed task was unreachable: "claimable by a peer" was only
  // ever asserted against the predicate, never against what a peer can FIND.
  // ADR-018 declined a reaper, so discovery is the whole recovery path —
  // these reach the task the way an agent actually would.
  describe('discovery — a peer must be able to FIND the work the CAS would grant', () => {
    const list = (token, query = '') => request(app)
      .get(`/api/v1/tasks/${pod._id}${query}`)
      .set('Authorization', `Bearer ${token}`);

    const lapsed = () => seedTask({
      status: 'claimed',
      claimedBy: 'ghost-agent',
      claimedAt: new Date(Date.now() - 2 * LEASE_MS),
      claimExpiresAt: new Date(Date.now() - LEASE_MS),
    });

    // EVERY test here seeds this too. Without it they pass against the unfixed
    // route: an unknown query param is ignored, so `?claimable=true` returns
    // the whole board — which of course contains the lapsed task. Asserting
    // "the lapsed one is present" therefore proves nothing. The control is a
    // task that must be ABSENT, so an ignored filter fails loudly. Found by
    // running these against origin/main before opening the PR; three of five
    // were green there, which is the same defect this PR exists to fix.
    const liveHeld = () => Task.create({
      podId: pod._id,
      taskNum: 2,
      taskId: 'T-2',
      title: 'held by a living claimant',
      status: 'claimed',
      claimedBy: 'busy-agent',
      claimedAt: new Date(),
      claimExpiresAt: new Date(Date.now() + LEASE_MS),
    });

    test('?claimable=true surfaces a lapsed lease that ?status=pending cannot, and only that one', async () => {
      await lapsed();
      await liveHeld();
      const pending = await list(rivalToken, '?status=pending');
      expect(pending.status).toBe(200);
      expect(pending.body.tasks).toHaveLength(0);

      const claimableRes = await list(rivalToken, '?claimable=true');
      expect(claimableRes.status).toBe(200);
      expect(claimableRes.body.tasks.map((t) => t.taskId)).toEqual(['T-1']);
    });

    test('a peer can go from discovery to a granted claim without being told the taskId', async () => {
      await lapsed();
      await liveHeld();
      const found = await list(rivalToken, '?claimable=true');
      expect(found.body.tasks).toHaveLength(1);
      const [discovered] = found.body.tasks;
      const res = await request(app)
        .post(`/api/v1/tasks/${pod._id}/${discovered.taskId}/claim`)
        .set('Authorization', `Bearer ${rivalToken}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.task.claimedBy).toBe(rival._id.toString());
    });

    test('a LIVE lease is not offered — the filter narrows, it does not just return the board', async () => {
      await liveHeld();
      const res = await list(rivalToken, '?claimable=true');
      expect(res.status).toBe(200);
      expect(res.body.tasks).toHaveLength(0);
    });

    test('a RECENT legacy claim stays hidden while a STALE one surfaces', async () => {
      await seedTask({
        status: 'claimed',
        claimedBy: 'legacy-agent',
        claimedAt: new Date(Date.now() - 60 * 1000),
        claimExpiresAt: null,
      });
      expect((await list(rivalToken, '?claimable=true')).body.tasks).toHaveLength(0);

      await Task.updateOne(
        { podId: pod._id, taskId: 'T-1' },
        { $set: { claimedAt: new Date(Date.now() - 2 * LEASE_MS) } },
      );
      expect((await list(rivalToken, '?claimable=true')).body.tasks.map((t) => t.taskId)).toEqual(['T-1']);
    });

    test('claimable composes with status rather than overriding it', async () => {
      await lapsed();
      await liveHeld();
      const both = await list(rivalToken, '?status=claimed&claimable=true');
      expect(both.body.tasks.map((t) => t.taskId)).toEqual(['T-1']);
    });
  });

  // A lease timestamp is not an event. Renewals fanned a wake to every seat
  // in the pod, each burning a model turn to conclude "nothing new" — 4 wakes
  // for one task in one session, with seats meta-discussing the noise
  // (measured in a pod, 2026-08-25). The board UI still updates via the
  // socket emit; only the agent fan-out is gated.
  describe('renewal wakes nobody — the fan-out fires only on news', () => {
    beforeEach(() => {
      notifyPodAgents.mockClear();
    });

    test('a fresh claim fans out; the holder renewing does not', async () => {
      await seedTask();
      await claim(ownerToken);
      expect(notifyPodAgents).toHaveBeenCalledTimes(1);

      const renew = await claim(ownerToken);
      expect(renew.status).toBe(200);
      expect(notifyPodAgents).toHaveBeenCalledTimes(1); // unchanged
    });

    test('a takeover after a lapse fans out — a NEW holder is news', async () => {
      await seedTask();
      await claim(ownerToken);
      await Task.updateOne(
        { podId: pod._id, taskId: 'T-1' },
        { $set: { claimExpiresAt: new Date(Date.now() - 1000) } },
      );
      notifyPodAgents.mockClear();
      const res = await claim(rivalToken);
      expect(res.status).toBe(200);
      expect(notifyPodAgents).toHaveBeenCalledTimes(1);
    });

    test('re-taking a task you yourself lapsed from is a continuation, not news', async () => {
      await seedTask({
        status: 'pending',
        claimedBy: null,
        lapsedFrom: owner._id.toString(),
      });
      const res = await claim(ownerToken);
      expect(res.status).toBe(200);
      expect(notifyPodAgents).not.toHaveBeenCalled();
    });
  });

  test('PATCH wakes the owner immediately before its atomic write under interleaving', async () => {
    await seedTask({ assignee: 'alpha' });
    notifyPodAgents.mockClear();
    const originalUpdate = Task.findOneAndUpdate.bind(Task);
    let releaseGamma;
    let gammaEntered;
    const gammaPaused = new Promise((resolve) => { releaseGamma = resolve; });
    const entered = new Promise((resolve) => { gammaEntered = resolve; });
    let pausedGamma = false;
    const updateSpy = jest.spyOn(Task, 'findOneAndUpdate').mockImplementation((filter, update, options) => {
      if (update?.$set?.assignee === 'gamma' && !pausedGamma) {
        pausedGamma = true;
        gammaEntered();
        return gammaPaused.then(() => originalUpdate(filter, update, options));
      }
      return originalUpdate(filter, update, options);
    });
    const patch = (assignee) => request(app)
      .patch(`/api/v1/tasks/${pod._id}/T-1`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ assignee });

    try {
      const gammaRequest = patch('gamma').then((response) => response);
      await entered;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const betaResponse = await patch('beta');
      expect(betaResponse.status).toBe(200);
      releaseGamma();
      const gammaResponse = await gammaRequest;
      expect(gammaResponse.status).toBe(200);

      const gammaWake = notifyPodAgents.mock.calls.find((call) => call[1].assignee === 'gamma');
      expect(gammaWake?.[4]).toEqual(expect.objectContaining({ assignee: 'beta' }));
      expect(gammaWake?.[1]).toEqual(expect.objectContaining({ assignee: 'gamma' }));
      const betaWake = notifyPodAgents.mock.calls.find((call) => call[1].assignee === 'beta');
      expect(gammaWake[1].updatedAt.getTime()).toBeGreaterThan(betaWake[1].updatedAt.getTime());
      expect((await Task.findOne({ podId: pod._id, taskId: 'T-1' })).assignee).toBe('gamma');
    } finally {
      releaseGamma();
      updateSpy.mockRestore();
    }
  });

  test('claim wakes the assignee at its successful write after a racing PATCH', async () => {
    await seedTask({ assignee: 'alpha' });
    notifyPodAgents.mockClear();
    const originalUpdate = Task.findOneAndUpdate.bind(Task);
    let releaseClaim;
    let claimEntered;
    const claimPaused = new Promise((resolve) => { releaseClaim = resolve; });
    const entered = new Promise((resolve) => { claimEntered = resolve; });
    let pausedClaim = false;
    const updateSpy = jest.spyOn(Task, 'findOneAndUpdate').mockImplementation((filter, update, options) => {
      if (update?.$set?.claimedBy === owner._id.toString() && !pausedClaim) {
        pausedClaim = true;
        claimEntered();
        return claimPaused.then(() => originalUpdate(filter, update, options));
      }
      return originalUpdate(filter, update, options);
    });

    try {
      const claimRequest = claim(ownerToken).then((response) => response);
      await entered;
      const patchResponse = await request(app)
        .patch(`/api/v1/tasks/${pod._id}/T-1`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ assignee: 'beta' });
      expect(patchResponse.status).toBe(200);
      notifyPodAgents.mockClear();
      releaseClaim();
      const claimResponse = await claimRequest;
      expect(claimResponse.status).toBe(200);

      const claimWake = notifyPodAgents.mock.calls.find((call) => call[1].claimedBy === owner._id.toString());
      expect(claimWake?.[4]).toEqual(expect.objectContaining({ assignee: 'beta' }));
      expect(claimWake?.[1]).toEqual(expect.objectContaining({ assignee: 'beta' }));
    } finally {
      releaseClaim();
      updateSpy.mockRestore();
    }
  });

  test('claim uses the rescued owner when a sweep writes the same timestamp', async () => {
    const task = await seedTask({
      status: 'claimed',
      assignee: 'alpha',
      claimedBy: 'alpha',
      claimedAt: new Date(Date.now() - LEASE_MS - 5000),
      claimExpiresAt: new Date(Date.now() - 5000),
    });
    notifyPodAgents.mockClear();
    const originalUpdate = Task.findOneAndUpdate.bind(Task);
    let releaseClaim;
    let claimEntered;
    const claimPaused = new Promise((resolve) => { releaseClaim = resolve; });
    const entered = new Promise((resolve) => { claimEntered = resolve; });
    let pausedClaim = false;
    const updateSpy = jest.spyOn(Task, 'findOneAndUpdate').mockImplementation((filter, update, options) => {
      if (update?.$set?.claimedBy === owner._id.toString() && !pausedClaim) {
        pausedClaim = true;
        claimEntered();
        return claimPaused.then(() => originalUpdate(filter, update, options));
      }
      return originalUpdate(filter, update, options);
    });

    try {
      const claimRequest = claim(ownerToken).then((response) => response);
      await entered;
      // Mongoose normally stamps the sweep with wall-clock time. Hold its
      // clock at the existing revision to reproduce a timestamp collision.
      const mongoose = require('mongoose');
      const clockSpy = jest.spyOn(mongoose, 'now').mockReturnValue(task.updatedAt);
      try {
        const { rescued } = await KernelWorkSweepService.rescueLapsed(new Date());
        expect(rescued).toHaveLength(1);
      } finally {
        clockSpy.mockRestore();
      }
      const rescuedTask = await Task.findById(task._id);
      expect(rescuedTask.updatedAt.getTime()).toBe(task.updatedAt.getTime());
      expect(rescuedTask.assignee).toBeNull();
      notifyPodAgents.mockClear();
      releaseClaim();
      const claimResponse = await claimRequest;
      expect(claimResponse.status).toBe(200);

      const claimWake = notifyPodAgents.mock.calls.find((call) => call[1].claimedBy === owner._id.toString());
      expect(claimWake?.[4]).toEqual(expect.objectContaining({ assignee: null, claimedBy: null }));
      expect(claimWake?.[4].assignee).not.toBe('alpha');
    } finally {
      releaseClaim();
      updateSpy.mockRestore();
    }
  });

  test('PATCH unassignment leaves the stored revision due for the work sweep', async () => {
    await AgentInstallation.updateOne(
      { agentName: 'claim-audit-agent', podId: pod._id },
      { $set: { 'config.boardWake.enabled': true,
        'config.workDiscovery': { enabled: true, role: 'implementer' } } },
    );
    await seedTask({ assignee: 'claim-audit-agent' });
    // Force the same monotonic retry the PATCH takes when a competing writer
    // has committed after this request chose its timestamp.
    await Task.updateOne(
      { podId: pod._id, taskId: 'T-1' },
      { $set: { updatedAt: new Date(Date.now() + 1000) } },
      { timestamps: false },
    );
    notifyPodAgents.mockClear();
    const res = await request(app)
      .patch(`/api/v1/tasks/${pod._id}/T-1`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ assignee: null });
    expect(res.status).toBe(200);
    const wake = notifyPodAgents.mock.calls.find((call) => call[1].taskId === 'T-1');
    expect(wake?.[4]).toEqual(expect.objectContaining({ assignee: 'claim-audit-agent' }));
    const stored = await Task.findOne({ podId: pod._id, taskId: 'T-1' });
    expect(wake[1].updatedAt.getTime()).toBe(stored.updatedAt.getTime());

    const realNotifyPodAgents = jest.requireActual('../../services/taskEventService').notifyPodAgents;
    await realNotifyPodAgents(pod._id, wake[1], wake[2], wake[3], wake[4]);
    const offered = await Task.findById(stored._id);
    expect(offered.offeredAt).toBeUndefined();

    // The prior-owner notice does not offer work to idle implementers.
    // Only the opted-in discovery sweep offers the unassigned row. Use a clock past the forced monotonic revision above.
    const sweep = await require('../../services/kernelWorkSweepService')
      .wakeForFoundWork(new Date(stored.updatedAt.getTime() + 1000));
    expect(sweep.scannedPods).toBe(1);
    expect(sweep.woken).toBe(1);
    const swept = await Task.findById(stored._id);
    expect(swept.offeredAt?.getTime()).toBe(swept.updatedAt.getTime());

    const note = await request(app)
      .post(`/api/v1/tasks/${pod._id}/T-1/updates`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ text: 'Still available for pickup' });
    expect(note.status).toBe(200);
    const afterNote = await Task.findById(stored._id);
    expect(afterNote.updatedAt.getTime()).toBeGreaterThan(swept.offeredAt.getTime());
    const dueSweep = await require('../../services/kernelWorkSweepService')
      .wakeForFoundWork(new Date(afterNote.updatedAt.getTime() + 1000));
    expect(dueSweep.scannedPods).toBe(1);

    const title = await request(app)
      .patch(`/api/v1/tasks/${pod._id}/T-1`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Still open' });
    expect(title.status).toBe(200);
    const afterTitle = await Task.findById(stored._id);
    expect(afterTitle.updatedAt.getTime()).toBeGreaterThan(afterNote.updatedAt.getTime());

    const claimed = await claim(ownerToken);
    expect(claimed.status).toBe(200);
    expect(new Date(claimed.body.task.updatedAt).getTime()).toBeGreaterThan(afterTitle.updatedAt.getTime());

    const completed = await request(app)
      .post(`/api/v1/tasks/${pod._id}/T-1/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
    expect(completed.status).toBe(200);
    expect(new Date(completed.body.task.updatedAt).getTime())
      .toBeGreaterThan(new Date(claimed.body.task.updatedAt).getTime());
  });
  test('priority edits through note append respect another seat live lease', async () => {
    await seedTask({ status: 'claimed', claimedBy: String(rival._id), claimedAt: new Date(), claimExpiresAt: new Date(Date.now() + LEASE_MS), priority: 'P1' });
    const response = await request(app)
      .post(`/api/v1/tasks/${pod._id}/T-1/updates`)
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send({ text: 'Change priority', priority: 'P3', continueAnyway: true });
    expect(response.status).toBe(409);
    expect((await Task.findOne({ podId: pod._id, taskId: 'T-1' })).priority).toBe('P1');
  });

  // A seat that omits podId reaches these routes with the literal "undefined"
  // in the path (the MCP interpolates it). That used to throw a Pod CastError
  // and answer 500, which seats read as the board being down.
  test.each([
    ['list', (path) => request(app).get(path)],
    ['claim', (path) => request(app).post(`${path}/T-1/claim`).send({})],
    ['note', (path) => request(app).post(`${path}/T-1/updates`).send({ text: 'renewal' })],
  ])('an agent %s with podId "undefined" is a 400 naming podId, not a 500', async (_label, send) => {
    await seedTask();
    const res = await send('/api/v1/tasks/undefined').set('Authorization', `Bearer ${AGENT_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('podId must be a pod id');
    expect((await Task.findOne({ podId: pod._id, taskId: 'T-1' })).status).toBe('pending');
  });

});
