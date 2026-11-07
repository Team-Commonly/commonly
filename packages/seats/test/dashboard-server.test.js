import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard, isLoopbackHost, parseArgs } from '../src/dashboard/server.js';
import { startDashboard as exported, renderRuns } from '../src/index.js';
import { seedStore, writeCompat, BASE } from '../test-support/dashboard-fixtures.js';

let root;
let store;
let dash;
let compatPath;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'seats-dash-srv-'));
  store = seedStore(join(root, 'trace'), { evil: true });
  compatPath = writeCompat(root, { evil: true });
  dash = await startDashboard({ store, compatPath, now: () => BASE + 210000 });
});
after(async () => {
  await dash?.close();
  rmSync(root, { recursive: true, force: true });
});

// node:http rather than fetch, because fetch will not let a test set Host.
const get = (path, { method = 'GET', headers = {}, base = dash.url } = {}) => new Promise((resolve, reject) => {
  const req = request(`${base}${path}`, { method, headers }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.end();
});

test('binds to loopback on an ephemeral port and is exported from the package', () => {
  assert.match(dash.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(exported, startDashboard);
  assert.equal(typeof renderRuns, 'function');
});

test('the three pages answer 200 with HTML', async () => {
  const runs = await get('/');
  assert.equal(runs.status, 200);
  assert.match(runs.headers['content-type'], /^text\/html; charset=utf-8/);
  assert.match(runs.body, /run-stuck-03/);
  assert.match(runs.body, /class="alert"/);
  const stuckOnly = await get('/?outcome=stuck');
  assert.doesNotMatch(stuckOnly.body, /href="\/runs\/run-ok-0001"/);
  assert.doesNotMatch((await get('/?refresh=0')).body, /<script>/);

  const detail = await get('/runs/run-stuck-03');
  assert.equal(detail.status, 200);
  assert.match(detail.body, /liveness\.stalled/);

  const compat = await get('/compat');
  assert.equal(compat.status, 200);
  assert.match(compat.body, /opencode@1\.19\.0/);
});

test('unknown or invalid run ids and unknown paths are 404', async () => {
  for (const path of ['/runs/run-nope-99', '/runs/..%2F..%2Fetc', '/runs/%E0%A4%A', '/runs/a', '/nope', '/api/runs/run-nope-99', '/api/nope']) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
  }
  assert.deepEqual(JSON.parse((await get('/api/runs/run-nope-99')).body), { error: 'No such run' });
});

test('anything but GET or HEAD is 405', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const res = await get('/', { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, 'GET, HEAD');
  }
  assert.equal((await get('/', { method: 'HEAD' })).status, 200);
});

test('every response carries the security headers', async () => {
  for (const [path, method] of [['/', 'GET'], ['/runs/run-ok-0001', 'GET'], ['/compat', 'GET'], ['/api/runs', 'GET'], ['/nope', 'GET'], ['/', 'POST']]) {
    const { headers } = await get(path, { method });
    assert.equal(headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'", path);
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['referrer-policy'], 'no-referrer');
  }
});

test('JSON twins serve the same data', async () => {
  const runs = JSON.parse((await get('/api/runs')).body);
  assert.deepEqual(runs.runs.map((r) => r.runId).sort(), ['run-failed-02', 'run-live-0004', 'run-ok-0001', 'run-stuck-03']);
  const stuck = JSON.parse((await get('/api/runs?outcome=stuck')).body);
  assert.deepEqual(stuck.runs.map((r) => r.runId), ['run-stuck-03']);
  const run = await get('/api/runs/run-ok-0001');
  assert.match(run.headers['content-type'], /^application\/json/);
  const parsed = JSON.parse(run.body);
  assert.equal(parsed.runId, 'run-ok-0001');
  assert.equal(parsed.events.at(-1).type, 'run.settled');
  const compat = JSON.parse((await get('/api/compat')).body);
  assert.equal(compat.rows.length, 2);
});

test('served HTML escapes hostile trace and compat text', async () => {
  for (const path of ['/runs/run-ok-0001', '/compat']) {
    const { body } = await get(path);
    assert.doesNotMatch(body, /<script>alert/, path);
    assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, path);
  }
});

test('a request naming a non-loopback Host is refused (DNS rebinding)', async () => {
  assert.equal((await get('/', { headers: { host: 'evil.example:80' } })).status, 421);
  assert.equal((await get('/', { headers: { host: 'localhost:1234' } })).status, 200);
});

test('a non-loopback bind is refused unless allowRemote is passed', async () => {
  // A server that starts when it should not is closed before failing, so a regression fails instead of hanging.
  const refused = (opts) => startDashboard(opts).then(async (d) => { await d.close(); return 'started'; }, (e) => e.message);
  assert.match(await refused({ store, host: '0.0.0.0' }), /refusing to bind 0\.0\.0\.0/);
  assert.match(await refused({ store, host: '192.168.1.10' }), /allowRemote/);
  assert.match(await refused({}), /trace store/);
  const remote = await startDashboard({ store, host: '0.0.0.0', allowRemote: true });
  try {
    const port = new URL(remote.url).port;
    const res = await get('/', { base: `http://127.0.0.1:${port}`, headers: { host: 'dash.example' } });
    assert.equal(res.status, 200, 'allowRemote also lifts the Host check');
  } finally { await remote.close(); }
  assert.deepEqual(['127.0.0.1', '127.8.0.1', '::1', '[::1]', 'localhost', '0.0.0.0', '10.0.0.1', 'localhost.evil.com', ''].map(isLoopbackHost),
    [true, true, true, true, true, false, false, false, false]);
});

test('compat page and API report a missing or broken results file', async () => {
  const missing = await startDashboard({ store, compatPath: join(root, 'absent.json') });
  const broken = join(root, 'broken.json');
  writeFileSync(broken, '{not json');
  const bad = await startDashboard({ store, compatPath: broken });
  const none = await startDashboard({ store });
  try {
    const m = await get('/compat', { base: missing.url });
    assert.equal(m.status, 200);
    assert.match(m.body, /No results file at/);
    assert.equal((await get('/api/compat', { base: missing.url })).status, 404);
    assert.match((await get('/compat', { base: bad.url })).body, /Could not parse/);
    assert.match((await get('/compat', { base: none.url })).body, /No compatibility results/);
  } finally { await Promise.all([missing.close(), bad.close(), none.close()]); }
});

test('a store that throws yields a 500 without a stack', async () => {
  const broken = await startDashboard({ store: { listRuns() { throw new Error('/secret/path exploded'); }, readRun() { return null; } } });
  try {
    const res = await get('/', { base: broken.url });
    assert.equal(res.status, 500);
    assert.doesNotMatch(res.body, /secret|exploded/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  } finally { await broken.close(); }
});

test('CLI arguments parse and refuse junk', () => {
  assert.deepEqual(parseArgs(['--root', '/t', '--compat', 'r.json', '--port', '8080']), { root: '/t', compat: 'r.json', port: 8080, host: '127.0.0.1', allowRemote: false });
  assert.throws(() => parseArgs([]), /--root/);
  assert.throws(() => parseArgs(['--root', '/t', '--port', 'x']), /--port/);
  assert.throws(() => parseArgs(['--root', '/t', '--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--root']), /needs a value/);
});
