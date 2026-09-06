/** TASK-130: request -> human ruling -> authenticated asking-agent queue.
 * No enqueue, model, auth, or message-store mocks: this test holds the
 * persisted delivery contract, not just the arguments passed to enqueue.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const DecisionRequest = require('../../models/DecisionRequest');
const AgentEvent = require('../../models/AgentEvent');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');
const { hash } = require('../../utils/secret');
const {
  setupMongoDb, closeMongoDb, setupPgDb, closePgDb,
} = require('../utils/testUtils');
const runtimeRoutes = require('../../routes/agentsRuntime');
const activityRoutes = require('../../routes/activity');

const describeTier1 = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;

describeTier1('decision ruling delivery — real Mongo + PostgreSQL', () => {
  let app;
  let owner;
  let pod;
  let ownerToken;
  const tokens = {};

  beforeAll(async () => {
    await setupMongoDb();
    const pg = await setupPgDb();
    app = express();
    app.use(express.json());
    app.use('/api/agents/runtime', runtimeRoutes);
    app.use('/api/activity', activityRoutes);

    owner = await User.create({
      username: 'decision-owner', email: 'decision-owner@test.com', password: 'password123',
    });
    ownerToken = jwt.sign({ id: String(owner._id) }, process.env.JWT_SECRET);
    const agents = [];
    for (const instanceId of ['asking-seat', 'other-seat']) {
      const token = `cm_agent_decision-delivery-${instanceId}`;
      const agent = await User.create({
        username: AgentIdentityService.buildAgentUsername('openclaw', instanceId),
        email: `${instanceId}@test.com`,
        password: 'password123',
        isBot: true,
        botMetadata: { agentName: 'openclaw', instanceId, displayName: instanceId },
        agentRuntimeTokens: [{ tokenHash: hash(token), lastUsedAt: new Date() }],
      });
      agents.push(agent);
      tokens[instanceId] = token;
    }
    pod = await Pod.create({
      name: 'Decision delivery', type: 'team', createdBy: owner._id,
      members: [owner._id, ...agents.map((agent) => agent._id)],
    });
    for (const user of [owner, ...agents]) {
      await pg.query('INSERT INTO users (_id, username) VALUES ($1, $2)', [String(user._id), user.username]);
    }
    for (const agent of agents) {
      await AgentInstallation.create({
        agentName: 'openclaw', instanceId: agent.botMetadata.instanceId,
        podId: pod._id, installedBy: owner._id, version: '1.0.0', status: 'active',
      });
    }
  });

  afterAll(async () => {
    const { pool } = require('../../config/db-pg');
    if (pool) await pool.end();
    await closePgDb();
    await closeMongoDb();
  });

  const poll = (seat) => request(app).get('/api/agents/runtime/events')
    .set('Authorization', `Bearer ${tokens[seat]}`).expect(200);

  test('only the asking seat reads the exact persisted ruling, once', async () => {
    const asked = await request(app).post('/api/agents/runtime/decisions')
      .set('Authorization', `Bearer ${tokens['asking-seat']}`)
      .send({
        podId: String(pod._id), decisionClass: 'implementation',
        title: 'Choose the rollout', question: 'Which rollout should I run?',
        options: [{ label: 'Canary', recommended: true }, { label: 'Full rollout' }],
      }).expect(201);
    const { decisionId, messageId } = asked.body;
    expect(messageId).toMatch(/^\d+$/);
    expect((await poll('asking-seat')).body.events.filter((event) => event.type === 'decision.ruled'))
      .toEqual([]);

    await request(app).post(`/api/activity/decisions/${decisionId}/choose`)
      .set('Authorization', `Bearer ${ownerToken}`).send({ value: 'Canary' }).expect(200);

    // A sibling seat has the same runtime and pod access. Its token must not
    // claim the asker's ruling merely because agentName is also openclaw.
    expect((await poll('other-seat')).body.events.filter((event) => event.type === 'decision.ruled'))
      .toEqual([]);
    const inbox = await poll('asking-seat');
    const events = inbox.body.events.filter((event) => event.type === 'decision.ruled');
    expect(events).toHaveLength(1);
    const decision = await DecisionRequest.findById(decisionId).lean();
    expect(events[0]).toMatchObject({
      agentName: 'openclaw', instanceId: 'asking-seat', podId: String(pod._id),
      payload: {
        decisionId, pick: 'Canary',
        ruledBy: { userId: String(owner._id), username: owner.username },
        ruledAt: decision.ruling.at.toISOString(),
        rulingMessageId: decision.ruling.messageId,
        podId: String(pod._id),
      },
    });
    const stored = await AgentEvent.findById(events[0]._id).lean();
    expect(stored.status).toBe('delivered');
    expect(stored.attempts).toBe(1);

    await request(app).post(`/api/activity/decisions/${decisionId}/choose`)
      .set('Authorization', `Bearer ${ownerToken}`).send({ value: 'Full rollout' }).expect(409);
    expect((await poll('asking-seat')).body.events.filter((event) => event.type === 'decision.ruled'))
      .toEqual([]);
    expect(await AgentEvent.countDocuments({ type: 'decision.ruled', 'payload.decisionId': decisionId }))
      .toBe(1);
  });
});
