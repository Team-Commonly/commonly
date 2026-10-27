import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRunEnv } from '../src/valet/env.js';
import { validateGrant } from '../src/valet/grant.js';
import { appendEntry } from '../src/record/format.js';

const REAL = 'sk-ant-real-key-0123456789abcdefghijklmnop';
// A held value with no key shape: the secret scan reads every branch commit.
const HELD = 'held-held-held-held';
const recorder = () => { const events = []; return { events, emit: (type, data) => events.push({ type, data }) }; };
const withScratch = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'seats-inject-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

// Stack's counterexample: an allowed upstream that echoes the auth it received,
// in a response header and in the streamed body, split into 7-byte chunks.
const startEchoUpstream = async () => {
  const seen = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const got = req.headers['x-api-key'] || '';
      seen.push({ url: req.url, key: got, authorization: req.headers.authorization });
      res.writeHead(401, { 'content-type': 'text/event-stream', 'x-echo': `received ${got}` });
      const body = `data: {"error":"invalid x-api-key: ${got}"}\n\n`;
      let i = 0;
      const tick = () => {
        if (i >= body.length) { res.end(); return; }
        res.write(body.slice(i, i + 7)); i += 7; setImmediate(tick);
      };
      tick();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
};

// The child does what Claude Code does: send its env key as x-api-key to the base URL.
const CHILD = `
fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'content-type': 'application/json' }, body: '{}',
}).then(async (res) => {
  process.stdout.write(JSON.stringify({ status: res.status, echo: res.headers.get('x-echo'), body: await res.text(), env: process.env }));
}).catch((err) => { process.stdout.write(JSON.stringify({ error: String(err) })); });`;
// Async on purpose: the proxy and the upstream live on this process's event
// loop, so a spawnSync child would wait on a server that can never answer.
const runChild = (env) => new Promise((resolve, reject) => {
  execFile(process.execPath, ['-e', CHILD], { env, encoding: 'utf8', timeout: 15000 }, (error, stdout, stderr) => {
    if (error) { reject(new Error(`child failed: ${error.message}\n${stderr}`)); return; }
    resolve({ raw: stdout, ...JSON.parse(stdout) });
  });
});

test('echo canary: an injected key reaches the provider, never the child, even when the provider echoes it', () => withScratch(async (root) => {
  const upstream = await startEchoUpstream();
  const trace = recorder();
  const run = await prepareRunEnv({
    grant: { credentials: [{ name: 'ANTHROPIC_API_KEY', from: 'env', inject: true }] },
    baseEnv: { ANTHROPIC_API_KEY: REAL, PATH: process.env.PATH },
    upstreams: { ANTHROPIC_API_KEY: { baseURL: upstream.url, wire: 'anthropic-messages' } },
    root,
    trace,
  });
  try {
    assert.notEqual(run.env.ANTHROPIC_API_KEY, REAL);
    assert.ok(!JSON.stringify(run.env).includes(REAL), 'the run env never holds the real key');
    assert.equal(run.injected.ANTHROPIC_API_KEY.wire, 'anthropic-messages');
    assert.match(run.injected.ANTHROPIC_API_KEY.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const seen = await runChild({ ...run.env, ANTHROPIC_BASE_URL: run.injected.ANTHROPIC_API_KEY.baseURL.replace(/\/$/, '') });
    // The provider got the real key, in the header its wire uses.
    assert.deepEqual(upstream.seen.map((r) => [r.url, r.key, r.authorization]), [['/v1/messages', REAL, undefined]]);
    // The echo came back redacted in the header and in the chunked body; the child saw nothing of the key.
    assert.equal(seen.status, 401);
    assert.equal(seen.echo, 'received [redacted]');
    assert.equal(seen.body, 'data: {"error":"invalid x-api-key: [redacted]"}\n\n');
    assert.ok(!seen.raw.includes(REAL), 'the child output never carries the real key');
    assert.equal(seen.env.ANTHROPIC_API_KEY, run.env.ANTHROPIC_API_KEY, 'the child holds only the proxy token');
    assert.deepEqual(trace.events, [{
      type: 'credential.granted', data: { names: ['ANTHROPIC_API_KEY'], injected: ['ANTHROPIC_API_KEY'] },
    }]);
  } finally {
    await run.cleanup();
    await upstream.close();
  }
  // cleanup() closed the proxy: the run's token now reaches nothing.
  const after = await runChild({ PATH: process.env.PATH, ANTHROPIC_API_KEY: 'x', ANTHROPIC_BASE_URL: run.injected.ANTHROPIC_API_KEY.baseURL.replace(/\/$/, '') });
  assert.match(after.error, /fetch failed/);
}));

test('the record is told to scrub the proxy token as well as the real key', () => withScratch(async (root) => {
  const upstream = await startEchoUpstream();
  const registered = [];
  const trace = { ...recorder(), redact: (values) => registered.push(...values) };
  const run = await prepareRunEnv({
    grant: { credentials: [{ name: 'GH_TOKEN', from: 'env' }, { name: 'OPENAI_API_KEY', from: 'env', inject: true }] },
    baseEnv: { GH_TOKEN: HELD, OPENAI_API_KEY: REAL },
    upstreams: { OPENAI_API_KEY: { baseURL: `${upstream.url}/v1` } },
    root,
    trace,
  });
  try {
    assert.notEqual(run.env.OPENAI_API_KEY, REAL);
    assert.deepEqual(registered, [HELD, REAL, run.env.OPENAI_API_KEY]);
  } finally {
    await run.cleanup();
    await upstream.close();
  }
}));

test('a held credential and an injected one in the same run: the record says which is which', () => withScratch(async (root) => {
  const upstream = await startEchoUpstream();
  const trace = recorder();
  const run = await prepareRunEnv({
    grant: { credentials: [{ name: 'GH_TOKEN', from: 'env' }, { name: 'OPENAI_API_KEY', from: 'env', inject: true }] },
    baseEnv: { GH_TOKEN: HELD, OPENAI_API_KEY: REAL },
    upstreams: { OPENAI_API_KEY: { baseURL: `${upstream.url}/v1` } },
    root,
    trace,
  });
  try {
    assert.equal(run.env.GH_TOKEN, HELD);
    assert.notEqual(run.env.OPENAI_API_KEY, REAL);
    assert.equal(run.injected.OPENAI_API_KEY.wire, 'openai-chat', 'the wire defaults to openai-chat');
    assert.deepEqual(Object.keys(run.injected), ['OPENAI_API_KEY']);
    assert.deepEqual(trace.events[0].data, { names: ['GH_TOKEN', 'OPENAI_API_KEY'], injected: ['OPENAI_API_KEY'] });
  } finally {
    await run.cleanup();
    await upstream.close();
  }
}));

test('a run with nothing injected keeps the old record shape and an empty injected map', () => withScratch(async (root) => {
  const trace = recorder();
  const run = await prepareRunEnv({ grant: { credentials: [{ name: 'OPENAI_API_KEY', from: 'env' }] }, baseEnv: { OPENAI_API_KEY: REAL }, root, trace });
  try {
    assert.equal(run.env.OPENAI_API_KEY, REAL);
    assert.deepEqual(run.injected, {});
    assert.deepEqual(trace.events, [{ type: 'credential.granted', data: { names: ['OPENAI_API_KEY'] } }]);
  } finally { await run.cleanup(); }
}));

test('inject with no upstream is denied before the value is resolved, and leaves no HOME', () => withScratch(async (root) => {
  const trace = recorder();
  let resolved = 0;
  await assert.rejects(prepareRunEnv({
    grant: { credentials: [{ name: 'VAULT_KEY', from: 'resolver', inject: true }] },
    resolveSecret: async () => { resolved += 1; return REAL; },
    root,
    trace,
  }), (error) => error.kind === 'credential_denied' && /no upstream/.test(error.message) && !error.message.includes(REAL));
  assert.equal(resolved, 0);
  assert.deepEqual(trace.events, [{ type: 'credential.denied', data: { name: 'VAULT_KEY', reason: 'no_upstream' } }]);
  assert.equal(spawnSync('ls', ['-A', root], { encoding: 'utf8' }).stdout, '');
}));

test('a later credential failing closes the proxies already started', () => withScratch(async (root) => {
  const openServers = () => process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;
  const before = openServers();
  const upstream = await startEchoUpstream();
  const trace = { emit: () => {} };
  await assert.rejects(prepareRunEnv({
    grant: { credentials: [{ name: 'OPENAI_API_KEY', from: 'env', inject: true }, { name: 'GONE', from: 'env' }] },
    baseEnv: { OPENAI_API_KEY: REAL },
    upstreams: { OPENAI_API_KEY: { baseURL: `${upstream.url}/v1` } },
    root,
    trace,
  }), /credential_denied/);
  await upstream.close();
  // The proxy's port was never handed out, so count listening servers instead.
  // A closed server's handle leaves the list a few ticks after close() resolves;
  // a leaked one never does.
  for (let tick = 0; tick < 50 && openServers() > before; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(openServers(), before, 'no proxy server is left open');
}));

test('grant: inject must be a boolean; false and absent both mean held', () => {
  assert.throws(() => validateGrant({ credentials: [{ name: 'K', from: 'env', inject: 'yes' }] }), /inject must be true or false/);
  assert.deepEqual({ ...validateGrant({ credentials: [{ name: 'K', from: 'env', inject: false }] }).credentials[0] }, { name: 'K', from: 'env' });
  assert.deepEqual({ ...validateGrant({ credentials: [{ name: 'K', from: 'env', inject: true }] }).credentials[0] }, { name: 'K', from: 'env', inject: true });
});

test('record: credential.granted.injected holds names only, and only names that were granted', () => {
  const ENV = { runId: 'run-inject-0001', taskId: 'TASK-7', podId: 'pod-a' };
  const granted = (data) => appendEntry(null, { ...ENV, ts: '2026-10-26T03:00:00.000Z', kind: 'credential.granted', data });
  assert.match(granted({ names: ['A_KEY', 'B_KEY'], injected: ['B_KEY'] }), /"injected":\["B_KEY"\]/);
  assert.throws(() => granted({ names: ['A_KEY'], injected: ['B_KEY'] }), /subset of names/);
  assert.throws(() => granted({ names: ['A_KEY'], injected: ['sk-live-0123456789'] }), /NAMES/);
});
