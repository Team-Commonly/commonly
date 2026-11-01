/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * TASK-513: board writes reach a task's record, and the record reaches only
 * the people it may. Real MongoDB for the board and the pod, real PostgreSQL
 * for the chain.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pod-records-test-secret';

jest.mock('../../services/taskEventService', () => {
  const actual = jest.requireActual('../../services/taskEventService');
  return { ...actual, notifyPodAgents: jest.fn().mockResolvedValue(undefined) };
});
jest.mock('../../services/systemActionLineService', () => ({
  emitSystemActionLine: jest.fn().mockResolvedValue(undefined),
}));

const express = require('express');
const request = require('supertest');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const User = require('../../models/User');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { hash } = require('../../utils/secret');
const { pool } = require('../../config/db-pg');
const repository = require('../../repositories/recordChainRepository');
const { flushRecordWrites } = require('../../services/recordService');
const KernelWorkSweepService = require('../../services/kernelWorkSweepService').default;
const { verifyRecord } = require('../../vendor/seats/src/record/format');
const {
  setupMongoDb, closeMongoDb, clearMongoDb, setupPgDb, closePgDb, generateTestToken,
} = require('../utils/testUtils');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const AGENT_TOKEN = 'cm_agent_pod_record_route';

real('task record route on real PostgreSQL and MongoDB', () => {
  let app;
  let owner;
  let outsider;
  let admin;
  let agent;
  let pod;
  let otherPod;
  const podIds = () => [String(pod._id), String(otherPod._id)];

  beforeAll(async () => {
    await setupMongoDb();
    await setupPgDb();
    await Task.init();
    app = express();
    app.use(express.json());
    app.use('/api/v1/tasks', require('../../routes/tasksApi'));
    app.use('/api/pods', require('../../routes/podRecords'));
  });

  beforeEach(async () => {
    await clearMongoDb();
    const stamp = Date.now();
    const person = (name, over = {}) => User.create({
      username: `${name}-${stamp}`, email: `${name}-${stamp}@test.com`, password: 'Password123!', verified: true, ...over,
    });
    owner = await person('record-owner');
    outsider = await person('record-outsider');
    admin = await person('record-admin', { role: 'admin' });
    agent = await person('record-agent', {
      username: 'record-agent',
      email: `record-agent-${stamp}@agents.commonly.local`,
      isBot: true,
      botType: 'agent',
      botMetadata: { agentName: 'record-agent', instanceId: 'default', ownerUserId: String(owner._id) },
      agentRuntimeTokens: [{ tokenHash: hash(AGENT_TOKEN), label: 'record', createdAt: new Date() }],
    });
    pod = await Pod.create({ name: 'Record pod', type: 'team', createdBy: owner._id, members: [owner._id, agent._id] });
    otherPod = await Pod.create({ name: 'Other pod', type: 'team', createdBy: owner._id, members: [owner._id, agent._id] });
    await AgentInstallation.create({
      agentName: 'record-agent', instanceId: 'default', podId: pod._id, version: '1.0.0', installedBy: owner._id,
    });
    await Task.create({ podId: pod._id, taskNum: 1, taskId: 'TASK-1', title: 'recorded task', status: 'pending' });
    process.env.RECORD_V1_PODS = podIds().join(',');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flushRecordWrites();
    await pool.query(
      'DELETE FROM record_lines WHERE chain_id IN (SELECT id FROM record_chains WHERE pod_id = ANY($1))',
      [podIds()],
    );
    await pool.query('DELETE FROM record_chains WHERE pod_id = ANY($1)', [podIds()]);
    delete process.env.RECORD_V1_PODS;
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
    await closePgDb();
  });

  const as = (token) => ({ Authorization: `Bearer ${token}` });
  const read = (token, podId = pod._id, taskId = 'TASK-1', query = '') => request(app)
    .get(`/api/pods/${podId}/record/tasks/${taskId}${query}`).set(as(token));
  const claim = () => request(app).post(`/api/v1/tasks/${pod._id}/TASK-1/claim`).set(as(AGENT_TOKEN)).send({ continueAnyway: true });

  it('mirrors the board: claim, renewal (no line), block, resume, complete — and the export verifies', async () => {
    expect((await claim()).status).toBe(200);
    expect((await claim()).status).toBe(200);
    expect((await request(app).patch(`/api/v1/tasks/${pod._id}/TASK-1`).set(as(AGENT_TOKEN)).send({ status: 'blocked' })).status).toBe(200);
    expect((await claim()).status).toBe(200);
    expect((await request(app).post(`/api/v1/tasks/${pod._id}/TASK-1/complete`).set(as(generateTestToken(owner._id))).send({})).status).toBe(200);
    await flushRecordWrites();

    const res = await read(generateTestToken(owner._id));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/x-ndjson/);
    expect(res.headers['cache-control']).toBe('no-store');
    const verified = verifyRecord(res.text);
    expect(verified).toMatchObject({ ok: true, entries: 4, settled: false });
    expect(res.headers['x-record-head']).toBe(verified.head);
    expect(res.headers['x-record-entries']).toBe('4');
    const lines = res.text.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((l) => [l.kind, l.data])).toEqual([
      ['task.claimed', { leaseUntil: expect.any(String) }],
      ['task.released', { reason: 'blocked' }],
      ['task.claimed', { leaseUntil: expect.any(String) }],
      ['task.done', { doneBy: String(owner._id) }],
    ]);
    const agentActor = { type: 'agent', id: String(agent._id), owner: String(owner._id) };
    expect(lines[0].actor).toEqual(agentActor);
    expect(lines[1].actor).toEqual(agentActor);
    expect(lines[3].actor).toEqual({ type: 'system', id: 'board' });
    expect(new Set(lines.map((l) => `${l.podId}/${l.taskId}/${l.runId}`)).size).toBe(1);
    expect(lines[0].podId).toBe(String(pod._id));

    // An agent member reads the same bytes; OTLP puts the task in one trace.
    expect((await read(AGENT_TOKEN)).text).toBe(res.text);
    const otlp = await read(AGENT_TOKEN, pod._id, 'TASK-1', '?format=otlp');
    expect(otlp.status).toBe(200);
    expect(otlp.body.resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({ name: 'seats.run' });
  });

  it('records the lease lapse, the claim a note restores, and the completion, in that order', async () => {
    expect((await claim()).status).toBe(200);
    const lapsedAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const { rescued } = await KernelWorkSweepService.rescueLapsed(lapsedAt);
    expect(rescued).toHaveLength(1);
    const note = await request(app).post(`/api/v1/tasks/${pod._id}/TASK-1/updates`).set(as(AGENT_TOKEN)).send({ text: 'still on it' });
    expect(note).toMatchObject({ status: 200, body: { leaseRenewed: true } });
    expect((await request(app).post(`/api/v1/tasks/${pod._id}/TASK-1/complete`).set(as(generateTestToken(owner._id))).send({})).status).toBe(200);
    await flushRecordWrites();

    const res = await read(generateTestToken(owner._id));
    expect(verifyRecord(res.text)).toMatchObject({ ok: true, entries: 4 });
    const lines = res.text.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((l) => [l.kind, l.actor && l.actor.type, l.data.reason])).toEqual([
      ['task.claimed', 'agent', undefined],
      ['task.released', 'system', 'lease_expired'],
      ['task.claimed', 'agent', undefined],
      ['task.done', 'system', undefined],
    ]);
  });

  it('a seat PATCH to claimed is refused and records no claim', async () => {
    expect((await claim()).status).toBe(200);
    const asOwner = as(generateTestToken(owner._id));
    expect((await request(app).patch(`/api/v1/tasks/${pod._id}/TASK-1`).set(asOwner).send({ status: 'blocked' })).status).toBe(200);
    // The first claim's lease is still on the row; this PATCH sets none.
    expect((await Task.findOne({ podId: pod._id, taskId: 'TASK-1' }).lean()).claimExpiresAt).toBeInstanceOf(Date);
    // Seats only: a person's Start is still a PATCH, and a seat's writes no lease, so it is refused before any write or record.
    expect((await request(app).patch(`/api/v1/tasks/${pod._id}/TASK-1`).set(as(AGENT_TOKEN)).send({ status: 'in_progress' })).status).toBe(400);
    await flushRecordWrites();
    const res = await read(generateTestToken(owner._id));
    const lines = res.text.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((l) => [l.kind, l.data])).toEqual([
      ['task.claimed', { leaseUntil: expect.any(String) }],
      ['task.released', { reason: 'blocked' }],
    ]);
  });

  it('refuses everyone else before any record byte is read', async () => {
    await claim();
    await flushRecordWrites();
    const readChain = jest.spyOn(repository, 'readChain');

    // Not a viewer of the pod: indistinguishable from no such record.
    expect(await read(generateTestToken(outsider._id))).toMatchObject({ status: 404, body: { error: 'record_not_found' } });
    // An admin can view the pod, but the lines carry approver ids verbatim.
    expect(await read(generateTestToken(admin._id))).toMatchObject({ status: 403, body: { error: 'record_requires_membership' } });
    // Task ids restart in each pod: TASK-1 belongs to the first pod only.
    expect(await read(generateTestToken(owner._id), otherPod._id)).toMatchObject({ status: 404 });
    expect(await read(generateTestToken(owner._id), pod._id, 'TASK-404')).toMatchObject({ status: 404 });
    expect(await read(generateTestToken(owner._id), 'not-a-pod')).toMatchObject({ status: 404 });
    expect(await read(generateTestToken(owner._id), pod._id, 'bad%20id')).toMatchObject({ status: 404 });
    expect((await request(app).get(`/api/pods/${pod._id}/record/tasks/TASK-1`)).status).toBe(401);
    // A pod the record is not enabled for serves nothing.
    process.env.RECORD_V1_PODS = String(otherPod._id);
    expect(await read(generateTestToken(owner._id))).toMatchObject({ status: 404 });
    expect(readChain).not.toHaveBeenCalled();

    // Removing a member removes their access on the next read.
    process.env.RECORD_V1_PODS = podIds().join(',');
    await Pod.updateOne({ _id: pod._id }, { $pull: { members: agent._id } });
    expect(await read(AGENT_TOKEN)).toMatchObject({ status: 404 });
    expect(readChain).not.toHaveBeenCalled();
  });

  it('answers a store outage with 503, never an empty record', async () => {
    jest.spyOn(repository, 'readChain').mockRejectedValueOnce(new repository.RecordStoreUnavailableError());
    expect(await read(generateTestToken(owner._id))).toMatchObject({ status: 503, body: { error: 'record_store_unavailable' } });
    jest.spyOn(repository, 'readChain').mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await read(generateTestToken(owner._id))).toMatchObject({ status: 503, body: { error: 'record_store_unavailable' } });
  });

  it('a failed record write leaves the board write as it was', async () => {
    jest.spyOn(repository, 'appendToChain').mockRejectedValueOnce(new Error('pg down'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await claim();
    await flushRecordWrites();
    expect(res.status).toBe(200);
    expect((await Task.findOne({ podId: pod._id, taskId: 'TASK-1' }).lean()).status).toBe('claimed');
    expect((await read(generateTestToken(owner._id))).headers['x-record-entries']).toBe('0');
  });

  it('writes nothing for a pod the record is not enabled for', async () => {
    process.env.RECORD_V1_PODS = String(otherPod._id);
    expect((await claim()).status).toBe(200);
    await flushRecordWrites();
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM record_chains WHERE pod_id = $1', [String(pod._id)]);
    expect(rows[0].n).toBe(0);
  });
});
