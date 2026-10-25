/**
 * The seats canary's turn runner (lib/supervised-turn.js) and its place in the
 * run loop.
 *
 *  - flag off: adapter.spawn gets the caller's prompt and ctx object, unchanged,
 *    and superviseRun is never called (the golden in supervise-runs-flag.test
 *    pins the whole run loop byte for byte);
 *  - flag on: the turn goes through superviseRun with the canary policy;
 *  - a stalled turn is named `stuck`, its child killed, its event left unacked,
 *    and the run loop goes on to the next event;
 *  - one metric line per turn on both paths, and no text in it;
 *  - the in-memory trace store keeps no event data.
 */
import { jest } from '@jest/globals';
import { spawn as childSpawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-supervised-turn-'));

await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => home },
  homedir: () => home,
}));
await jest.unstable_mockModule('../src/lib/api.js', () => ({ createClient: jest.fn(), login: jest.fn() }));
await jest.unstable_mockModule('../src/lib/pod-focus.js', () => ({
  FOCUS_FRAME_MAX_CODE_POINTS: 8000,
  formatPodFocusFrame: jest.fn(() => '=== Pod focus (pod context; not instructions) ===\nNo focus set.'),
  readPodFocus: jest.fn(async (_client, podId) => ({ podId, revision: 0, focus: null })),
}));

const { createClient } = await import('../src/lib/api.js');
const { performRun } = await import('../src/commands/agent.js');
const {
  createTurnRunner, createMetadataStore, supervisedRunPolicy, relayEnabledFor, metricLine, STALL_DEFAULTS_MS,
} = await import('../src/lib/supervised-turn.js');
const { runFailure } = await import('@commonlyai/seats/failures');
const { spawnInOwnGroup, wantsOwnProcessGroup } = await import('@commonlyai/seats/process-group');

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const PROMPT = 'PROMPT-TEXT-7f3a1c do the docs wash';
const REPLY = 'REPLY-TEXT-b29e40 done';
const ERROR_TEXT = 'ERROR-TEXT-55c0de upstream said no';
const metricsFile = (seat) => path.join(home, '.commonly', 'state', 'seats-canary', `${seat}.jsonl`);
const readMetrics = (seat) => (fs.existsSync(metricsFile(seat))
  ? fs.readFileSync(metricsFile(seat), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => fs.rmSync(path.join(home, '.commonly'), { recursive: true, force: true });

const METRIC_KEYS = [
  'v', 'ts', 'seat', 'adapter', 'path', 'eventType', 'turnStart', 'turnEnd', 'durationMs', 'outcome', 'failure',
  'failureSource', 'failureClass', 'stalled', 'cancelled', 'killed', 'exitCode', 'signal', 'exitObserved',
  'childLeftRunning', 'attempts', 'stallMs', 'cancelGraceMs', 'timeoutMs', 'relay', 'relayStatus', 'relayRequests',
  'relayRefusals',
].sort();

// A real child that never writes and never exits on its own. Every one is
// tracked: after each test any still running is killed and the test FAILS, so
// a supervisor that does not kill (or a mutant that skips it) cannot leave a
// child holding jest open.
const spawned = new Set();
const silentChild = () => {
  const child = childSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.add(child);
  return child;
};
// A zombie (exited, not yet reaped by whoever adopted it) is not running.
const isZombie = (pid) => {
  try { return /^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
};
const isRunning = (pid) => {
  try { process.kill(pid, 0); } catch (e) { return e.code !== 'ESRCH'; }
  return !isZombie(pid);
};
const strayPids = new Set();
afterEach(async () => {
  const strays = [...strayPids].filter(isRunning);
  strayPids.clear();
  for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  expect(strays.map((pid) => `grandchild ${pid} outlived its test`)).toEqual([]);
  const leaked = [...spawned].filter((child) => child.exitCode === null && child.signalCode === null);
  spawned.clear();
  for (const child of leaked) child.kill('SIGKILL');
  await Promise.all(leaked.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve);
  })));
  expect(leaked.map((child) => `child ${child.pid} outlived its test`)).toEqual([]);
});

describe('policy and relay defaults', () => {
  test('codex stalls at 15 min, claude has no stall window, both get grace 15 s and the wall past the turn budget', () => {
    expect(STALL_DEFAULTS_MS).toEqual({ codex: 900_000, claude: 0 });
    expect(supervisedRunPolicy(2_700_000, { adapterName: 'codex', env: {} }))
      .toEqual({ stallMs: 900_000, cancelGraceMs: 15_000, timeoutMs: 2_760_000 });
    expect(supervisedRunPolicy(2_700_000, { adapterName: 'claude', env: {} }).stallMs).toBe(0);
    expect(supervisedRunPolicy(1000, { adapterName: 'stub', env: {} }).stallMs).toBe(0);
  });

  test('env overrides, most specific first; a bad value is ignored with a warning', () => {
    const env = { COMMONLY_SUPERVISE_STALL_MS: '600000', COMMONLY_SUPERVISE_STALL_MS_CLAUDE: '1800000' };
    expect(supervisedRunPolicy(10, { adapterName: 'codex', env }).stallMs).toBe(600_000);
    expect(supervisedRunPolicy(10, { adapterName: 'claude', env }).stallMs).toBe(1_800_000);
    const warnings = [];
    expect(supervisedRunPolicy(10, {
      adapterName: 'codex', env: { COMMONLY_SUPERVISE_STALL_MS_CODEX: '-5', COMMONLY_SUPERVISE_CANCEL_GRACE_MS: '2000' }, warnings,
    })).toEqual({ stallMs: 900_000, cancelGraceMs: 2000, timeoutMs: 60_010 });
    expect(warnings).toEqual([expect.stringContaining('COMMONLY_SUPERVISE_STALL_MS_CODEX ignored')]);
  });

  test('the relay is on for codex and off for claude by default, and each can be flipped', () => {
    expect(relayEnabledFor('codex', {})).toBe(true);
    expect(relayEnabledFor('claude', {})).toBe(false);
    expect(relayEnabledFor('claude', { COMMONLY_SUPERVISE_RELAY_CLAUDE: '1' })).toBe(true);
    expect(relayEnabledFor('codex', { COMMONLY_SUPERVISE_RELAY_CODEX: '0' })).toBe(false);
  });
});

describe('the turn runner', () => {
  beforeEach(reset);

  test('flag off: adapter.spawn gets the same prompt and the same ctx object, and superviseRun is not called', async () => {
    const superviseRun = jest.fn();
    const spawn = jest.fn(async () => ({ text: REPLY }));
    const ctx = { cwd: '/w', env: process.env, timeoutMs: 5 };
    const runner = createTurnRunner({ seat: 'quire', turnTimeoutMs: 5, supervise: false, superviseRun, env: {} });
    await expect(runner.run({ name: 'claude', spawn }, PROMPT, ctx, { eventType: 'chat.mention' })).resolves.toEqual({ text: REPLY });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe(PROMPT);
    expect(spawn.mock.calls[0][1]).toBe(ctx);
    expect(Object.keys(ctx)).toEqual(['cwd', 'env', 'timeoutMs']);
    expect(superviseRun).not.toHaveBeenCalled();
  });

  test('flag on: the turn goes through superviseRun with the canary policy, the relay choice and a no-record store', async () => {
    const superviseRun = jest.fn(async ({ store }) => {
      store.startRun({}).emit('run.settled', { outcome: 'ok' });
      return { outcome: 'ok', attempts: 1, result: { text: REPLY } };
    });
    const spawn = jest.fn();
    const runner = createTurnRunner({ seat: 'nib', turnTimeoutMs: 2_700_000, supervise: true, superviseRun, env: {} });
    await expect(runner.run({ name: 'codex', spawn }, PROMPT, { cwd: '/w' }, { eventType: 'inbox.batch' }))
      .resolves.toEqual({ text: REPLY });
    expect(spawn).not.toHaveBeenCalled();
    expect(superviseRun).toHaveBeenCalledTimes(1);
    const args = superviseRun.mock.calls[0][0];
    expect(args.prompt).toBe(PROMPT);
    expect(args.policy).toEqual({ stallMs: 900_000, cancelGraceMs: 15_000, timeoutMs: 2_760_000 });
    expect(args.relay).toEqual({});
    expect(typeof args.ctx.onSpawn).toBe('function');
    expect(args.label).toBe('inbox.batch');

    await createTurnRunner({ seat: 'quire', turnTimeoutMs: 1, supervise: true, superviseRun, env: {} })
      .run({ name: 'claude', spawn }, PROMPT, {}, {});
    expect(superviseRun.mock.calls[1][0].relay).toBe(false);
  });

  test('a stalled real child is named stuck, killed, and thrown; the metric line says so', async () => {
    // Under a mutant that never supervises, run() never settles: race it so the test fails, not hangs.
    const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`no settle in ${ms}ms`)), ms).unref();
    })]);
    const env = { COMMONLY_SUPERVISE_STALL_MS: '60', COMMONLY_SUPERVISE_CANCEL_GRACE_MS: '40', COMMONLY_SUPERVISE_RELAY_CODEX: '0' };
    const logs = [];
    let pid;
    const adapter = {
      name: 'codex',
      // Ignores the abort, so the supervisor has to kill.
      spawn: (_prompt, ctx) => new Promise(() => {
        const child = silentChild();
        pid = child.pid;
        child.once('spawn', () => ctx.onSpawn({}, child));
      }),
    };
    const runner = createTurnRunner({ seat: 'nib', turnTimeoutMs: 60_000, supervise: true, env, log: (l) => logs.push(l) });
    const error = await within(runner.run(adapter, PROMPT, {}, { eventType: 'chat.mention' }), 5000).catch((e) => e);
    expect(error.kind).toBe('stuck');
    expect(isRunning(pid)).toBe(false);
    expect(logs).toEqual([expect.stringMatching(/^\[chat\.mention\] supervised turn failed: stuck \(child killed\)$/)]);
    expect(readMetrics('nib')).toEqual([expect.objectContaining({
      path: 'supervised', outcome: 'failed', failure: 'stuck', failureSource: 'supervisor', stalled: true,
      cancelled: true, killed: true, signal: 'SIGKILL', exitObserved: true, childLeftRunning: false, relay: false, stallMs: 60,
    })]);
  });

  test('a stalled child in its own group is killed with its grandchild (group kill on the canary path)', async () => {
    const env = { COMMONLY_SUPERVISE_STALL_MS: '500', COMMONLY_SUPERVISE_CANCEL_GRACE_MS: '40', COMMONLY_SUPERVISE_RELAY_CODEX: '0' };
    // The CLI stand-in starts a grandchild in a group of its own (as codex does
    // for MCP servers), reports its pid on stderr, then goes quiet.
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});"
      + "process.stderr.write(c.pid+'\\n');setInterval(()=>{},1000);";
    let child;
    let ownGroup;
    let grandchild = null;
    const adapter = {
      name: 'codex',
      spawn: (_prompt, ctx) => new Promise(() => {
        ownGroup = wantsOwnProcessGroup(ctx);
        child = spawnInOwnGroup(childSpawn, process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }, { ownGroup });
        spawned.add(child);
        child.stderr.on('data', (chunk) => {
          grandchild = Number(String(chunk).trim());
          strayPids.add(grandchild);
        });
        child.once('spawn', () => ctx.onSpawn({}, child));
      }),
    };
    const runner = createTurnRunner({ seat: 'nib', turnTimeoutMs: 60_000, supervise: true, env });
    const error = await runner.run(adapter, PROMPT, {}, { eventType: 'chat.mention' }).catch((e) => e);
    expect(error.kind).toBe('stuck');
    expect(ownGroup).toBe(process.platform !== 'win32');
    expect(Number.isInteger(grandchild)).toBe(true);
    const deadline = Date.now() + 2000;
    while ((isRunning(child.pid) || isRunning(grandchild)) && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(isRunning(child.pid)).toBe(false);
    expect(isRunning(grandchild)).toBe(false);
  }, 15_000);

  test('one metric line per turn on both paths, and none of them carries text', async () => {
    const env = { COMMONLY_SUPERVISE_RELAY_CODEX: '0', COMMONLY_SUPERVISE_STALL_MS: '0' };
    const ok = { name: 'codex', spawn: async () => ({ text: REPLY }) };
    const bad = { name: 'codex', spawn: async () => { throw new Error(`codex exited with code 3: ${ERROR_TEXT}`); } };
    const named = { name: 'codex', spawn: async () => { throw runFailure('exited', ERROR_TEXT); } };
    const plain = createTurnRunner({ seat: 'nib', turnTimeoutMs: 1000, supervise: false, env });
    const supervised = createTurnRunner({ seat: 'nib', turnTimeoutMs: 1000, supervise: true, env });
    await plain.run(ok, PROMPT, {}, { eventType: 'chat.mention' });
    await plain.run(bad, PROMPT, {}, { eventType: 'chat.mention' }).catch(() => {});
    await supervised.run(ok, PROMPT, {}, { eventType: 'inbox.batch' });
    await supervised.run(bad, PROMPT, {}, { eventType: 'inbox.batch' }).catch(() => {});
    await supervised.run(named, PROMPT, {}, { eventType: 'inbox.batch' }).catch(() => {});

    const lines = readMetrics('nib');
    expect(lines.map((l) => [l.path, l.outcome, l.failure])).toEqual([
      ['legacy', 'ok', null],
      ['legacy', 'failed', 'adapter_exit'],
      ['supervised', 'ok', null],
      ['supervised', 'failed', 'adapter_exit'],
      ['supervised', 'failed', 'exited'],
    ]);
    expect(lines[1].exitCode).toBe(3);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(METRIC_KEYS);
      for (const value of Object.values(line)) {
        expect(['string', 'number', 'boolean'].includes(typeof value) || value === null).toBe(true);
      }
    }
    const raw = fs.readFileSync(metricsFile('nib'), 'utf8');
    for (const text of [PROMPT, REPLY, ERROR_TEXT, 'PROMPT-TEXT', 'REPLY-TEXT', 'ERROR-TEXT']) expect(raw).not.toContain(text);
  });

  test('metricLine drops anything it does not list', () => {
    const line = metricLine({
      seat: 'nib', adapter: 'codex', path: 'legacy', startMs: 0, endMs: 5, ok: true, text: REPLY, prompt: PROMPT, detail: ERROR_TEXT,
    });
    expect(Object.keys(line).sort()).toEqual(METRIC_KEYS);
    expect(JSON.stringify(line)).not.toMatch(/TEXT-/);
  });

  test('a metrics write failure never fails a turn, and is said once', async () => {
    const blocker = path.join(home, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    const logs = [];
    const runner = createTurnRunner({
      seat: 'nib', turnTimeoutMs: 1000, supervise: false, env: { COMMONLY_SEATS_CANARY_DIR: path.join(blocker, 'x') }, log: (l) => logs.push(l),
    });
    const adapter = { name: 'codex', spawn: async () => ({ text: REPLY }) };
    await expect(runner.run(adapter, PROMPT, {}, {})).resolves.toEqual({ text: REPLY });
    await runner.run(adapter, PROMPT, {}, {});
    expect(logs).toEqual([expect.stringMatching(/^turn metrics not written/)]);
  });
});

describe('the metadata store', () => {
  test('keeps type, time and the recovery action, never event data', () => {
    const run = createMetadataStore().startRun({});
    run.emit('agent.message_chunk', { text: REPLY });
    run.emit('liveness.recovery', { action: 'kill', attempt: 1 });
    run.emit('run.settled', { outcome: 'failed', failure: { kind: 'stuck', detail: ERROR_TEXT } });
    expect(run.emit('usage', {})).toBeNull();
    expect(JSON.stringify(run.events())).not.toMatch(/TEXT-/);
    expect(run.events().map(({ type, action }) => [type, action ?? null]))
      .toEqual([['agent.message_chunk', null], ['liveness.recovery', 'kill'], ['run.settled', null]]);
    expect(() => run.emit('not.a.type', {})).toThrow(/unknown trace event type/);
  });
});

// ── in the run loop ─────────────────────────────────────────────────────────

const POD = '6a8f6dc7a1dccf2e02f31015';
const event = (id) => ({
  _id: id, type: 'chat.mention', podId: POD, agentName: 'nib', instanceId: 'default',
  payload: { content: `@nib ${PROMPT} (${id})`, messageId: id.replace(/\D/g, '') || '1', username: 'growth-ops' },
});

const loop = ({ batches, adapter, superviseRuns, env = {} }) => {
  let polls = 0;
  const get = jest.fn(async (route) => {
    if (route === '/api/agents/runtime/events') { polls += 1; return { events: batches[polls - 1] || [] }; }
    if (route === '/api/agents/runtime/memory') return { sections: {} };
    if (String(route).endsWith('/messages')) return { messages: [] };
    return {};
  });
  const post = jest.fn(async (route) => (String(route).endsWith('/claim') ? { claimed: true, expiresAt: 'later' } : {}));
  createClient.mockReturnValue({ get, post, del: jest.fn().mockResolvedValue({}) });
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const logs = [];
  const errors = [];
  const scheduled = [];
  const handle = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_test',
    adapter,
    agentName: 'nib',
    environment: { model: 'gpt-test' },
    retryJitterRatio: 0,
    claimYieldDelayMs: 0,
    sleepImpl: async () => {},
    superviseRuns,
    log: (line) => logs.push(String(line)),
    onError: (err) => errors.push(err),
    setTimeoutImpl: (callback, delayMs) => { scheduled.push({ callback, delayMs }); return 0; },
  });
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  const acks = () => post.mock.calls.filter(([r]) => String(r).endsWith('/ack')).map(([r, b]) => ({ id: String(r).split('/').at(-2), result: b.result }));
  return { handle, logs, errors, scheduled, acks, restore };
};

const until = async (predicate, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!predicate()) throw new Error('condition not met in time');
};

describe('the run loop', () => {
  jest.setTimeout(30_000);
  beforeEach(() => { jest.clearAllMocks(); reset(); });

  test.each([[false, 'legacy'], [true, 'supervised']])('superviseRuns=%s routes the spawn on the %s path', async (superviseRuns, pathName) => {
    const ctxs = [];
    const adapter = { name: 'codex', detect: async () => null, spawn: async (_p, ctx) => { ctxs.push(ctx); return { text: REPLY }; } };
    const run = loop({ batches: [[event('evt-1')]], adapter, superviseRuns, env: { COMMONLY_SUPERVISE_RELAY_CODEX: '0' } });
    try {
      await until(() => run.acks().length === 1);
    } finally { run.handle.stop(); run.restore(); }
    // Only superviseRun hands an adapter a cancel signal and a trace hook.
    expect('signal' in ctxs[0]).toBe(superviseRuns);
    expect('trace' in ctxs[0]).toBe(superviseRuns);
    expect(readMetrics('nib').map((l) => l.path)).toEqual([pathName]);
    expect(fs.existsSync(path.join(home, '.commonly', 'traces'))).toBe(false);
  });

  test('a stalled turn is named stuck in the log, surfaces like any failed turn, and the loop goes on to the next event', async () => {
    let first = true;
    let pid;
    const adapter = {
      name: 'codex',
      detect: async () => null,
      spawn: (_p, ctx) => {
        if (!first) return Promise.resolve({ text: REPLY });
        first = false;
        return new Promise(() => {
          const child = silentChild();
          pid = child.pid;
          child.once('spawn', () => ctx.onSpawn({}, child));
        });
      },
    };
    const run = loop({
      batches: [[event('evt-a')], [event('evt-b')]],
      adapter,
      superviseRuns: true,
      env: { COMMONLY_SUPERVISE_STALL_MS: '60', COMMONLY_SUPERVISE_CANCEL_GRACE_MS: '40', COMMONLY_SUPERVISE_RELAY_CODEX: '0' },
    });
    try {
      await until(() => run.errors.length === 1 && run.scheduled.length === 1);
      // The run loop takes a single event or an inbox batch; either way the
      // turn is named in the seat log and surfaces through onError.
      expect(run.logs).toEqual(expect.arrayContaining([
        expect.stringMatching(/^\[(chat\.mention|inbox\.batch)\] supervised turn failed: stuck \(child killed\)$/),
      ]));
      expect(run.errors[0]).toMatchObject({ code: 'agent_spawn_retry_scheduled', eventId: 'evt-a' });
      expect(run.errors[0].message).toMatch(/remains? unacked.*stuck: no progress signal/);
      expect(run.acks()).toEqual([]);
      expect(isRunning(pid)).toBe(false);
      run.scheduled.shift().callback();
      await until(() => run.acks().length === 1);
      expect(run.acks()).toEqual([{ id: 'evt-b', result: { outcome: 'posted' } }]);
    } finally { run.handle.stop(); run.restore(); }
    expect(readMetrics('nib').map((l) => [l.path, l.outcome, l.failure, l.killed])).toEqual([
      ['supervised', 'failed', 'stuck', true],
      ['supervised', 'ok', null, false],
    ]);
  });
});
