const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../../utils/testUtils');
const mongoose = require('mongoose');
const RoomGrant = require('../../../models/RoomGrant');
const Task = require('../../../models/Task');
const Pod = require('../../../models/Pod');
const service = require('../../../services/roomGrantService');

const POD = new mongoose.Types.ObjectId().toString();
const OTHER_POD = new mongoose.Types.ObjectId().toString();
const AGENT = new mongoose.Types.ObjectId().toString();
const binding = { taskId: 'TASK-1', podId: POD };
const input = (overrides = {}) => ({
  connectionId: 'connection', installationId: 'installation', target: { kind: 'pod', id: POD },
  tools: ['issues.read'], writeMode: 'read', audience: [AGENT],
  expiresAt: new Date(Date.now() + 3600000), brokerId: 'broker', binding, ...overrides,
});
const use = (grant, overrides = {}) => service.assertGrantUsable({
  grantId: grant.grantId, agentUserId: AGENT, currentMemberIds: [AGENT],
  ...overrides,
});

beforeAll(setupMongoDb);
afterEach(clearMongoDb);
afterAll(closeMongoDb);

beforeEach(async () => {
  await Pod.create({ _id: POD, name: 'Task pod', createdBy: AGENT, members: [AGENT] });
  await Task.create({ podId: POD, taskNum: 1, taskId: 'TASK-1', title: 'Investigate issue', status: 'claimed',
    claimedBy: AGENT, claimExpiresAt: new Date(Date.now() + 1800000) });
});

test('unbound grants retain their audience and expiry behavior without task context', async () => {
  const grant = await service.mintGrant(input({ binding: undefined }));
  await expect(use(grant)).resolves.toBeTruthy();
});

test.each([
  { taskId: 'TASK-404', podId: POD },
  { taskId: 'TASK-1', podId: OTHER_POD },
  { taskId: 'TASK-1' },
  { taskId: '', podId: POD },
])('invalid or foreign task binding cannot mint a grant: %p', async (invalid) => {
  await expect(service.mintGrant(input({ binding: invalid }))).rejects.toMatchObject({ code: expect.any(String) });
  expect(await RoomGrant.countDocuments()).toBe(0);
});

test('a binding records endsOn task.done, the only v1 value, and refuses any other', async () => {
  const grant = await service.mintGrant(input());
  expect(grant.binding.toObject()).toEqual({ ...binding, endsOn: 'task.done' });
  await expect(service.mintGrant(input({ binding: { ...binding, endsOn: 'task.done' } }))).resolves.toBeTruthy();
  for (const endsOn of ['expiresAt', 'task.closed', null]) {
    // eslint-disable-next-line no-await-in-loop
    await expect(service.mintGrant(input({ binding: { ...binding, endsOn } })))
      .rejects.toMatchObject({ code: 'invalid_task_binding' });
  }
  expect(await RoomGrant.countDocuments()).toBe(2);
});

test('closed tasks cannot mint and a stale read cannot make a grant usable after close/reopen', async () => {
  const grant = await service.mintGrant(input());
  await Task.updateOne({ podId: POD, taskId: 'TASK-1' }, { $set: { status: 'done' }, $inc: { grantEpoch: 1 } });
  await expect(use(grant)).rejects.toMatchObject({ code: 'task_closed' });
  await expect(service.mintGrant(input())).rejects.toMatchObject({ code: 'task_closed' });
  await Task.updateOne({ podId: POD, taskId: 'TASK-1' }, { $set: { status: 'claimed' } });
  await expect(use(grant)).rejects.toMatchObject({ code: 'task_closed' });
});

test('a task binding is inherited by attenuation and expiry remains a ceiling', async () => {
  const parent = await service.mintGrant(input());
  const child = await service.attenuateGrant({ parentGrantId: parent.grantId, expiresAt: new Date(Date.now() + 7200000) });
  expect(child.binding.toObject()).toEqual({ ...binding, endsOn: 'task.done' });
  expect(child.taskEpoch).toBe(parent.taskEpoch);
  expect(child.expiresAt.getTime()).toBe(parent.expiresAt.getTime());
  await expect(service.attenuateGrant({ parentGrantId: parent.grantId, binding: null }))
    .rejects.toMatchObject({ code: 'grant_not_attenuated' });
  await expect(service.attenuateGrant({ parentGrantId: parent.grantId, binding: { taskId: 'TASK-2', podId: POD } }))
    .rejects.toMatchObject({ code: 'grant_not_attenuated' });
});

test('the close hook revokes bound descendants, once, without touching another pod or unbound grants', async () => {
  const parent = await service.mintGrant(input());
  const child = await service.attenuateGrant({ parentGrantId: parent.grantId });
  const unbound = await service.mintGrant(input({ binding: undefined }));
  await service.revokeTaskGrants({ ...binding, closedEpoch: 1 });
  expect((await RoomGrant.findById(parent._id)).revokedAt).toBeInstanceOf(Date);
  expect((await RoomGrant.findById(child._id)).revocationReason).toBe('task.done');
  expect((await RoomGrant.findById(unbound._id)).revokedAt).toBeNull();
  await expect(service.revokeTaskGrants({ ...binding, closedEpoch: 1 })).resolves.toBe(0);
});


test('only the authenticated current claimant may use a task-bound grant', async () => {
  const grant = await service.mintGrant(input());
  await expect(use(grant)).resolves.toBeTruthy();
  await Task.updateOne({ taskId: binding.taskId }, { $set: { claimedBy: 'another-agent' } });
  await expect(use(grant)).rejects.toMatchObject({ code: 'task_claim_required' });
});

test.each(['pending', 'blocked', 'lapsed', 'missing'])('refuses a %s claim before tool use', async (state) => {
  const grant = await service.mintGrant(input());
  if (state === 'missing') await Task.deleteOne({ taskId: binding.taskId });
  else await Task.updateOne({ taskId: binding.taskId }, state === 'lapsed'
    ? { $set: { claimExpiresAt: new Date(Date.now() - 1) } }
    : { $set: { status: state } });
  await expect(use(grant)).rejects.toMatchObject({ code: state === 'missing' ? 'task_not_found' : 'task_claim_required' });
});

test('closing one pod never revokes a same-number task in another pod or a post-reopen grant', async () => {
  const oldGrant = await service.mintGrant(input());
  await Task.updateOne({ taskId: binding.taskId, podId: POD }, { $inc: { grantEpoch: 1 } });
  const newGrant = await service.mintGrant(input());
  await Task.create({ podId: OTHER_POD, taskNum: 1, taskId: 'TASK-1', title: 'Other pod task', status: 'claimed',
    claimedBy: AGENT, claimExpiresAt: new Date(Date.now() + 60000) });
  const otherGrant = await service.mintGrant(input({ target: { kind: 'pod', id: OTHER_POD }, binding: { taskId: 'TASK-1', podId: OTHER_POD } }));
  await service.revokeTaskGrants({ ...binding, closedEpoch: 1 });
  expect((await RoomGrant.findById(oldGrant._id)).revokedAt).toBeInstanceOf(Date);
  expect((await RoomGrant.findById(newGrant._id)).revokedAt).toBeNull();
  expect((await RoomGrant.findById(otherGrant._id)).revokedAt).toBeNull();
});


test('a display-name claim alone is never treated as an authenticated identity', async () => {
  const grant = await service.mintGrant(input());
  await Task.updateOne({ taskId: binding.taskId }, { $set: { claimedBy: 'default' } });
  await expect(use(grant)).rejects.toMatchObject({ code: 'task_claim_required' });
  await Task.updateOne({ taskId: binding.taskId }, { $set: { claimedByUserId: AGENT } });
  await expect(use(grant)).resolves.toBeTruthy();
});

test('expiry still refuses a bound grant while its task and claim remain live', async () => {
  const grant = await service.mintGrant(input());
  await RoomGrant.updateOne({ _id: grant._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  await expect(use(grant)).rejects.toMatchObject({ code: 'grant_expired' });
});

test('a close and reopen racing grant insertion cannot hand out the old capability', async () => {
  const create = RoomGrant.create.bind(RoomGrant);
  const spy = jest.spyOn(RoomGrant, 'create').mockImplementationOnce(async (...args) => {
    const row = await create(...args);
    // The close hook cannot have seen this insertion; the epoch still fences it.
    await Task.updateOne({ podId: POD, taskId: binding.taskId }, { $set: { status: 'done' }, $inc: { grantEpoch: 1 } });
    await Task.updateOne({ podId: POD, taskId: binding.taskId }, { $set: { status: 'claimed' } });
    return row;
  });
  await expect(service.mintGrant(input())).rejects.toMatchObject({ code: 'task_closed' });
  spy.mockRestore();
  const row = await RoomGrant.findOne({ 'binding.taskId': binding.taskId });
  expect(row.revokedAt).toBeInstanceOf(Date);
});

test('an unbound parent can be narrowed to a task without revoking the parent at close', async () => {
  const parent = await service.mintGrant(input({ binding: undefined }));
  const child = await service.attenuateGrant({ parentGrantId: parent.grantId, binding });
  await service.revokeTaskGrants({ ...binding, closedEpoch: 1 });
  await expect(use(child)).rejects.toMatchObject({ code: 'grant_revoked' });
  await expect(use(parent)).resolves.toBeTruthy();
});


test('seat bindings canonicalize pod ObjectIds so close revocation cannot miss an uppercase tuple', async () => {
  const grant = await service.mintGrant(input({ target: { kind: 'seat', id: AGENT },
    binding: { taskId: binding.taskId, podId: POD.toUpperCase() } }));
  expect(grant.binding.podId).toBe(POD);
  await expect(service.revokeTaskGrants({ ...binding, closedEpoch: 1 })).resolves.toBe(1);
});
