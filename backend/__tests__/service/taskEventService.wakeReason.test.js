// Persist real installations, principals, tasks and AgentEvents. Only the
// external WebSocket transport is stubbed; enqueue and folding run normally.
process.env.PG_HOST = '';
jest.mock('../../services/agentWebSocketService', () => ({ pushEvent: jest.fn() }));
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const AgentEvent = require('../../models/AgentEvent');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { notifyPodAgents } = require('../../services/taskEventService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

let pod;
let bots;
let row;
const actor = (name) => ({
  isAgent: true, userId: bots[name]._id, agentName: 'worker', instanceId: name,
});
const events = () => AgentEvent.find({ podId: pod._id }).lean();
const wake = (rows, name) => rows.find((event) => event.instanceId === name);
const assertDigest = (event) => {
  expect(event).toMatchObject({ deliveryMode: 'digest', payload: { boardDigest: true } });
  expect(event.payload.boardWake).toBeUndefined();
  expect(event.payload.wakeReason).toBeUndefined();
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
afterEach(clearMongoDb);
beforeEach(async () => {
  const users = await User.create(['old', 'new', 'third'].map((name) => ({
    username: `${name}-worker`, email: `${name}@wake.test`, password: 'Password123!',
    isBot: true, botType: 'agent', botMetadata: { agentName: 'worker', instanceId: name },
  })));
  bots = Object.fromEntries(users.map((user) => [user.botMetadata.instanceId, user]));
  pod = await Pod.create({ name: 'Wake routing', type: 'team', createdBy: bots.old._id, members: users.map((user) => user._id) });
  await AgentInstallation.create(users.map((user) => ({
    agentName: 'worker', instanceId: user.botMetadata.instanceId, podId: pod._id,
    version: '1.0.0', installedBy: bots.third._id,
    config: { runtime: { runtimeType: 'wrapper' }, wakeOnMessage: { enabled: false } },
  })));
  row = await Task.create({ podId: pod._id, taskId: 'TASK-1', taskNum: 1, title: 'Route work', status: 'claimed' });
});

async function change(fields, previous = {}, acting = actor('third')) {
  const changed = await Task.findByIdAndUpdate(row._id, { $set: fields }, { new: true }).lean();
  await notifyPodAgents(pod._id, changed, 'updated', acting, previous);
  return events();
}

it.each([
  ['assignee', { assignee: 'old' }, {}],
  ['claimant', () => ({ claimedBy: String(bots.old._id) }), {}],
  ['prevAssignee', {}, { assignee: 'old' }],
  ['prevClaimant', {}, () => ({ claimedBy: String(bots.old._id) })],
  ['dependentAssignee', { status: 'done' }, { status: 'claimed' }],
  ['dependentClaimant', { status: 'done' }, { status: 'claimed' }],
])('stamps %s on the addressed wake and leaves peers on digest', async (reason, fields, previous) => {
  if (reason.startsWith('dependent')) await Task.create({
    podId: pod._id, taskId: 'TASK-2', taskNum: 2, title: 'Waiting', status: 'blocked', dep: row.taskId,
    ...(reason === 'dependentAssignee' ? { assignee: 'old' } : { claimedBy: String(bots.old._id) }),
  });
  const rows = await change(typeof fields === 'function' ? fields() : fields,
    typeof previous === 'function' ? previous() : previous);
  expect(wake(rows, 'old')).toMatchObject({ deliveryMode: 'wake', payload: { boardWake: true, wakeReason: reason } });
  assertDigest(wake(rows, 'new'));
  expect(wake(rows, 'third')).toBeUndefined(); // actor never wakes itself
});

it.each(['assignee', 'claimant', 'prevAssignee', 'prevClaimant', 'dependentAssignee'])('prefers %s over later matching reasons', async (reason) => {
  const fields = { status: 'done' };
  const previous = { status: 'claimed' };
  if (reason === 'assignee') fields.assignee = 'old';
  if (['assignee', 'claimant'].includes(reason)) fields.claimedBy = String(bots.old._id);
  if (['assignee', 'claimant', 'prevAssignee'].includes(reason)) previous.assignee = 'old';
  if (reason !== 'dependentAssignee') previous.claimedBy = String(bots.old._id);
  await Task.create({ podId: pod._id, taskId: 'TASK-2', taskNum: 2, title: 'Waiting', status: 'blocked', dep: row.taskId, assignee: 'old', claimedBy: String(bots.old._id) });
  expect(wake(await change(fields, previous), 'old').payload.wakeReason).toBe(reason);
});

it.each(['prevAssignee', 'prevClaimant'])('a human hand-off sends %s only a digest', async (reason) => {
  const previous = reason === 'prevAssignee' ? { assignee: 'old' } : { claimedBy: String(bots.old._id) };
  const rows = await change({ assignee: 'new' }, previous, { isAgent: false });
  assertDigest(wake(rows, 'old'));
  expect(wake(rows, 'new').payload.wakeReason).toBe('assignee');
});

it.each(['prevAssignee', 'prevClaimant'])('a third-seat bot hand-off still wakes %s and the new owner', async (reason) => {
  const previous = reason === 'prevAssignee' ? { assignee: 'old' } : { claimedBy: String(bots.old._id) };
  const rows = await change({ assignee: 'new' }, previous);
  expect(wake(rows, 'old').payload.wakeReason).toBe(reason);
  expect(wake(rows, 'new').payload.wakeReason).toBe('assignee');
});

it.each(['assignee', 'claimant'])('acceptance by the new %s sends both previous owners only digests', async (role) => {
  const fields = role === 'assignee' ? { assignee: 'new' } : { claimedBy: String(bots.new._id) };
  const rows = await change(fields, { assignee: 'old', claimedBy: String(bots.third._id) }, actor('new'));
  assertDigest(wake(rows, 'old'));
  assertDigest(wake(rows, 'third'));
  expect(wake(rows, 'new')).toBeUndefined();
});

it('a human unassignment sends the previous owner only a digest', async () => {
  const rows = await change({ assignee: null }, { assignee: 'old' }, { isAgent: false });
  rows.forEach(assertDigest);
});

it('unknown actors retain previous-owner wakes', async () => {
  const rows = await change({}, { assignee: 'old' }, {});
  expect(wake(rows, 'old').payload.wakeReason).toBe('prevAssignee');
});

it('folds the latest reason into an undrained wake without creating a second wake', async () => {
  const first = await change({}, { assignee: 'old' });
  const original = wake(first, 'old');
  expect(original.payload.wakeReason).toBe('prevAssignee');
  const second = await change({ claimedBy: String(bots.old._id) });
  const folded = second.filter((event) => event.instanceId === 'old');
  expect(folded).toHaveLength(1);
  expect(String(folded[0]._id)).toBe(String(original._id));
  expect(folded[0].payload).toMatchObject({ wakeReason: 'claimant', boardChanges: 1 });
});
