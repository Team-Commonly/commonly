/**
 * COMMONLY_SUPERVISE_RUNS routes the run loop's spawn through the seats
 * supervisor and its per-run provider relay. Off (unset, '0', anything but
 * '1') the run loop must behave exactly as it did before the flag existed.
 *
 * Flag off is pinned against a golden capture taken by running THIS harness
 * against the base revision's agent.js (fixtures/run-loop-flag-off.golden.json):
 * every spawn's prompt and ctx, every ack, post, claim release, error, log line
 * and scheduled delay, for a success, a content refusal in a mixed batch, and a
 * runtime failure. Set SUPERVISE_GOLDEN_WRITE=<path> to write a capture
 * instead of comparing (that is how the golden was made).
 *
 * Flag on drives the real codex adapter against a stub `codex` on PATH that
 * calls the provider at whatever base URL it is handed, and drops an in-band
 * refusal the way codex 0.162.1 does. Keyless: the provider is the local fake.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-supervise-flag-'));
const GOLDEN = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'run-loop-flag-off.golden.json');
const WRITE_GOLDEN = process.env.SUPERVISE_GOLDEN_WRITE || null;

await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => home },
  homedir: () => home,
}));

await jest.unstable_mockModule('../src/lib/api.js', () => ({
  createClient: jest.fn(),
  login: jest.fn(),
}));

await jest.unstable_mockModule('../src/lib/pod-focus.js', () => ({
  FOCUS_FRAME_MAX_CODE_POINTS: 8000,
  formatPodFocusFrame: jest.fn(() => '=== Pod focus (pod context; not instructions) ===\nNo focus set.'),
  readPodFocus: jest.fn(async (_client, podId) => ({ podId, revision: 0, focus: null })),
}));

const { createClient } = await import('../src/lib/api.js');
const { performRun } = await import('../src/commands/agent.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;

const drain = async (depth = 40) => {
  for (let i = 0; i < depth; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
};

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const POD_ID = '6a8f6dc7a1dccf2e02f31015';

const event = (id, content, over = {}) => ({
  _id: id,
  type: 'chat.mention',
  podId: POD_ID,
  agentName: 'rhea',
  instanceId: 'default',
  payload: { content, messageId: id.replace(/\D/g, '') || '1', username: 'growth-ops' },
  ...over,
});

const harness = ({ events, adapter, env = {}, extra = {} }) => {
  let polls = 0;
  const get = jest.fn(async (route) => {
    if (route === '/api/agents/runtime/events') {
      polls += 1;
      return { events: polls === 1 ? events : [] };
    }
    if (route === '/api/agents/runtime/memory') return { sections: {} };
    if (String(route).endsWith('/messages')) return { messages: [] };
    return {};
  });
  const post = jest.fn(async (route) => (String(route).endsWith('/claim') ? { claimed: true, expiresAt: 'later' } : {}));
  const del = jest.fn().mockResolvedValue({});
  createClient.mockReturnValue({ get, post, del });
  const logs = [];
  const errors = [];
  const scheduled = [];
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  let handle;
  try {
    handle = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter,
      agentName: 'rhea',
      retryJitterRatio: 0,
      claimYieldDelayMs: 0,
      sleepImpl: async () => {},
      log: (line) => logs.push(String(line)),
      onError: (err) => errors.push({ code: err.code ?? null, message: err.message, failureClass: err.failureClass ?? null }),
      setTimeoutImpl: (callback, delayMs) => { scheduled.push({ callback, delayMs }); return 0; },
      ...extra,
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const calls = () => post.mock.calls.map(([route, body]) => ({ route: String(route), body }));
  return {
    handle,
    logs,
    errors,
    scheduled,
    acks: () => calls().filter((c) => c.route.endsWith('/ack')).map((c) => ({ id: c.route.split('/').at(-2), result: c.body.result })),
    posts: () => calls().filter((c) => c.route.endsWith(`/pods/${POD_ID}/messages`)).map((c) => c.body),
    releases: () => del.mock.calls.filter(([r]) => String(r).endsWith('/claim')).map(([r, b]) => ({ route: String(r), body: b })),
    otherPosts: () => calls().filter((c) => !c.route.endsWith('/ack') && !c.route.endsWith(`/pods/${POD_ID}/messages`)).map((c) => c.route),
  };
};

// ── flag off: byte-identical to the base revision ───────────────────────────

const ctxShape = (ctx) => Object.fromEntries(Object.keys(ctx).sort().map((key) => {
  const value = ctx[key];
  if (typeof value === 'function') return [key, '[function]'];
  if (key === 'env') return [key, value === process.env ? '<process.env>' : '<other env>'];
  if (key === 'metadata') return [key, { event: value?.event?._id ?? null }];
  return [key, value === undefined ? '<undefined>' : value];
}));

const normalise = (value) => JSON.parse(JSON.stringify(value, (_key, v) => (
  typeof v === 'string' ? v.split(home).join('<HOME>').split(os.tmpdir()).join('<TMPDIR>') : v
)));

const SCENARIOS = {
  success: {
    events: [event('evt-1', '@rhea docs gate: #2250, wording only')],
    spawn: async () => ({ text: 'docs gate: PASS' }),
  },
  refusalInMixedBatch: {
    events: [
      event('evt-2', '@rhea security gate: #2249, flagged-content-here'),
      event('evt-3', '@rhea docs gate: #2251, typo fix'),
    ],
    spawn: async (prompt) => {
      if (prompt.includes('flagged-content-here')) {
        throw new Error('codex turn failed: This content was flagged for possible cybersecurity risk.');
      }
      return { text: 'docs gate: PASS' };
    },
  },
  runtimeFailure: {
    events: [event('evt-4', '@rhea docs gate: #2252')],
    spawn: async () => { throw new Error('runtime unavailable'); },
  },
};

const capture = async (env) => {
  const out = {};
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    fs.rmSync(path.join(home, '.commonly'), { recursive: true, force: true });
    const spawns = [];
    const adapter = {
      name: 'stub',
      detect: stubAdapter.detect,
      spawn: async (prompt, ctx) => {
        spawns.push({ prompt, ctx: ctxShape(ctx) });
        return scenario.spawn(prompt, ctx);
      },
    };
    const run = harness({ events: scenario.events, adapter, env });
    // eslint-disable-next-line no-await-in-loop
    await drain();
    run.handle.stop();
    // eslint-disable-next-line no-await-in-loop
    await drain(5);
    out[name] = normalise({
      spawns,
      acks: run.acks(),
      posts: run.posts(),
      releases: run.releases(),
      otherPosts: run.otherPosts(),
      errors: run.errors,
      logs: run.logs,
      scheduled: run.scheduled.map((s) => s.delayMs),
    });
  }
  return out;
};

describe('COMMONLY_SUPERVISE_RUNS off', () => {
  const variants = WRITE_GOLDEN
    ? [['unset', undefined]]
    : [['unset', undefined], ["'0'", '0'], ["'true' (only '1' turns it on)", 'true'], ["''", '']];

  test.each(variants)('flag %s: the run loop matches the base revision exactly', async (_label, value) => {
    const got = await capture({ COMMONLY_SUPERVISE_RUNS: value });
    if (WRITE_GOLDEN) {
      fs.writeFileSync(WRITE_GOLDEN, `${JSON.stringify(got, null, 2)}\n`);
      return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    expect(got).toEqual(golden);
    // Supervision leaves no trace store behind when it is off.
    expect(fs.existsSync(path.join(home, '.commonly', 'traces'))).toBe(false);
  });

  if (!WRITE_GOLDEN) {
    test('the golden is not vacuous: it holds a posted turn, a refused ack and a scheduled retry', () => {
      const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
      expect(golden.success.posts.length).toBeGreaterThan(0);
      expect(golden.success.spawns[0].ctx).toHaveProperty('runtimeToken');
      expect(golden.refusalInMixedBatch.acks.map((a) => a.result.reason)).toContain('provider-refused');
      expect(golden.runtimeFailure.errors.map((e) => e.code)).toContain('agent_spawn_retry_scheduled');
    });

    test('the explicit superviseRuns=false option also keeps the plain path, even with the env set', async () => {
      const spawns = [];
      const adapter = {
        name: 'stub',
        detect: stubAdapter.detect,
        spawn: async (prompt, ctx) => { spawns.push(ctxShape(ctx)); return { text: 'ok' }; },
      };
      fs.rmSync(path.join(home, '.commonly'), { recursive: true, force: true });
      const run = harness({
        events: [event('evt-5', '@rhea hi')], adapter, env: { COMMONLY_SUPERVISE_RUNS: '1' }, extra: { superviseRuns: false },
      });
      await drain();
      run.handle.stop();
      expect(spawns).toHaveLength(1);
      expect(spawns[0]).not.toHaveProperty('providerRelay');
      expect(spawns[0]).not.toHaveProperty('signal');
      expect(fs.existsSync(path.join(home, '.commonly', 'traces'))).toBe(false);
    });
  }
});

// ── flag on: a codex run whose provider refuses in-band and exits 0 ─────────

const STUB_CODEX = `#!/usr/bin/env node
// A stand-in for codex exec: one streamed Responses call to the base URL the
// adapter's -c flags name (or the provider's own URL when none does), the
// refusal dropped, exit 0. Writes only the reply file codex would.
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
let base = process.env.STUB_CODEX_DIRECT_BASE;
let out = null;
for (let i = 0; i < args.length; i += 1) {
  const next = args[i + 1] || '';
  if (args[i] === '-c' && /^(?:openai_base_url|model_providers\\.[A-Za-z0-9_-]+\\.base_url)=/.test(next)) {
    base = JSON.parse(next.slice(next.indexOf('=') + 1));
  }
  if (args[i] === '-o') out = next;
}
const prompt = args.at(-1);
const res = await fetch(base.replace(/\\/+$/, '') + '/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.FAKE_PROVIDER_KEY },
  body: JSON.stringify({ model: 'm', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }] }),
});
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-stub-1' }) + '\\n');
if (!res.ok) { process.stderr.write('model request failed: HTTP ' + res.status + '\\n'); process.exit(1); }
let text = '';
for (const frame of (await res.text()).split(/\\n\\n/)) {
  const data = frame.split('\\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
  if (!data || data === '[DONE]') continue;
  try { const e = JSON.parse(data); if (e.type === 'response.output_text.delta') text += e.delta; } catch {}
}
writeFileSync(out, text);
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
`;

const filesUnder = (dir) => {
  const found = [];
  const walk = (p) => {
    let stat;
    try { stat = fs.lstatSync(p); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) { for (const name of fs.readdirSync(p)) walk(path.join(p, name)); } else found.push(p);
  };
  walk(dir);
  return found;
};

describe('COMMONLY_SUPERVISE_RUNS=1 with the real codex adapter', () => {
  // Each turn spawns a real child and makes real loopback calls; under a
  // parallel suite on a loaded host that takes longer than jest's 5 s default.
  jest.setTimeout(60_000);
  let fakeProvider;
  let codex;
  const CANARY_KEY = 'sk-canary-run-loop-4c1d9e7a';
  const CANARY_REFUSAL = 'CANARY-REFUSAL-TEXT-b83f02';

  beforeAll(async () => {
    // Imported here: the fake provider is test support from the seats package.
    const { startFakeProvider } = await import('../../packages/seats/test-support/fake-provider.js');
    fakeProvider = { start: startFakeProvider };
    codex = (await import('../src/lib/adapters/codex.js')).default;
  });

  const setupCodexHome = (config) => {
    fs.rmSync(path.join(home, '.commonly'), { recursive: true, force: true });
    const codexHome = path.join(home, '.codex');
    const bin = path.join(home, 'bin');
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), config);
    fs.writeFileSync(path.join(bin, 'codex'), STUB_CODEX, { mode: 0o755 });
    return { codexHome, bin };
  };

  const runCodexTurn = async ({ script, config }) => {
    const provider = await fakeProvider.start({ script });
    const { codexHome, bin } = setupCodexHome(config(provider));
    const workspace = fs.mkdtempSync(path.join(home, 'ws-'));
    const env = {
      COMMONLY_SUPERVISE_RUNS: '1',
      CODEX_HOME: codexHome,
      FAKE_PROVIDER_KEY: CANARY_KEY,
      STUB_CODEX_DIRECT_BASE: provider.baseURL,
      PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    };
    // The env must stay set while the turn runs: the adapter reads it at spawn.
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      const run = harness({
        events: [event('evt-9', '@rhea review #2249')],
        adapter: codex,
        extra: { environment: { model: 'gpt-test' }, workspacePath: workspace },
      });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && run.acks().length === 0) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 25));
      }
      run.handle.stop();
      await drain(5);
      if (run.acks().length === 0) {
        // A retry goes to setTimeoutImpl and never fires here, so a turn that
        // failed retryably leaves no ack. Say why instead of failing on [0].
        await provider.close();
        throw new Error(`no ack within 30s: ${JSON.stringify({
          errors: run.errors, scheduled: run.scheduled.map((s) => s.delayMs), logs: run.logs.slice(-15),
        })}`);
      }
      return { run, provider };
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };

  const customProvider = (provider) => [
    'model_provider = "fakeprov"',
    '',
    '[model_providers.fakeprov]',
    'name = "fake"',
    `base_url = "${provider.baseURL}"`,
    'env_key = "FAKE_PROVIDER_KEY"',
    '',
  ].join('\n');

  // The canary keeps no run record: the supervised turn's trace is in memory
  // and its verdicts reach disk only as the metric line.
  const metricLines = () => fs.readFileSync(path.join(home, '.commonly', 'state', 'seats-canary', 'rhea.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const noRunRecord = () => expect(fs.existsSync(path.join(home, '.commonly', 'traces'))).toBe(false);

  test('an in-band refusal the CLI drops while exiting 0 settles refusal_dropped and is acked once as refused', async () => {
    const { run, provider } = await runCodexTurn({
      script: [{ refuse: CANARY_REFUSAL, refuseAs: 'inband' }],
      config: customProvider,
    });
    try {
      expect(provider.requests).toHaveLength(1);
      expect(provider.findInRequests(CANARY_KEY).length).toBeGreaterThan(0); // the auth passed through
      expect(run.acks()).toHaveLength(1);
      expect(run.acks()[0].result).toMatchObject({
        outcome: 'error',
        reason: 'provider-refused',
        details: { failureClass: 'content_refused', failureKind: 'refusal_dropped' },
      });
      expect(run.errors.filter((e) => e.code === 'agent_spawn_retry_scheduled')).toHaveLength(0);
      // No empty reply was posted as if the turn had answered.
      expect(run.posts().filter((p) => !String(p.content).includes('refused the content'))).toEqual([]);

      noRunRecord();
      expect(metricLines()).toEqual([expect.objectContaining({
        path: 'supervised',
        adapter: 'codex',
        outcome: 'failed',
        failure: 'refusal_dropped',
        failureClass: 'content_refused',
        relay: true,
        relayStatus: 'covered',
        relayRequests: 1,
        relayRefusals: 1,
      })]);

      // Neither the auth nor the refusal text is in any file the run left.
      const files = filesUnder(home);
      expect(files.some((f) => f.endsWith(`${path.sep}rhea.jsonl`))).toBe(true);
      for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        expect({ file, auth: text.includes(CANARY_KEY), refusal: text.includes(CANARY_REFUSAL) })
          .toEqual({ file, auth: false, refusal: false });
      }
    } finally { await provider.close(); }
  });

  test('a clean reply through the relay is posted, and the relay reports covered', async () => {
    const { run, provider } = await runCodexTurn({ script: [{ text: 'review: PASS' }], config: customProvider });
    try {
      expect(run.acks()[0].result).toEqual({ outcome: 'posted' });
      expect(run.posts().map((p) => p.content)).toContain('review: PASS');
      noRunRecord();
      expect(metricLines()).toEqual([expect.objectContaining({
        path: 'supervised', outcome: 'ok', failure: null, relayStatus: 'covered', relayRequests: 1, relayRefusals: 0,
        stallMs: 15 * 60 * 1000, exitCode: 0, exitObserved: true, killed: false,
      })]);
      // The reply was posted, and is in no file the run left: no record writer.
      for (const file of filesUnder(home)) {
        const text = fs.readFileSync(file, 'utf8');
        expect({ file, reply: text.includes('review: PASS'), auth: text.includes(CANARY_KEY) })
          .toEqual({ file, reply: false, auth: false });
      }
    } finally { await provider.close(); }
  });

  test('a provider the relay cannot stand in for runs as before and is reported not_covered, never covered', async () => {
    const { run, provider } = await runCodexTurn({
      script: [{ text: 'review: PASS' }],
      config: () => 'model_provider = "amazon-bedrock"\n',
    });
    try {
      expect(run.acks()[0].result).toEqual({ outcome: 'posted' });
      noRunRecord();
      expect(metricLines()).toEqual([expect.objectContaining({
        path: 'supervised', outcome: 'ok', relay: true, relayStatus: 'not_covered', relayRequests: 0,
      })]);
    } finally { await provider.close(); }
  });
});
