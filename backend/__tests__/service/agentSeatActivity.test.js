/**
 * TASK-672 slice 2 — GET /api/agents/seat-activity (member-gated seat logs).
 *
 * Real Mongo (tier 1). The route must admit a pod member, refuse a stranger
 * and a global admin who is not a member, and never return payloads or prompts.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentEvent = require('../../models/AgentEvent');
const AgentRun = require('../../models/AgentRun');

const seatActivityRoutes = require('../../routes/agentSeatActivity');

const JWT_SECRET = 'test-jwt-secret-for-seat-activity';

jest.setTimeout(60_000);

describe('GET /api/agents/seat-activity', () => {
  let app;
  let member;
  let stranger;
  let globalAdmin;
  let pod;
  let memberToken;
  let strangerToken;
  let adminToken;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/agents/seat-activity', seatActivityRoutes);

    member = await User.create({ username: 'seat-member', email: 'seat-member@test.com', password: 'password123' });
    stranger = await User.create({ username: 'seat-stranger', email: 'seat-stranger@test.com', password: 'password123' });
    globalAdmin = await User.create({ username: 'seat-admin', email: 'seat-admin@test.com', password: 'password123', role: 'admin' });
    memberToken = jwt.sign({ id: member._id.toString() }, JWT_SECRET);
    strangerToken = jwt.sign({ id: stranger._id.toString() }, JWT_SECRET);
    adminToken = jwt.sign({ id: globalAdmin._id.toString() }, JWT_SECRET);

    pod = await Pod.create({
      name: 'Seat Activity Pod',
      type: 'chat',
      createdBy: member._id,
      members: [member._id],
    });

    await AgentEvent.create({
      agentName: 'forge',
      instanceId: 'default',
      podId: pod._id,
      type: 'chat.mention',
      payload: { content: 'SECRET PROMPT TEXT' },
      status: 'acked',
      delivery: { outcome: 'posted', details: { reply: 'SECRET REPLY' } },
    });
    await AgentRun.create({
      podId: pod._id,
      agentName: 'forge',
      instanceId: 'default',
      trigger: 'mention',
      status: 'succeeded',
      totalTokens: 1234,
      turns: [{ turnIndex: 0, model: 'm', llmResponseText: 'SECRET TURN TEXT' }],
    });
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  const get = (token, query) => request(app)
    .get('/api/agents/seat-activity')
    .set('Authorization', `Bearer ${token}`)
    .query(query);

  test('a pod member gets recent events and runs for the seat', async () => {
    const res = await get(memberToken, { podId: pod._id.toString(), agentName: 'forge' });
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ type: 'chat.mention', status: 'acked', outcome: 'posted' });
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0]).toMatchObject({ trigger: 'mention', status: 'succeeded', totalTokens: 1234 });
  });

  test('payloads, reply text and turn text never appear in the response', async () => {
    const res = await get(memberToken, { podId: pod._id.toString(), agentName: 'forge' });
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/SECRET/);
    expect(body).not.toMatch(/payload|llmResponseText|details/);
  });

  test('a stranger is refused, even though the seat exists in that pod', async () => {
    const res = await get(strangerToken, { podId: pod._id.toString(), agentName: 'forge' });
    expect(res.status).toBe(403);
    expect(res.body.events).toBeUndefined();
  });

  test('a global admin who is not a member is refused (no admin bypass on this route)', async () => {
    const res = await get(adminToken, { podId: pod._id.toString(), agentName: 'forge' });
    expect(res.status).toBe(403);
  });

  test('an unknown seat in a pod the caller belongs to returns empty lists, not an error', async () => {
    const res = await get(memberToken, { podId: pod._id.toString(), agentName: 'nobody' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], runs: [] });
  });

  test('a malformed pod id or missing agent name is a 400', async () => {
    expect((await get(memberToken, { podId: 'not-an-id', agentName: 'forge' })).status).toBe(400);
    expect((await get(memberToken, { podId: pod._id.toString() })).status).toBe(400);
  });

  test('unauthenticated requests are refused', async () => {
    const res = await request(app)
      .get('/api/agents/seat-activity')
      .query({ podId: pod._id.toString(), agentName: 'forge' });
    expect(res.status).toBe(401);
    expect(mongoose.isValidObjectId(pod._id)).toBe(true);
  });
});
