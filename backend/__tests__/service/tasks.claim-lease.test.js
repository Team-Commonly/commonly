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

const express = require('express');
const request = require('supertest');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const User = require('../../models/User');
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
      botMetadata: { agentName: 'claim-audit-agent', instanceId: 'default' },
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
});
