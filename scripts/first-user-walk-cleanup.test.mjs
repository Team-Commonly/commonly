// Run: node --test scripts/first-user-walk-cleanup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupRun } from './first-user-walk-cleanup.mjs';

const USER = 'user-walk';
const OTHER = 'user-other';

// A fake backend holding pods and one account. `stuck` names pods whose
// delete returns 200 but leaves them listed; `accountFails` makes the account
// delete return 500. Calls are recorded so the test can check the order.
const fakeBackend = ({ pods, stuck = new Set(), accountFails = false, deleteIgnored = false }) => {
  const state = { pods: [...pods], accountGone: false, calls: [] };
  const api = async (method, path) => {
    state.calls.push(`${method} ${path.split('?')[0]}`);
    if (method === 'GET' && path === '/api/pods') {
      return { status: 200, data: state.pods.map((p) => ({ ...p })) };
    }
    const podMatch = path.match(/^\/api\/pods\/([^/?]+)$/);
    if (method === 'GET' && podMatch) {
      const pod = state.pods.find((p) => String(p._id) === podMatch[1]);
      return pod ? { status: 200, data: pod } : { status: 404, data: {} };
    }
    if (method === 'DELETE' && podMatch) {
      const id = podMatch[1];
      if (!stuck.has(id)) state.pods = state.pods.filter((p) => String(p._id) !== id);
      return { status: 200, data: {} };
    }
    if (method === 'DELETE' && path.startsWith('/api/registry/agents/')) {
      return { status: 200, data: {} };
    }
    if (method === 'DELETE' && path === '/api/users/me') {
      if (accountFails) return { status: 500, data: { error: 'boom' } };
      if (!deleteIgnored) state.accountGone = true;
      return { status: 200, data: {} };
    }
    if (method === 'POST' && path === '/api/auth/login') {
      return state.accountGone ? { status: 401, data: {} } : { status: 200, data: { token: 't' } };
    }
    return { status: 404, data: {} };
  };
  return { api, state };
};

const run = (backend, opts = {}) => cleanupRun({
  api: backend.api, token: 'tok', password: 'pw', email: 'walk@example.invalid', userId: USER, agentName: 'walk-x-agent', ...opts,
});

test('reports the bot members of each pod before the pod goes', async () => {
  const members = [{ _id: 'bot-agent', isBot: true }, { _id: USER, isBot: false }];
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: USER, members }] });
  const result = await run(backend);
  assert.equal(result.ok, true);
  assert.deepEqual(result.botIds, ['bot-agent']);
});

test('fails when the account still logs in after a 200 delete', async () => {
  const backend = fakeBackend({ pods: [], deleteIgnored: true });
  const result = await run(backend);
  assert.equal(result.ok, false);
  assert.ok(result.survivors.includes('account (still logs in)'), `survivors: ${result.survivors}`);
});

test('a clean run removes every pod the account created, then the account', async () => {
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: USER }, { _id: 'p2', createdBy: USER }] });
  const result = await run(backend);
  assert.equal(result.ok, true);
  assert.deepEqual(result.survivors, []);
  assert.equal(backend.state.pods.length, 0);
  assert.equal(backend.state.accountGone, true);
});

test('a pod the account did not create is never touched', async () => {
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: USER }, { _id: 'pub', createdBy: OTHER }] });
  const result = await run(backend);
  assert.equal(result.ok, true);
  assert.deepEqual(backend.state.pods.map((p) => p._id), ['pub']);
  assert.ok(!backend.state.calls.includes('DELETE /api/pods/pub'));
});

test('fails and names the pod when a delete leaves it listed', async () => {
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: USER }], stuck: new Set(['p1']) });
  const result = await run(backend);
  assert.equal(result.ok, false);
  assert.ok(result.survivors.some((s) => s.startsWith('pod:p1')), `survivors: ${result.survivors}`);
});

test('fails and names the account when its delete is refused', async () => {
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: USER }], accountFails: true });
  const result = await run(backend);
  assert.equal(result.ok, false);
  assert.ok(result.survivors.includes('account (delete 500)'), `survivors: ${result.survivors}`);
  assert.equal(backend.state.accountGone, false);
});

test('matches a populated createdBy object, not only a bare id', async () => {
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: { _id: USER, username: 'walk' } }] });
  const result = await run(backend);
  assert.equal(result.ok, true);
  assert.equal(backend.state.pods.length, 0);
});

test('removes a recorded pod the owner match misses, and checks it is gone', async () => {
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: { _id: OTHER } }] });
  const result = await run(backend, { podIds: ['p1'] });
  assert.equal(result.ok, true);
  assert.equal(backend.state.pods.length, 0);
});

test('fails and names a recorded pod that is still readable after delete', async () => {
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: { _id: OTHER } }], stuck: new Set(['p1']) });
  const result = await run(backend, { podIds: ['p1'] });
  assert.equal(result.ok, false);
  assert.ok(result.survivors.includes('pod:p1 (still readable)'), `survivors: ${result.survivors}`);
});
