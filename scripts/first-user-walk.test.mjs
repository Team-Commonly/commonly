// Run: node --test scripts/first-user-walk.test.mjs
// Drives runWalk through its production path against a fake backend, so the
// result file, the manifest and the exit code are the ones a real run writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runWalk } from './first-user-walk.mjs';

const PASSWORD = 'pw-secret-for-tests-9f2';
const USER_ID = 'user-walk';
const TOKEN = 'token-for-tests';
const SHARED_EMAIL = 'walk-shared@commonly.test';

// Options:
//   preview       status of the invite preview GET (500 forces a step failure)
//   create        'ok' creates the pod; 'error' returns 500 and creates nothing;
//                 'throw' fails the request; 'commit-then-error' commits, then returns 500
//   password      the password the fake account accepts
//   echoRegister  a refused register echoes the request body back, as a bad error would
//   seeded        the account already exists (the shared staging sign-in account)
const fakeBackend = ({
  preview = 200, create = 'ok', password = PASSWORD, echoRegister = false, seeded = false,
} = {}) => {
  const state = { accountExists: seeded, pods: [], lastAgent: null, calls: [] };
  const reply = (status, data) => ({ status, json: async () => data });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const p = u.pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    state.calls.push(`${method} ${p}`);

    if (method === 'POST' && p === '/api/auth/register') {
      if (echoRegister) return reply(400, { error: 'bad request', echo: body });
      state.accountExists = true;
      // The walk's own workspace pod, as signup creates it.
      state.pods.push({ _id: 'ws1', name: 'Workspace', createdBy: USER_ID, members: [] });
      return reply(201, {});
    }
    if (method === 'POST' && p === '/api/auth/login') {
      if (state.accountExists && body.password === password) {
        return reply(200, { token: TOKEN, user: { _id: USER_ID, role: 'user' } });
      }
      return reply(401, { code: 'bad_credentials' });
    }
    if (method === 'GET' && p === '/api/pods') return reply(200, state.pods.map((x) => ({ ...x })));
    if (method === 'POST' && p === '/api/pods') {
      if (create === 'throw') throw new Error('socket hang up');
      if (create === 'commit-then-error') {
        // The pod is committed, and the reply still says 500.
        state.pods.push({ _id: 'p-committed', name: body.name, createdBy: USER_ID, members: [] });
        return reply(500, { error: 'timeout after commit' });
      }
      if (create !== 'ok') return reply(500, { error: 'boom' });
      const pod = { _id: `p${state.pods.length + 1}`, name: body.name, createdBy: USER_ID, members: [] };
      state.pods.push(pod);
      return reply(201, pod);
    }
    const podMatch = p.match(/^\/api\/pods\/([^/]+)$/);
    if (podMatch) {
      const pod = state.pods.find((x) => x._id === podMatch[1]);
      if (method === 'GET') return pod ? reply(200, pod) : reply(404, {});
      if (method === 'DELETE') {
        state.pods = state.pods.filter((x) => x._id !== podMatch[1]);
        return reply(200, {});
      }
    }
    if (method === 'POST' && p === '/api/registry/install') return reply(200, {});
    if (method === 'POST' && p === '/api/hosted/provision') return reply(200, { provisioned: true });
    if (method === 'POST' && p === '/api/hosted/deprovision') return reply(404, {});
    if (method === 'DELETE' && p.startsWith('/api/registry/agents/')) return reply(404, {});
    if (method === 'POST' && /^\/api\/messages\//.test(p)) {
      state.lastAgent = (body.content.match(/@(\S+) walk check/) || [])[1] || null;
      return reply(200, { agentDelivery: { enqueued: 1 } });
    }
    if (method === 'GET' && /^\/api\/messages\//.test(p)) {
      const list = state.lastAgent ? [{ username: state.lastAgent, content: 'Sure, KINGFISHER.' }] : [];
      return reply(200, list);
    }
    if (method === 'POST' && /\/invites$/.test(p)) return reply(201, { token: 'inv1' });
    if (method === 'GET' && p === '/api/invites/inv1/preview') return reply(preview, { ok: true });
    if (method === 'DELETE' && p === '/api/users/me') {
      state.accountExists = false;
      return reply(200, {});
    }
    return reply(500, { error: `unhandled ${method} ${p}` });
  };
  return { fetchImpl, state };
};

const dirs = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'walk-729-'));
  return { stateDir: path.join(root, 'state'), resultPath: path.join(root, 'result', 'result.json') };
};

// Non-prod, non-staging by default: a run with no account given signs up, as the signup tests expect.
const run = (fetchImpl, { stateDir, resultPath }, { password = PASSWORD, env = {}, base = 'https://api-dev.commonly.test' } = {}) => runWalk({
  base,
  env: { COMMONLY_WALK_PASSWORD: password, ...env },
  fetchImpl,
  stateDir,
  resultPath,
  sha: 'abc123def',
  sleep: async () => {},
  log: () => {},
  error: () => {},
});

test('a clean run writes the machine-readable signal: every covered step passes, byo is not-covered, overall incomplete', async () => {
  const dirsFor = dirs();
  const { fetchImpl, state } = fakeBackend();
  const { exitCode, result } = await run(fetchImpl, dirsFor);

  assert.equal(exitCode, 2);
  assert.equal(result.overall, 'incomplete');
  assert.equal(result.sha, 'abc123def');
  assert.equal(result.mode, 'signup');
  assert.equal(result.cleanup.ok, true);
  assert.equal(result.cleanup.status, 'clean');

  const names = result.steps.map((s) => s.name);
  assert.deepEqual(names, ['signup', 'login', 'signup-workspace', 'first-pod', 'hosted-install', 'hosted-reply', 'invite-preview-api', 'byo-connect']);
  assert.ok(result.steps.filter((s) => s.name !== 'byo-connect').every((s) => s.result === 'pass'));
  assert.equal(result.steps.at(-1).result, 'not-covered');
  assert.match(result.steps.at(-1).reason, /not implemented/);

  // The file on disk is the one a consumer reads, and it is valid JSON.
  const onDisk = JSON.parse(readFileSync(dirsFor.resultPath, 'utf8'));
  assert.deepEqual(onDisk, result);
  // The account was removed; nothing survives.
  assert.equal(state.accountExists, false);
  assert.equal(state.pods.length, 0);
});

test('a forced step failure writes overall fail, names the step, and exits 1', async () => {
  const dirsFor = dirs();
  const { fetchImpl } = fakeBackend({ preview: 500 });
  const { exitCode, result } = await run(fetchImpl, dirsFor);

  assert.equal(exitCode, 1);
  assert.equal(result.overall, 'fail');
  const failed = result.steps.filter((s) => s.result === 'fail');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].name, 'invite-preview-api');
  assert.match(failed[0].reason, /invite preview 500/);
  // The byo step never ran after the failure.
  assert.equal(result.steps.some((s) => s.name === 'byo-connect'), false);
  assert.equal(result.cleanup.ok, true);
  assert.equal(JSON.parse(readFileSync(dirsFor.resultPath, 'utf8')).overall, 'fail');
});

test('the result and manifest never carry the password or the email', async () => {
  const dirsFor = dirs();
  const { fetchImpl } = fakeBackend({ preview: 500 });
  await run(fetchImpl, dirsFor);
  const result = readFileSync(dirsFor.resultPath, 'utf8');
  assert.equal(result.includes(PASSWORD), false);
  assert.equal(result.includes('@example.invalid'), false);
  const [manifestFile] = readdirSync(dirsFor.stateDir);
  const manifest = readFileSync(path.join(dirsFor.stateDir, manifestFile), 'utf8');
  assert.equal(manifest.includes(PASSWORD), false);
  assert.equal(manifest.includes('@example.invalid'), false);
});

test('a password with quotes and backslashes is scrubbed even when a body echoes it escaped', async () => {
  const dirsFor = dirs();
  const tricky = 'pa"ss\\word-7';
  const { fetchImpl } = fakeBackend({ password: tricky, echoRegister: true });
  const { result } = await run(fetchImpl, dirsFor, { password: tricky });

  const signup = result.steps.find((s) => s.name === 'signup');
  assert.equal(signup.result, 'fail');
  assert.match(signup.reason, /register 400/);
  // Neither the raw nor the JSON-escaped form of the password reaches the reason.
  assert.equal(signup.reason.includes('pa"ss'), false);
  assert.equal(signup.reason.includes('pa\\"ss'), false);
  assert.equal(signup.reason.includes('word-7'), false);
  assert.equal(readFileSync(dirsFor.resultPath, 'utf8').includes('word-7'), false);
});

test('signin mode never deletes the shared account, and the result says so', async () => {
  const dirsFor = dirs();
  const { fetchImpl, state } = fakeBackend({ seeded: true });
  const { exitCode, result } = await run(fetchImpl, dirsFor, {
    base: 'https://api-staging.commonly.me',
    env: { COMMONLY_WALK_EMAIL: SHARED_EMAIL },
  });

  assert.equal(result.mode, 'signin');
  assert.equal(result.cleanup.ok, true);
  assert.equal(exitCode, 2);
  assert.equal(state.calls.includes('DELETE /api/users/me'), false);
  assert.equal(state.calls.includes('POST /api/auth/register'), false);
  assert.equal(state.accountExists, true);
  // The run removed the pod it made, and nothing else.
  assert.equal(state.pods.length, 0);
  assert.equal(result.steps.some((s) => s.name === 'signup-workspace'), false);
});

test('prod signs in to the existing test account: no signup, the six covered steps, the account is never deleted', async () => {
  const dirsFor = dirs();
  const { fetchImpl, state } = fakeBackend({ seeded: true });
  const { exitCode, result } = await run(fetchImpl, dirsFor, {
    base: 'https://api.commonly.me',
    env: { COMMONLY_WALK_PROD_EMAIL: 'walk-test@commonly.test', COMMONLY_WALK_PROD_PASSWORD: PASSWORD },
  });

  assert.equal(result.mode, 'signin-prod');
  assert.equal(exitCode, 2);
  assert.equal(result.overall, 'incomplete');
  assert.deepEqual(result.steps.map((st) => st.name), ['login', 'first-pod', 'hosted-install', 'hosted-reply', 'invite-preview-api', 'byo-connect']);
  assert.equal(state.calls.includes('POST /api/auth/register'), false);
  assert.equal(state.calls.includes('DELETE /api/users/me'), false);
  assert.equal(state.accountExists, true);
  assert.equal(state.pods.length, 0);
  assert.equal(result.cleanup.ok, true);
});

test('prod without an existing test account is refused before any request', async () => {
  const dirsFor = dirs();
  const { fetchImpl, state } = fakeBackend({ seeded: true });
  const { exitCode, result } = await run(fetchImpl, dirsFor, { base: 'https://api.commonly.me' });

  assert.equal(exitCode, 1);
  assert.equal(result.mode, 'not-chosen');
  assert.equal(state.calls.length, 0);
});

test('a refused mode (shared email aimed at prod) makes no request, is not reported as signup, and exits 1', async () => {
  const dirsFor = dirs();
  const { fetchImpl, state } = fakeBackend({ seeded: true });
  const { exitCode, result } = await run(fetchImpl, dirsFor, { env: { COMMONLY_WALK_EMAIL: SHARED_EMAIL } });

  assert.equal(exitCode, 1);
  assert.equal(result.mode, 'not-chosen');
  assert.equal(result.overall, 'fail');
  assert.equal(result.cleanup.status, 'not-run');
  assert.equal(result.cleanup.ok, null);
  assert.equal(state.calls.length, 0);
  assert.equal(JSON.parse(readFileSync(dirsFor.resultPath, 'utf8')).mode, 'not-chosen');
});

test('ambiguous pod create with no match in the list: the manifest records the pod name as needs-admin-purge', async () => {
  const dirsFor = dirs();
  // The create answers 500 and commits nothing, and the list has no pod with
  // this run's name: the outcome cannot be checked, so the name is recorded.
  const { fetchImpl, state } = fakeBackend({ create: 'error' });
  const { exitCode, result } = await run(fetchImpl, dirsFor);

  assert.equal(exitCode, 1);
  assert.equal(result.steps.find((s) => s.name === 'first-pod').result, 'fail');
  assert.match(result.steps.find((s) => s.name === 'first-pod').reason, /pod create 500/);

  const [manifestFile] = readdirSync(dirsFor.stateDir);
  const manifest = JSON.parse(readFileSync(path.join(dirsFor.stateDir, manifestFile), 'utf8'));
  const podName = `${manifest.username} workspace`;
  assert.deepEqual(manifest.unresolvedPodNames, [podName]);
  assert.equal(manifest.status, 'needs-admin-purge');
  assert.ok(manifest.survivors.some((s) => s.includes(`"${podName}"`) && s.includes('create outcome unknown')));

  // The result file carries the same cleanup verdict.
  assert.equal(result.cleanup.status, 'needs-admin-purge');
  assert.equal(result.cleanup.ok, false);
  assert.equal(JSON.parse(readFileSync(dirsFor.resultPath, 'utf8')).overall, 'fail');
  // The walk removed its own account and the workspace pod it recorded.
  assert.equal(state.accountExists, false);
  assert.equal(state.pods.some((x) => x._id === 'ws1'), false);
});

test('a missing password fails before any request, reports cleanup as not-run, and still writes the signal', async () => {
  const dirsFor = dirs();
  const { fetchImpl } = fakeBackend();
  let requests = 0;
  const counting = (url, init) => { requests += 1; return fetchImpl(url, init); };
  const { exitCode, result } = await runWalk({
    base: 'https://api.commonly.me',
    env: {},
    fetchImpl: counting,
    ...dirsFor,
    sleep: async () => {},
    log: () => {},
    error: () => {},
  });
  assert.equal(exitCode, 1);
  assert.equal(result.overall, 'fail');
  assert.equal(result.cleanup.status, 'not-run');
  assert.equal(requests, 0);
  assert.equal(existsSync(dirsFor.resultPath), true);
});

test('a create that throws, with no match in the list, is recorded as unresolved and needs-admin-purge', async () => {
  const dirsFor = dirs();
  const { fetchImpl, state } = fakeBackend({ create: 'throw' });
  const { exitCode, result } = await run(fetchImpl, dirsFor);

  assert.equal(exitCode, 1);
  assert.match(result.steps.find((s) => s.name === 'first-pod').reason, /socket hang up/);
  const [manifestFile] = readdirSync(dirsFor.stateDir);
  const manifest = JSON.parse(readFileSync(path.join(dirsFor.stateDir, manifestFile), 'utf8'));
  assert.deepEqual(manifest.unresolvedPodNames, [`${manifest.username} workspace`]);
  assert.equal(manifest.status, 'needs-admin-purge');
  assert.equal(state.accountExists, false);
});

test('a create that commits then answers 500 is found by name, removed, and leaves no survivor', async () => {
  const dirsFor = dirs();
  const { fetchImpl, state } = fakeBackend({ create: 'commit-then-error' });
  const { exitCode, result } = await run(fetchImpl, dirsFor);

  assert.equal(exitCode, 1);
  assert.match(result.steps.find((s) => s.name === 'first-pod').reason, /pod create 500/);
  const [manifestFile] = readdirSync(dirsFor.stateDir);
  const manifest = JSON.parse(readFileSync(path.join(dirsFor.stateDir, manifestFile), 'utf8'));
  assert.deepEqual(manifest.unresolvedPodNames, []);
  assert.ok(manifest.podIds.includes('p-committed'));
  assert.equal(state.pods.some((x) => x._id === 'p-committed'), false);
  assert.equal(result.cleanup.status, 'clean');
});
