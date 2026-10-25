const request = require('supertest');
const express = require('express');
const { randomUUID } = require('crypto');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
jest.mock('../../middleware/auth', () => (req, res, next) => {
  req.userId = req.get('x-test-user');
  if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
  next();
});
jest.mock('../../services/toolBrokerService', () => ({ allToolDefinitions: () => [] }));
jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn() }));
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const Installable = require('../../models/Installable');
const Installation = require('../../models/InstallableInstallation');
const PodAsset = require('../../models/PodAsset');
const router = require('../../routes/playbooks');
let app; let human; let bot; let outsider; let pod;
const previousFlag = process.env.PLAYBOOKS_ENABLED;
const draft = () => ({ title: 'Manual work', sourceText: 'Procedure source', definition: { v: 1,
  roles: [{ key: 'owner', kind: 'person' }],
  steps: [{ key: 'work', title: 'Do it manually', role: 'owner', do: 'Do it and complete the row' }],
  done: [{ says: 'Done', step: 'work', check: 'done' }],
} });
beforeAll(async () => { await setupMongoDb(); app = express(); app.use(express.json()); app.use('/api/pods', router); });
afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb(); delete process.env.PLAYBOOKS_ENABLED;
  human = await User.create({ username: 'owner', email: 'owner@example.test', password: 'test-password' });
  outsider = await User.create({ username: 'outsider', email: 'outsider@example.test', password: 'test-password', role: 'admin' });
  bot = await User.create({ username: 'bot', email: 'bot@example.test', password: 'test-password', isBot: true, botType: 'agent' });
  pod = await Pod.create({ name: 'Private workflow', members: [human._id, bot._id], createdBy: human._id,
    publicRead: false, joinPolicy: 'invite-only' });
});
afterEach(() => { if (previousFlag === undefined) delete process.env.PLAYBOOKS_ENABLED;
  else process.env.PLAYBOOKS_ENABLED = previousFlag; });
const base = () => `/api/pods/${pod._id}/playbooks`;
const api = (method, path, user = human) => request(app)[method](path).set('x-test-user', String(user._id));
const create = async () => { const result = await api('post', base()).send(draft()); expect(result.status).toBe(201); return result.body.id; };
const turnOn = (id, on = true) => api('post', `${base()}/${id}/state`)
  .send({ on, bindings: { owner: String(human._id) } });

test('human create/list/options operate on an Off pod copy and source skill', async () => {
  const id = await create();
  expect((await Installation.findById(id)).status).toBe('paused');
  expect(await PodAsset.countDocuments({ podId: pod._id, type: 'skill' })).toBe(1);
  const listed = await api('get', base());
  expect(listed.status).toBe(200); expect(listed.headers['cache-control']).toBe('no-store');
  expect(listed.body.playbooks).toHaveLength(1);
  expect(listed.body.playbooks[0]).toMatchObject({ id, title: 'Manual work', sourceText: 'Procedure source', on: false });
  expect(listed.body.playbooks[0]).not.toHaveProperty('claimId');
  const options = await api('get', `${base()}/options`);
  expect(options.body.triggers).toEqual(['run', 'schedule']);
  expect(options.body.members).toEqual(expect.arrayContaining([expect.objectContaining({ userId: String(human._id), kind: 'person' })]));
});
test('bots, outsiders, departed creators and missing auth cannot read or create playbooks', async () => {
  await create();
  expect((await request(app).get(base())).status).toBe(401);
  for (const user of [bot, outsider]) {
    expect((await api('get', base(), user)).status).toBe(403);
    expect((await api('post', base(), user).send(draft())).status).toBe(403);
  }
  await Pod.updateOne({ _id: pod._id }, { $pull: { members: human._id } });
  const departed = await api('get', base());
  expect(departed.status).toBe(403); expect(departed.body).not.toHaveProperty('playbooks');
  expect(await Installable.countDocuments()).toBe(1);
});
test('On is rollout-gated, Run is On-gated and a repeated request ID reuses its run', async () => {
  const id = await create();
  expect((await turnOn(id)).body.error).toBe('playbooks_disabled');
  expect((await Installation.findById(id)).status).toBe('paused');
  process.env.PLAYBOOKS_ENABLED = 'true';
  expect((await api('post', `${base()}/${id}/run`).send({ input: '' })).body.error).toBe('playbook_off');
  expect((await turnOn(id)).status).toBe(200);
  const body = { input: 'Manual input', requestId: randomUUID() };
  const first = await api('post', `${base()}/${id}/run`).send(body);
  const retry = await api('post', `${base()}/${id}/run`).send(body);
  expect(first.status).toBe(200); expect(retry.body).toEqual(first.body);
  expect(await Task.countDocuments()).toBe(2);
  const runs = await api('get', `${base()}/${id}/runs`);
  expect(runs.body.runs).toHaveLength(1);
  expect(runs.body.runs[0].notes).toContain('Manual input');
  expect(runs.body.runs[0].steps[0]).toMatchObject({ taskId: first.body.stepTaskId, guard: 'person', assignee: 'owner' });
});
test('a successful edit pauses an On workflow and saves its new contract and source', async () => {
  const id = await create(); process.env.PLAYBOOKS_ENABLED = 'true';
  await turnOn(id);
  const changed = { ...draft(), title: 'Revised work', sourceText: 'New source',
    schedule: { cron: '0 9 * * 1', timezone: 'America/Los_Angeles' } };
  const result = await api('put', `${base()}/${id}`).send(changed);
  expect(result.status).toBe(200); expect(result.body.on).toBe(false);
  const listed = await api('get', base());
  expect(listed.body.playbooks[0]).toMatchObject({ title: 'Revised work', sourceText: 'New source',
    schedule: changed.schedule, on: false, onBy: null });
  expect((await Installation.findById(id)).status).toBe('paused');
});
test('an open run prevents editing or rebinding through upper-case object IDs', async () => {
  const id = await create(); process.env.PLAYBOOKS_ENABLED = 'true'; await turnOn(id);
  await api('post', `${base()}/${id.toUpperCase()}/run`).send({ input: 'Hold', requestId: randomUUID() });
  const installation = await Installation.findById(id);
  const original = await Installable.findOne({ installableId: installation.installableId }).lean();
  const before = await Task.find().lean();
  const edit = await api('put', `${base()}/${id.toUpperCase()}`).send({ ...draft(), title: 'Changed' });
  expect(edit.status).toBe(409); expect(edit.body.error).toBe('run_open');
  const on = await turnOn(id.toUpperCase());
  expect(on.status).toBe(409); expect(on.body.error).toBe('run_open');
  expect(await Installable.findById(original._id).lean()).toEqual(original);
  expect(await Task.find().lean()).toEqual(before);
  expect((await Installation.findById(id)).status).toBe('active');
});
test.each([
  () => ({ ...draft(), source: 'builtin' }), () => ({ ...draft(), schedule: false }),
  () => ({ ...draft(), schedule: { cron: '*/5 * * * *', timezone: 'UTC' } }),
  () => ({ ...draft(), bindings: { undeclared: 'aaaaaaaaaaaaaaaaaaaaaaaa' } }),
  () => ({ ...draft(), sourceText: { path: '/private/file' } }), () => [],
])('invalid draft input is refused without creating records (%#)', async (input) => {
  const result = await api('post', base()).send(input());
  expect(result.status).toBe(400);
  expect(await Installable.countDocuments()).toBe(0); expect(await Installation.countDocuments()).toBe(0);
  expect(await PodAsset.countDocuments()).toBe(0);
});
test('a foreign pod installation never leaks through a guessed installation ID', async () => {
  const id = await create();
  const other = await Pod.create({ name: 'Other', members: [human._id], createdBy: human._id });
  const result = await api('get', `/api/pods/${other._id}/playbooks/${id}/runs`);
  expect(result.status).toBe(404); expect(result.body).not.toHaveProperty('runs');
  expect((await api('get', `/api/pods/${other._id}/playbooks`)).body.playbooks).toEqual([]);
});
