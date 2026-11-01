// Run: node --test scripts/first-user-walk-cleanup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupRun } from './first-user-walk-cleanup.mjs';

const USER = 'user-walk';
const OTHER = 'user-other';

// A fake backend holding pods and one account. Options:
//   stuck            pods whose delete returns 200 but leaves them listed
//   accountFails     the account delete returns 500
//   deleteIgnored    the account delete returns 200 but the account still logs in
//   lookupFails      pods whose GET /api/pods/:id returns 500
//   listFails        GET /api/pods returns 500
//   seatFails        the registry seat uninstall returns 500
//   deprovisionFails POST /api/hosted/deprovision returns 500
//   throwOn          a DELETE to this pod path throws (network error)
// Calls are recorded so the test can check the order.
const fakeBackend = ({
  pods, stuck = new Set(), accountFails = false, deleteIgnored = false,
  lookupFails = new Set(), listFails = false, seatFails = false, deprovisionFails = false, throwOn = null,
}) => {
  const state = { pods: [...pods], accountGone: false, calls: [] };
  const api = async (method, path) => {
    const bare = path.split('?')[0];
    state.calls.push(`${method} ${bare}`);
    if (method === 'GET' && path === '/api/pods') {
      if (listFails) return { status: 500, data: {} };
      return { status: 200, data: state.pods.map((p) => ({ ...p })) };
    }
    const podMatch = path.match(/^\/api\/pods\/([^/?]+)$/);
    if (method === 'GET' && podMatch) {
      if (lookupFails.has(podMatch[1])) return { status: 500, data: { error: 'boom' } };
      const pod = state.pods.find((p) => String(p._id) === podMatch[1]);
      return pod ? { status: 200, data: pod } : { status: 404, data: {} };
    }
    if (method === 'DELETE' && podMatch) {
      const id = podMatch[1];
      if (throwOn === `/api/pods/${id}`) throw new Error('socket hang up');
      if (!stuck.has(id)) state.pods = state.pods.filter((p) => String(p._id) !== id);
      return { status: 200, data: {} };
    }
    if (method === 'DELETE' && path.startsWith('/api/registry/agents/')) {
      if (seatFails) return { status: 500, data: {} };
      return { status: 200, data: {} };
    }
    if (method === 'POST' && bare === '/api/hosted/deprovision') {
      if (deprovisionFails) return { status: 500, data: {} };
      return { status: 200, data: { deprovisioned: true } };
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
  const members = [{ _id: 'bot-agent', isBot: true, username: 'walk-x-agent' }, { _id: USER, isBot: false, username: 'walk' }];
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

test('a failed pod lookup is a survivor, and the pod is not deleted', async () => {
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: USER }], lookupFails: new Set(['p1']) });
  const result = await run(backend);
  assert.equal(result.ok, false);
  assert.ok(result.survivors.includes('pod:p1 (lookup 500)'), `survivors: ${result.survivors}`);
  assert.ok(!backend.state.calls.includes('DELETE /api/pods/p1'), 'a pod whose members are unknown must not be deleted');
});

test('a failed pod list is a survivor, not an empty list of pods', async () => {
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: USER }], listFails: true });
  const result = await run(backend);
  assert.equal(result.ok, false);
  assert.ok(result.survivors.includes('pods (list failed)'), `survivors: ${result.survivors}`);
});

test('a refused seat uninstall is a survivor', async () => {
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: USER }], seatFails: true });
  const result = await run(backend);
  assert.equal(result.ok, false);
  assert.ok(result.survivors.some((s) => s.startsWith('seat:p1 (uninstall 500)')), `survivors: ${result.survivors}`);
});

test('the hosted runtime is stopped before the seat and pods go', async () => {
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: USER }] });
  await run(backend);
  const calls = backend.state.calls;
  assert.ok(calls.indexOf('POST /api/hosted/deprovision') < calls.indexOf('DELETE /api/pods/p1'));
});

test('a refused deprovision is a survivor', async () => {
  const backend = fakeBackend({ pods: [], deprovisionFails: true });
  const result = await run(backend);
  assert.equal(result.ok, false);
  assert.ok(result.survivors.includes('hosted:walk-x-agent (deprovision 500)'), `survivors: ${result.survivors}`);
});

test('bot ids are reported before each pod is deleted, so a later throw keeps them', async () => {
  const members = [{ _id: 'bot-scout', isBot: true, username: 'scout-uabc123' }];
  const backend = fakeBackend({
    pods: [{ _id: 'p1', createdBy: USER, members }, { _id: 'p2', createdBy: USER, members }],
    throwOn: '/api/pods/p2',
  });
  const reported = [];
  await assert.rejects(run(backend, { onBotIds: (podId, bots) => reported.push([podId, bots]) }), /socket hang up/);
  assert.deepEqual(reported[0], ['p1', ['bot-scout']]);
  assert.ok(backend.state.calls.indexOf('DELETE /api/pods/p1') > backend.state.calls.indexOf('GET /api/pods/p1'));
});

test('the shared default bot is never recorded, even though it is a pod member', async () => {
  const members = [
    { _id: 'shared-bot', isBot: true, username: 'commonly-bot' },
    { _id: 'scout', isBot: true, username: 'scout-uabc123' },
    { _id: 'agent', isBot: true, username: 'walk-x-agent' },
    { _id: USER, isBot: false, username: 'walk' },
  ];
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: USER, members }] });
  const result = await run(backend);
  assert.equal(result.ok, true);
  assert.deepEqual(result.botIds, ['scout', 'agent']);
  assert.ok(!result.botIds.includes('shared-bot'));
});

test('shared sign-in account: the run never deletes the account', async () => {
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: USER }] });
  const result = await run(backend, { podIds: ['p1'], deleteAccount: false });
  assert.equal(result.ok, true);
  assert.equal(backend.state.accountGone, false);
  assert.ok(!backend.state.calls.includes('DELETE /api/users/me'), `calls: ${backend.state.calls}`);
  assert.ok(!backend.state.calls.includes('POST /api/auth/login'), 'no login check when the account is kept');
});

test('shared sign-in account: only the recorded pods go, not other pods the account owns', async () => {
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: USER }, { _id: 'old', createdBy: USER }] });
  const result = await run(backend, { podIds: ['p1'], deleteAccount: false });
  assert.equal(result.ok, true);
  assert.deepEqual(backend.state.pods.map((p) => p._id), ['old']);
  assert.ok(!backend.state.calls.includes('DELETE /api/pods/old'));
});

test('shared sign-in account: a recorded pod that survives is still a survivor', async () => {
  const backend = fakeBackend({ pods: [{ _id: 'p1', createdBy: USER }], stuck: new Set(['p1']) });
  const result = await run(backend, { podIds: ['p1'], deleteAccount: false });
  assert.equal(result.ok, false);
  assert.ok(result.survivors.includes('pod:p1 (still readable)'), `survivors: ${result.survivors}`);
});
