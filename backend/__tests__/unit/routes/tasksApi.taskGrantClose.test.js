const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../../utils/testUtils');
const mockActor = { id: new mongoose.Types.ObjectId().toString(), bot: false };
jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.userId = mockActor.id;
  req.user = { _id: mockActor.id, isBot: mockActor.bot, botMetadata: { instanceId: 'default' } };
  next();
});
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, _res, next) => next());
jest.mock('../../../services/taskEventService', () => ({ emitTaskUpdated: jest.fn(), notifyPodAgents: jest.fn(async () => {}) }));
jest.mock('../../../services/attentionItemService', () => ({ resolveTaskAttention: jest.fn(async () => {}), recordTaskAttention: jest.fn(async () => {}) }));
jest.mock('../../../services/systemExchangeTriggers', () => ({ recordTaskCompleted: jest.fn(async () => {}) }));
jest.mock('../../../services/agentSendFreshness', () => ({ unseenMessages: jest.fn(async () => null) }));
// An in-memory record chain store with the repository's contract.
const mockChains = new Map();
jest.mock('../../../repositories/recordChainRepository', () => {
  const actual = jest.requireActual('../../../repositories/recordChainRepository');
  return {
    ...actual,
    appendToChain: jest.fn(async (ref, runId, eventKey, build) => {
      const key = `${ref.podId}|${ref.taskId || ''}`;
      if (!mockChains.has(key)) mockChains.set(key, { runId, lines: [], keys: new Set() });
      const chain = mockChains.get(key);
      if (chain.keys.has(eventKey)) return { appended: 0, duplicate: true };
      const { lines } = build(chain.lines[chain.lines.length - 1] || null, chain.runId);
      chain.lines.push(...lines);
      chain.keys.add(eventKey);
      return { appended: lines.length, duplicate: false };
    }),
  };
});
const { flushRecordWrites } = require('../../../services/recordService');
const { verifyRecord } = require('../../../vendor/seats/src/record/format');
const Task = require('../../../models/Task');
const Pod = require('../../../models/Pod');
const RoomGrant = require('../../../models/RoomGrant');
const { mintGrant, assertGrantUsable } = require('../../../services/roomGrantService');
const { completeTaskForMergedPull } = require('../../../services/githubGigService');
const { completeConnectAgentStarterTask, CONNECT_AGENT_SOURCE_REF } = require('../../../services/starterTaskService');
const router = require('../../../routes/tasksApi');
const POD = new mongoose.Types.ObjectId().toString();
let app;
let grant;
const recordPods = process.env.RECORD_V1_PODS;
beforeAll(async () => {
  process.env.RECORD_V1_PODS = POD;
  await setupMongoDb(); app = express(); app.use(express.json()); app.use('/tasks', router);
});
afterEach(async () => { await flushRecordWrites(); await clearMongoDb(); });
afterAll(async () => {
  if (recordPods === undefined) delete process.env.RECORD_V1_PODS;
  else process.env.RECORD_V1_PODS = recordPods;
  await closeMongoDb();
});
beforeEach(async () => {
  mockChains.clear();
  mockActor.bot = false;
  await Pod.create({ _id: POD, name: 'Bound task', createdBy: mockActor.id, members: [mockActor.id] });
  await Task.create({ podId: POD, taskId: 'TASK-1', taskNum: 1, title: 'Bound task', status: 'claimed',
    claimedBy: mockActor.id, claimExpiresAt: new Date(Date.now() + 60000),
    prUrl: 'https://github.com/Team-Commonly/commonly/pull/123', sourceRef: CONNECT_AGENT_SOURCE_REF });
  grant = await mintGrant({ connectionId: 'c', installationId: 'i', target: { kind: 'pod', id: POD },
    tools: ['issues.read'], audience: [mockActor.id], writeMode: 'read', brokerId: 'b',
    expiresAt: new Date(Date.now() + 3600000), binding: { podId: POD, taskId: 'TASK-1' } });
});

test.each(['complete', 'patch', 'github', 'onboarding'])('%s close revokes the bound grant before returning', async (writer) => {
  if (writer === 'complete') expect((await request(app).post(`/tasks/${POD}/TASK-1/complete`).send({})).status).toBe(200);
  if (writer === 'patch') expect((await request(app).patch(`/tasks/${POD}/TASK-1`).send({ status: 'done' })).status).toBe(200);
  if (writer === 'github') await completeTaskForMergedPull(POD, 'https://github.com/Team-Commonly/commonly/pull/123');
  if (writer === 'onboarding') await completeConnectAgentStarterTask({ podIds: [POD], agentLabel: 'Scout' });
  const task = await Task.findOne({ podId: POD, taskId: 'TASK-1' });
  expect(task.status).toBe('done');
  expect(task.grantEpoch).toBe(1);
  const revoked = await RoomGrant.findById(grant._id);
  expect(revoked.revocationReason).toBe('task.done');
  expect(revoked.revokedAt).toBeInstanceOf(Date);
  await expect(assertGrantUsable({ grantId: grant.grantId, agentUserId: mockActor.id, currentMemberIds: [mockActor.id] }))
    .rejects.toMatchObject({ code: 'grant_revoked' });
  // ADR-033 §4: the close's task.done, then grant.revoked for its bound grants.
  await flushRecordWrites();
  const { lines } = mockChains.get(`${POD}|TASK-1`);
  expect(verifyRecord(lines.map((line) => `${line}\n`).join(''))).toMatchObject({ ok: true });
  expect(lines.map((line) => JSON.parse(line)).map((l) => [l.kind, l.data.grantIds || null])).toEqual([
    ['grant.issued', null], ['task.done', null], ['grant.revoked', [grant.grantId]],
  ]);
});

test('a repeated PATCH to done keeps its completion time, closes once, and still applies its note', async () => {
  expect((await request(app).patch(`/tasks/${POD}/TASK-1`).send({ status: 'done' })).status).toBe(200);
  const first = await Task.findOne({ podId: POD, taskId: 'TASK-1' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect((await request(app).patch(`/tasks/${POD}/TASK-1`).send({ status: 'done', notes: 'closed again' })).status).toBe(200);
  const second = await Task.findOne({ podId: POD, taskId: 'TASK-1' });
  expect(second.completedAt.getTime()).toBe(first.completedAt.getTime());
  expect(second.grantEpoch).toBe(1);
  expect(second.notes).toBe('closed again');
});

test('a failed revocation write leaves the close committed and the grant refused by its epoch', async () => {
  const spy = jest.spyOn(RoomGrant, 'findOneAndUpdate').mockRejectedValueOnce(new Error('revocation write failed'));
  expect((await request(app).post(`/tasks/${POD}/TASK-1/complete`).send({})).status).toBe(200);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
  expect((await Task.findOne({ podId: POD, taskId: 'TASK-1' })).status).toBe('done');
  expect((await RoomGrant.findById(grant._id)).revokedAt).toBeNull();
  await Task.updateOne({ podId: POD, taskId: 'TASK-1' }, { $set: { status: 'claimed', claimedByUserId: mockActor.id,
    claimExpiresAt: new Date(Date.now() + 60000) } });
  await expect(assertGrantUsable({ grantId: grant.grantId, agentUserId: mockActor.id, currentMemberIds: [mockActor.id] }))
    .rejects.toMatchObject({ code: 'task_closed' });
});

test('claim stamps authenticated identity and refuses renewal by a different User sharing its display key', async () => {
  await Task.updateOne({ taskId: 'TASK-1' }, { $set: { status: 'pending' } });
  mockActor.bot = true;
  const first = await request(app).post(`/tasks/${POD}/TASK-1/claim`).send({ continueAnyway: true });
  expect(first.status).toBe(200);
  expect(first.body.task.claimedBy).toBe('default');
  expect(first.body.task.claimedByUserId).toBe(mockActor.id);
  await Task.updateOne({ taskId: 'TASK-1' }, { $set: { claimedByUserId: new mongoose.Types.ObjectId().toString() } });
  const peer = await request(app).post(`/tasks/${POD}/TASK-1/claim`).send({ continueAnyway: true });
  expect(peer.status).toBe(409);
});

test('status-only release and reclaim cannot reuse the previous authenticated principal', async () => {
  await Task.updateOne({ taskId: 'TASK-1' }, { $set: { claimedByUserId: mockActor.id } });
  expect((await request(app).patch(`/tasks/${POD}/TASK-1`).send({ status: 'pending' })).status).toBe(200);
  expect((await Task.findOne({ taskId: 'TASK-1' })).claimedByUserId).toBeNull();
  // A seat cannot PATCH a claim (a claim is a lease, and this route writes none for a seat),
  // so this reclaim by the agent principal is refused and binds nothing.
  mockActor.bot = true;
  expect((await request(app).patch(`/tasks/${POD}/TASK-1`).send({ status: 'claimed', claimedByUserId: mockActor.id })).status).toBe(400);
  expect((await Task.findOne({ taskId: 'TASK-1' })).claimedByUserId).toBeNull();
  await expect(assertGrantUsable({ grantId: grant.grantId, agentUserId: mockActor.id, currentMemberIds: [mockActor.id] }))
    .rejects.toMatchObject({ code: 'task_claim_required' });
});


test('legacy display-key renewal stays compatible without granting authenticated task authority', async () => {
  mockActor.bot = true;
  await Task.updateOne({ taskId: 'TASK-1' }, { $set: { claimedBy: 'default', claimedByUserId: null } });
  const renewed = await request(app).post(`/tasks/${POD}/TASK-1/claim`).send({ continueAnyway: true });
  expect(renewed.status).toBe(200);
  expect(renewed.body.task.claimedByUserId).toBeNull();
  await expect(assertGrantUsable({ grantId: grant.grantId, agentUserId: mockActor.id, currentMemberIds: [mockActor.id] }))
    .rejects.toMatchObject({ code: 'task_claim_required' });
});
