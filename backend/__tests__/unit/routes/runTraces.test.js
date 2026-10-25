jest.mock('../../../config/db-pg', () => {
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  return { pool: new Pool() };
});
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  if (!req.get('x-user')) return res.sendStatus(401);
  req.user = { id: req.get('x-user') };
  return next();
});
jest.mock('../../../services/dmService', () => ({
  canViewPod: jest.fn(async (userId, pod) => Boolean(pod?.members.some((m) => String(m) === userId))),
}));
const AgentRun = require('../../../models/AgentRun');
const Pod = require('../../../models/Pod');
const ToolCall = require('../../../models/ToolCall');
const { pool } = require('../../../config/db-pg');
const { boundRunValue, RUN_TRACE_BYTES } = require('../../../services/agentRunLimits');
const { BSON } = require('mongodb');
const MEMBER = new mongoose.Types.ObjectId();
const POD = new mongoose.Types.ObjectId();
const OTHER = new mongoose.Types.ObjectId();
let mongo;
let app;
let run;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = express();
  app.use('/api/pods', require('../../../routes/runTraces'));
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await AgentRun.deleteMany({});
  await Pod.deleteMany({});
  await Pod.create({ _id: POD, name: 'Trace pod', type: 'team', members: [MEMBER], createdBy: MEMBER });
  run = await AgentRun.create({
    podId: POD, agentName: 'trace-seat', instanceId: 'default', trigger: 'mention', status: 'succeeded',
    startedAt: new Date('2020-01-01'),
    turns: [{ turnIndex: 0, model: 'model', elapsedMs: 1, llmResponseText: 'private prompt',
      toolCalls: [{ name: 'vendor.read', args: { secret: 'PRIVATE_ARGS' }, result: 'PRIVATE_RESULT', callId: 'trace-call', outcome: 'ok' }] }],
  });
  await ToolCall.create({ callId: `unused-${run.id}`, grantId: 'grant', podId: String(POD), agentUserId: 'seat', tool: 'vendor.read', argsDigest: 'a'.repeat(64), outcome: 'ok' });
  await pool.query('DELETE FROM tool_calls WHERE call_id IN ($1, $2)', ['trace-call', 'foreign-call']);
  await ToolCall.create({ callId: 'trace-call', grantId: 'grant', podId: String(POD), credentialOwnerId: 'owner', agentUserId: 'seat', tool: 'vendor.read', argsDigest: 'a'.repeat(64), outcome: 'ok' });
  await ToolCall.create({ callId: 'foreign-call', grantId: 'foreign-grant', podId: String(OTHER), credentialOwnerId: 'foreign-owner', agentUserId: 'seat', tool: 'vendor.read', argsDigest: 'a'.repeat(64), outcome: 'failed' });
});
const get = (pod = POD, id = run.id, user = MEMBER) => request(app).get(`/api/pods/${pod}/runs/${id}`).set('x-user', String(user));

test('requires authentication and current pod access, not knowledge of a run ID', async () => {
  expect((await request(app).get(`/api/pods/${POD}/runs/${run.id}`)).status).toBe(401);
  expect((await get(POD, run.id, OTHER)).status).toBe(404);
  expect((await get(OTHER)).status).toBe(404);
  expect((await get(POD, 'bad-id')).status).toBe(404);
});
test('returns durable turn + PG attribution after card retention without content', async () => {
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.run.turns[0].toolCalls[0].trail).toMatchObject({ callId: 'trace-call', grantId: 'grant', credentialOwnerId: 'owner', outcome: 'ok' });
  expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE_|private prompt|argsDigest/);
  expect(res.body.retention).toEqual({ cardDefaultDays: 30, traceExpiresAt: null });
});
test('cross-pod references never join a foreign trail', async () => {
  run.turns[0].toolCalls[0].callId = 'foreign-call';
  await run.save();
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.body.run.turns[0].toolCalls[0]).toMatchObject({ outcome: 'unavailable', trail: null });
  expect(JSON.stringify(res.body)).not.toMatch(/foreign-owner|foreign-grant/);
});
test('PG failure is explicit instead of an empty audit', async () => {
  jest.spyOn(ToolCall, 'listRunReferences').mockRejectedValueOnce(new Error('db offline'));
  expect((await get()).status).toBe(503);
});
test('save caps UTF-8 args/results, response text and aggregate BSON size', async () => {
  const huge = '界'.repeat(10000);
  run.turns = Array.from({ length: 140 }, (_, turnIndex) => ({
    turnIndex, model: 'm', elapsedMs: 1, llmResponseText: huge,
    toolCalls: Array.from({ length: turnIndex === 0 ? 70 : 0 }, () => ({ name: 'read', elapsedMs: 1, args: huge, result: huge })),
  }));
  await run.save();
  const stored = await AgentRun.findById(run.id).lean();
  expect(stored.traceTruncated).toBe(true);
  expect(stored.turns[0].toolCalls[0].args).toEqual({ truncated: true, originalBytes: Buffer.byteLength(JSON.stringify(huge)) });
  expect(stored.omittedTurns).toBeGreaterThan(0);
  expect(stored.omittedToolCalls).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(stored.turns))).toBeLessThan(RUN_TRACE_BYTES);
  expect(BSON.calculateObjectSize(JSON.parse(JSON.stringify(stored)))).toBeLessThan(8 * 1024 * 1024);
  expect(boundRunValue({ small: 'kept' })).toEqual({ small: 'kept' });
  expect(boundRunValue([...[...Array(300)].map(() => 0)])).toMatchObject({ truncated: true });
  await run.save();
  expect(run.omittedTurns).toBe(stored.omittedTurns);
});


test('aggregate budget caps many individually valid values before Mongo insert', async () => {
  run.turns = Array.from({ length: 80 }, (_, turnIndex) => ({
    turnIndex, model: 'm', elapsedMs: 1,
    toolCalls: Array.from({ length: 10 }, () => ({ name: 'read', elapsedMs: 1,
      args: 'x'.repeat(4000), result: 'y'.repeat(4000) })),
  }));
  await run.save();
  const stored = await AgentRun.findById(run.id).lean();
  expect(stored.omittedToolCalls).toBeGreaterThan(0);
  expect(BSON.calculateObjectSize(JSON.parse(JSON.stringify(stored.turns)))).toBeLessThan(RUN_TRACE_BYTES);
});
