// Task-bound grants write record-v1 lines (ADR-033 §4): grant.issued on mint
// and attenuation, and grant.revoked {reason: task.done} when the task closes.
// The chain store is in memory with the repository's contract, as in
// recordService.test.js; every line must pass the shared reference verifier.
const mockChains = new Map();
jest.mock('../../../repositories/recordChainRepository', () => {
  const actual = jest.requireActual('../../../repositories/recordChainRepository');
  const key = (ref) => `${ref.podId}|${ref.taskId || ''}`;
  return {
    ...actual,
    appendToChain: jest.fn(async (ref, runId, eventKey, build) => {
      if (!mockChains.has(key(ref))) mockChains.set(key(ref), { runId, lines: [], keys: new Set() });
      const chain = mockChains.get(key(ref));
      if (chain.keys.has(eventKey)) return { appended: 0, duplicate: true };
      const { lines } = build(chain.lines[chain.lines.length - 1] || null, chain.runId);
      chain.lines.push(...lines);
      chain.keys.add(eventKey);
      return { appended: lines.length, duplicate: false };
    }),
  };
});

const mongoose = require('mongoose');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../../utils/testUtils');
const Task = require('../../../models/Task');
const Pod = require('../../../models/Pod');
const service = require('../../../services/roomGrantService');
const { flushRecordWrites } = require('../../../services/recordService');
const { verifyRecord } = require('../../../vendor/seats/src/record/format');

const POD = new mongoose.Types.ObjectId().toString();
const OWNER = new mongoose.Types.ObjectId().toString();
const AGENT = new mongoose.Types.ObjectId().toString();
const binding = { taskId: 'TASK-1', podId: POD };
const input = (overrides = {}) => ({
  connectionId: 'connection',
  installationId: 'installation',
  target: { kind: 'pod', id: POD },
  tools: ['issues.read'],
  writeMode: 'read',
  audience: [AGENT],
  expiresAt: new Date(Date.now() + 3600000),
  brokerId: 'broker',
  binding,
  issuer: { type: 'human', id: OWNER },
  ...overrides,
});
const chainLines = async (podId = POD, taskId = 'TASK-1') => {
  await flushRecordWrites();
  const chain = mockChains.get(`${podId}|${taskId}`);
  if (!chain) return [];
  expect(verifyRecord(chain.lines.map((line) => `${line}\n`).join(''))).toMatchObject({ ok: true });
  return chain.lines.map((line) => JSON.parse(line));
};
const close = async () => {
  const task = await Task.findOneAndUpdate(
    { podId: POD, taskId: 'TASK-1' },
    { $inc: { grantEpoch: 1 }, $set: { status: 'done' } },
    { new: true },
  );
  await service.onTaskClosed(task);
};

const env = process.env.RECORD_V1_PODS;
beforeAll(setupMongoDb);
afterEach(async () => { await flushRecordWrites(); await clearMongoDb(); });
afterAll(async () => {
  if (env === undefined) delete process.env.RECORD_V1_PODS;
  else process.env.RECORD_V1_PODS = env;
  await closeMongoDb();
});
beforeEach(async () => {
  mockChains.clear();
  process.env.RECORD_V1_PODS = POD;
  await Pod.create({
    _id: POD, name: 'Task pod', createdBy: OWNER, members: [OWNER, AGENT], 
  });
  await Task.create({
    podId: POD,
    taskNum: 1,
    taskId: 'TASK-1',
    title: 'Investigate issue',
    status: 'claimed',
    claimedBy: AGENT,
    claimExpiresAt: new Date(Date.now() + 1800000), 
  });
});

test('a bound mint writes grant.issued on its task chain, with the binding and the issuer', async () => {
  const grant = await service.mintGrant(input({ budget: { calls: 5 } }));
  const lines = await chainLines();
  expect(lines.map((l) => l.kind)).toEqual(['grant.issued']);
  expect(lines[0].actor).toEqual({ type: 'human', id: OWNER });
  expect(lines[0].data).toEqual({
    grantId: grant.grantId,
    scope: {
      connectionId: 'connection', tools: ['issues.read'], writeMode: 'read', budget: { calls: 5 }, audience: [AGENT], 
    },
    target: { kind: 'pod', id: POD },
    issuedBy: OWNER,
    expiresAt: grant.expiresAt.toISOString(),
    binding: { ...binding, endsOn: 'task.done' },
  });
});

test('an agent attenuating a bound grant is recorded as the agent, with the parent', async () => {
  const parent = await service.mintGrant(input());
  const child = await service.attenuateGrant({ parentGrantId: parent.grantId, issuer: { type: 'agent', id: AGENT } });
  const lines = await chainLines();
  expect(lines.map((l) => [l.kind, l.data.grantId])).toEqual([
    ['grant.issued', parent.grantId], ['grant.issued', child.grantId],
  ]);
  expect(lines[1].actor).toEqual({ type: 'agent', id: AGENT });
  expect(lines[1].data).toMatchObject({ parentGrantId: parent.grantId, issuedBy: AGENT });
});

test('an unbound mint has no task chain and writes nothing', async () => {
  await service.mintGrant(input({ binding: undefined }));
  await flushRecordWrites();
  expect(mockChains.size).toBe(0);
});

test('a mint refused after insertion writes no grant.issued', async () => {
  const realCreate = mongoose.model('RoomGrant').create.bind(mongoose.model('RoomGrant'));
  const spy = jest.spyOn(mongoose.model('RoomGrant'), 'create').mockImplementationOnce(async (doc) => {
    const created = await realCreate(doc);
    await Task.updateOne({ podId: POD, taskId: 'TASK-1' }, { $inc: { grantEpoch: 1 } });
    return created;
  });
  await expect(service.mintGrant(input())).rejects.toMatchObject({ code: 'task_closed' });
  spy.mockRestore();
  expect(await chainLines()).toEqual([]);
});

test('close writes one grant.revoked naming the bound grant and its descendant, as the board', async () => {
  const parent = await service.mintGrant(input());
  const child = await service.attenuateGrant({ parentGrantId: parent.grantId, issuer: { type: 'agent', id: AGENT } });
  await close();
  await service.onTaskClosed(await Task.findOne({ podId: POD, taskId: 'TASK-1' }));
  const revoked = (await chainLines()).filter((l) => l.kind === 'grant.revoked');
  expect(revoked).toHaveLength(1);
  expect(revoked[0].actor).toEqual({ type: 'system', id: 'board' });
  expect(revoked[0].data.reason).toBe('task.done');
  expect([...revoked[0].data.grantIds].sort()).toEqual([parent.grantId, child.grantId].sort());
});

test('a second close after reopen names only the grant issued since, not the one already revoked', async () => {
  const first = await service.mintGrant(input());
  await close();
  await Task.updateOne({ podId: POD, taskId: 'TASK-1' }, { $set: { status: 'claimed' } });
  const second = await service.mintGrant(input());
  await close();
  const revoked = (await chainLines()).filter((l) => l.kind === 'grant.revoked');
  expect(revoked.map((l) => l.data.grantIds)).toEqual([[first.grantId], [second.grantId]]);
});

test('a close with no live bound grant writes no grant.revoked', async () => {
  await service.mintGrant(input({ binding: undefined }));
  await close();
  expect((await chainLines()).filter((l) => l.kind === 'grant.revoked')).toEqual([]);
});

test('a pod outside RECORD_V1_PODS gets no lines, and its grants still revoke', async () => {
  process.env.RECORD_V1_PODS = new mongoose.Types.ObjectId().toString();
  const grant = await service.mintGrant(input());
  await close();
  await flushRecordWrites();
  expect(mockChains.size).toBe(0);
  expect((await mongoose.model('RoomGrant').findById(grant._id)).revocationReason).toBe('task.done');
});
