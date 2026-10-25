const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
jest.mock('../../services/toolBrokerService', () => ({ allToolDefinitions: () => [] }));
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const PodAsset = require('../../models/PodAsset');
const Installable = require('../../models/Installable');
const Installation = require('../../models/InstallableInstallation');
const { createOffPlaybook, setPlaybookOn, withPlaybookLock } = require('../../services/playbooks/store');
const { install } = require('../../services/installable/installableInstallationService');
let user; let pod; const originalFlag = process.env.PLAYBOOKS_ENABLED;
const draft = () => ({ title: 'Person workflow', sourceText: 'x'.repeat(9000), definition: {
  v: 1, roles: [{ key: 'owner', kind: 'person' }],
  steps: [{ key: 'work', title: 'Manual work', role: 'owner', do: 'Finish it by hand' }],
  done: [{ says: 'Finished', check: 'done', step: 'work' }],
} });
beforeAll(setupMongoDb); afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb(); delete process.env.PLAYBOOKS_ENABLED;
  user = await User.create({ username: 'owner', email: 'owner@example.test', password: 'test-password' });
  pod = await Pod.create({ name: 'Workflow', members: [user._id], createdBy: user._id });
});
afterEach(() => { if (originalFlag === undefined) delete process.env.PLAYBOOKS_ENABLED;
  else process.env.PLAYBOOKS_ENABLED = originalFlag; });
const create = () => createOffPlaybook(String(pod._id), String(user._id), draft());
const toggle = (row, on = true) => setPlaybookOn(String(pod._id), String(user._id), String(row._id), { owner: String(user._id) }, on);
test('creates an Off copy and stores the source in a pod skill with the reader limit', async () => {
  const row = await create();
  expect(row.status).toBe('paused');
  expect(row.components[0].status).toBe('paused');
  const asset = await PodAsset.findOne({ podId: pod._id, type: 'skill' }).lean();
  expect(asset.content).toHaveLength(8000);
  const book = await Installable.findOne({ installableId: row.installableId }).lean();
  expect(book.components[0].metadata.sourceText).toBeUndefined();
  expect(book.components[0].metadata.sourceSkill).toBe(row.installableId);
});
test('turn-on is refused while rollout flag is off, then preflights current bindings', async () => {
  const row = await create();
  await expect(toggle(row)).rejects.toMatchObject({ code: 'playbooks_disabled' });
  process.env.PLAYBOOKS_ENABLED = 'true';
  const active = await toggle(row);
  expect(active.status).toBe('active');
  expect(active.components[0].config.get('onBy')).toBe(String(user._id));
  expect((await Installation.findById(row._id)).claimId).toBeUndefined();
  await toggle(row, false);
  await Pod.updateOne({ _id: pod._id }, { $pull: { members: user._id } });
  await expect(toggle(row)).rejects.toMatchObject({ code: 'pod_membership_required' });
});
test('bots cannot create, and an open run prevents rebinding ownership', async () => {
  await User.updateOne({ _id: user._id }, { $set: { isBot: true } });
  await expect(create()).rejects.toMatchObject({ code: 'human_required' });
  await User.updateOne({ _id: user._id }, { $set: { isBot: false } });
  const row = await create(); process.env.PLAYBOOKS_ENABLED = 'true';
  await Task.create({ podId: pod._id, taskId: 'TASK-001', taskNum: 1, title: 'Run', source: 'playbook',
    guard: 'kernel', sourceRef: `playbook:${row._id}:manual:test` });
  await expect(setPlaybookOn(String(pod._id), String(user._id), String(row._id).toUpperCase(),
    { owner: String(user._id) }, true)).rejects.toMatchObject({ code: 'run_open' });
  expect((await Installation.findById(row._id)).status).toBe('paused');
});
test('connector install refuses a playbook before creating a projection', async () => {
  const row = await create();
  await expect(install({ installableId: row.installableId, installedBy: String(user._id), podId: String(pod._id) }))
    .rejects.toMatchObject({ code: 'install_projection_failed' });
  expect(await Installation.countDocuments()).toBe(1);
});

test('one installation lease serializes concurrent lifecycle operations and releases on errors', async () => {
  const row = await create();
  let entered; let release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const finish = new Promise((resolve) => { release = resolve; });
  const first = withPlaybookLock(String(pod._id), String(row._id), async () => { entered(); await finish; });
  await ready;
  try {
    await expect(withPlaybookLock(String(pod._id), String(row._id), async () => {}))
      .rejects.toMatchObject({ code: 'playbook_busy' });
  } finally { release(); await first; }
  await expect(withPlaybookLock(String(pod._id), String(row._id), async () => { throw new Error('failed'); }))
    .rejects.toThrow('failed');
  expect((await Installation.findById(row._id)).claimId).toBeUndefined();
});

test('failed draft creation removes only its own manifest and source asset', async () => {
  const existing = await create();
  const beforeBooks = await Installable.find().lean();
  const PodAsset = require('../../models/PodAsset');
  const beforeAssets = await PodAsset.find().lean();
  const failed = jest.spyOn(Installation, 'create').mockRejectedValueOnce(new Error('installation write failed'));
  try { await expect(create()).rejects.toThrow('installation write failed'); }
  finally { failed.mockRestore(); }
  expect(await Installable.find().lean()).toEqual(beforeBooks);
  expect(await PodAsset.find().lean()).toEqual(beforeAssets);
  expect((await Installation.findById(existing._id)).status).toBe('paused');
});
