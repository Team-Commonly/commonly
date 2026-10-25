process.env.PG_HOST = '';
process.env.AUTO_INSTALL_DEFAULT_AGENT = '0';
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const Pod = require('../../models/Pod');
const Message = require('../../models/Message');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');
const owner = new mongoose.Types.ObjectId(), outsider = new mongoose.Types.ObjectId();
jest.mock('../../middleware/auth', () => (req, res, next) => {
  req.userId = req.header('x-test-user'); req.user = { id: req.userId }; next();
});
const routes = require('../../routes/pods');
const app = express(); app.use(express.json()); app.use('/api/pods', routes);
const pod = (overrides = {}) => Pod.create({ name: 'parent policy', type: 'team', createdBy: owner, members: [owner], ...overrides });
const send = (method, url, body, user = owner) => request(app)[method](url).set('x-test-user', String(user)).send(body);
beforeAll(setupMongoDb);
beforeEach(clearMongoDb);
afterAll(closeMongoDb);

describe.each(['create', 'update'])('%s parent policy through HTTP and real Mongo', (mode) => {
  let child;
  beforeEach(async () => { child = await pod(); });
  const unchanged = async () => {
    if (mode === 'create') expect(await Pod.countDocuments({ name: 'child' })).toBe(0);
    else expect((await Pod.findById(child._id).lean()).parentPod).toBeNull();
  };
  const change = (parentPod, user = owner) => mode === 'create'
    ? send('post', '/api/pods', { name: 'child', type: 'team', parentPod }, user)
    : send('patch', `/api/pods/${child._id}/parent`, { parentPod }, user);
  test.each(['bad-id', '', [], { $ne: null }])('malformed parent %p returns a coded 400', async (value) => {
    const response = await change(value);
    expect(response.status).toBe(400); expect(response.body.code).toBe('invalid_parent_pod'); await unchanged();
  });
  test('missing parent returns 400 rather than persisting an orphan', async () => {
    const response = await change(String(new mongoose.Types.ObjectId()));
    expect(response.status).toBe(400); expect(response.body.code).toBe('parent_pod_not_found'); await unchanged();
  });
  test('a public parent still requires write membership', async () => {
    const parent = await pod({ createdBy: outsider, members: [outsider], publicRead: true });
    expect(parent.members.map(String)).not.toContain(String(owner));
    const response = await change(String(parent._id));
    expect(response.status).toBe(403); expect(response.body.code).toBe('parent_pod_write_denied'); await unchanged();
  });
  test.each(['agent-room', 'agent-dm', 'agent-admin'])('%s cannot be a parent', async (type) => {
    const parent = await pod({ type }); const response = await change(String(parent._id));
    expect(response.status).toBe(400); expect(response.body.code).toBe('invalid_parent_pod_type'); await unchanged();
  });
  test('a child cannot be used as a parent', async () => {
    const root = await pod(), parent = await pod({ parentPod: root._id });
    const response = await change(String(parent._id));
    expect(response.status).toBe(400); expect(response.body.code).toBe('pod_parent_depth'); await unchanged();
  });
  test('a write member can attach to a root and detach with null', async () => {
    const parent = await pod(); const response = await change(String(parent._id));
    expect(response.status).toBe(200);
    const id = response.body._id;
    expect(String((await Pod.findById(id)).parentPod)).toBe(String(parent._id));
    expect((await send('patch', `/api/pods/${id}/parent`, { parentPod: null })).status).toBe(200);
    expect((await Pod.findById(id).lean()).parentPod).toBeUndefined();
  });
});

test('update refuses self cycles, two-pod cycles and moving a parent under another root', async () => {
  const root = await pod(), child = await pod({ parentPod: root._id }), other = await pod();
  const self = await send('patch', `/api/pods/${root._id}/parent`, { parentPod: String(root._id) });
  expect(self.status).toBe(400); expect(self.body.code).toBe('pod_parent_cycle');
  expect((await Pod.findById(root._id).lean()).parentPod).toBeNull();
  for (const parentPod of [String(child._id), String(other._id)]) {
    const response = await send('patch', `/api/pods/${root._id}/parent`, { parentPod });
    expect(response.status).toBe(400); expect(response.body.code).toBe('pod_parent_depth');
    expect((await Pod.findById(root._id).lean()).parentPod).toBeNull();
  }
});
test('write membership in the parent does not allow changing another owner’s child', async () => {
  const root = await pod(), child = await pod({ createdBy: outsider, members: [owner, outsider] });
  const response = await send('patch', `/api/pods/${child._id}/parent`, { parentPod: String(root._id) });
  expect(response.status).toBe(403); expect(response.body.code).toBe('pod_admin_required');
  expect((await Pod.findById(child._id).lean()).parentPod).toBeNull();
});
test('update requires an explicit parent field and a well-formed child ID', async () => {
  const child = await pod();
  const missing = await send('patch', `/api/pods/${child._id}/parent`, {});
  expect(missing.status).toBe(400); expect(missing.body.code).toBe('parent_pod_required');
  const malformed = await send('patch', '/api/pods/not-an-id/parent', { parentPod: null });
  expect(malformed.status).toBe(400); expect(malformed.body.code).toBe('invalid_pod_id');
});
test('deleting a parent detaches its children and preserves their content and unrelated links', async () => {
  const root = await pod(), child = await pod({ parentPod: root._id }), other = await pod();
  const cousin = await pod({ parentPod: other._id });
  const message = await Message.create({ podId: child._id, userId: owner, content: 'keep me' });
  const response = await send('delete', `/api/pods/${root._id}`);
  expect(response.status).toBe(200); expect(await Pod.findById(root._id)).toBeNull();
  expect((await Pod.findById(child._id).lean()).parentPod).toBeUndefined();
  expect(await Message.findById(message._id)).not.toBeNull();
  expect(String((await Pod.findById(cousin._id)).parentPod)).toBe(String(other._id));
});
