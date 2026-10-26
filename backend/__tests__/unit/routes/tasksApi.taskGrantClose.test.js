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
beforeAll(async () => { await setupMongoDb(); app = express(); app.use(express.json()); app.use('/tasks', router); });
afterEach(clearMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
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
  expect((await request(app).patch(`/tasks/${POD}/TASK-1`).send({ status: 'claimed', claimedByUserId: mockActor.id })).status).toBe(200);
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
