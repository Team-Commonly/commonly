/**
 * COMMONLY_SUPERVISE_RUNS routes the run loop's spawn through the seats
 * supervisor. Off (unset, '0', anything but '1') the run loop must behave
 * exactly as it did before the flag existed.
 *
 * Flag off is pinned against a golden capture taken by running THIS harness
 * against the base revision's agent.js (fixtures/run-loop-flag-off.golden.json):
 * every spawn's prompt and ctx, every ack, post, claim release, error, log line
 * and scheduled delay, for a success, a content refusal in a mixed batch, and a
 * runtime failure. Set SUPERVISE_GOLDEN_WRITE=<path> to write a capture
 * instead of comparing (that is how the golden was made).
 *
 * Flag on drives the real codex adapter against a stub `codex` on PATH that
 * calls the provider directly; there is no relay on this path. Keyless: the
 * provider is the local fake.
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
    // The turn budget is read from the host env; an operator's override must
    // not change what the golden pins.
    const run = harness({ events: scenario.events, adapter, env: { COMMONLY_AGENT_RUN_TIMEOUT_MS: undefined, ...env } });
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
    // Off, nothing is written: no trace store, and no canary line.
    expect(fs.existsSync(path.join(home, '.commonly', 'traces'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.commonly', 'state', 'seats-canary'))).toBe(false);
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
      expect(spawns[0]).not.toHaveProperty('signal');
      expect(fs.existsSync(path.join(home, '.commonly', 'traces'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.commonly', 'state', 'seats-canary'))).toBe(false);
    });
  }
});

// ── flag on: a codex run on the supervised path ─────────────────────────────

const STUB_CODEX = `#!/usr/bin/env node
// A stand-in for codex exec: one Chat Completions call straight to the
// provider, exit 0. Writes only the reply file codex would.
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
let out = null;
for (let i = 0; i < args.length; i += 1) if (args[i] === '-o') out = args[i + 1];
const prompt = args.at(-1);
const res = await fetch(process.env.STUB_CODEX_DIRECT_BASE.replace(/\\/+$/, '') + '/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.FAKE_PROVIDER_KEY },
  body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: prompt }] }),
});
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-stub-1' }) + '\\n');
if (!res.ok) { process.stderr.write('model request failed: HTTP ' + res.status + '\\n'); process.exit(1); }
const text = (await res.json()).choices[0].message.content;
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
  const CANARY_KEY = 'sk-canary-run-loop-4c1d9e7a';

  test('a clean reply is posted, the metric line says supervised and delivered, and nothing else reaches disk', async () => {
    const { startFakeProvider } = await import('../../packages/seats/test-support/fake-provider.js');
    const codex = (await import('../src/lib/adapters/codex.js')).default;
    const provider = await startFakeProvider({ defaultReply: 'review: PASS' });
    fs.rmSync(path.join(home, '.commonly'), { recursive: true, force: true });
    const codexHome = path.join(home, '.codex');
    const bin = path.join(home, 'bin');
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '');
    fs.writeFileSync(path.join(bin, 'codex'), STUB_CODEX, { mode: 0o755 });
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
      expect({ errors: run.errors, logs: run.logs.filter((l) => /supervised/.test(l)) }).toEqual({
        errors: [], logs: [expect.stringMatching(/^supervised runs ON for codex: stall=900000ms, .*trace=memory/)],
      });
      expect(run.acks()[0].result).toEqual({ outcome: 'posted' });
      expect(run.posts().map((p) => p.content)).toContain('review: PASS');
      expect(provider.requests.map((r) => r.authorization)).toEqual(['present']);
      expect(fs.existsSync(path.join(home, '.commonly', 'traces'))).toBe(false);
      const lines = fs.readFileSync(path.join(home, '.commonly', 'state', 'seats-canary', 'rhea.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(lines).toEqual([expect.objectContaining({
        path: 'supervised', adapter: 'codex', outcome: 'delivered', ok: true, failure: null,
        stallMs: 15 * 60 * 1000, exitCode: 0, exitObserved: true, killed: false,
      })]);
      // The reply was posted, and is in no file the run left: no record writer.
      for (const file of filesUnder(home)) {
        const text = fs.readFileSync(file, 'utf8');
        expect({ file, reply: text.includes('review: PASS'), auth: text.includes(CANARY_KEY) })
          .toEqual({ file, reply: false, auth: false });
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await provider.close();
    }
  });
});
