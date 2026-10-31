/**
 * The supervised turn runner (lib/supervised-turn.js) and its place in the
 * run loop.
 *
 *  - flag off: adapter.spawn gets the caller's prompt and ctx object, unchanged,
 *    and superviseRun is never called (the golden in supervise-runs-flag.test
 *    pins the whole run loop byte for byte);
 *  - flag on: the turn goes through superviseRun with the turn log policy;
 *  - a stalled turn is named `stuck`, its child killed, its event left unacked,
 *    and the run loop goes on to the next event;
 *  - flag on, one metric line per turn, written once delivery settles, and no
 *    text in it; flag off, nothing written at all;
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
  createTurnRunner, createMetadataStore, supervisedRunPolicy, metricLine, STALL_DEFAULTS_MS, TURN_OUTCOMES,
} = await import('../src/lib/supervised-turn.js');
const { runFailure } = await import('@commonlyai/seats/failures');
const { spawnInOwnGroup, wantsOwnProcessGroup } = await import('@commonlyai/seats/process-group');

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const PROMPT = 'PROMPT-TEXT-7f3a1c do the docs wash';
const REPLY = 'REPLY-TEXT-b29e40 done';
const ERROR_TEXT = 'ERROR-TEXT-55c0de upstream said no';
const metricsFile = (seat) => path.join(home, '.commonly', 'state', 'turns', `${seat}.jsonl`);
const readMetrics = (seat) => (fs.existsSync(metricsFile(seat))
  ? fs.readFileSync(metricsFile(seat), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => fs.rmSync(path.join(home, '.commonly'), { recursive: true, force: true });

const METRIC_KEYS = [
  'v', 'ts', 'seat', 'adapter', 'path', 'eventType', 'turnStart', 'turnEnd', 'durationMs', 'outcome', 'ok', 'failure',
  'failureSource', 'failureClass', 'stalled', 'cancelled', 'killed', 'exitCode', 'signal', 'exitObserved',
  'childLeftRunning', 'attempts', 'stallMs', 'cancelGraceMs', 'timeoutMs',
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

describe('policy defaults', () => {
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
});

// One turn through the runner, as the run loop drives it.
const turnOf = (runner, adapter, ctx = {}, { eventType = 'chat.mention', outcome = 'delivered' } = {}) => {
  const turn = runner.begin({ eventType });
  return turn.run(adapter, PROMPT, ctx).then((result) => { turn.finish(outcome); return result; });
};

describe('the turn runner', () => {
  beforeEach(reset);

  test('flag off: adapter.spawn gets the same prompt and the same ctx object, and superviseRun is not called', async () => {
    const superviseRun = jest.fn();
    const spawn = jest.fn(async () => ({ text: REPLY }));
    const ctx = { cwd: '/w', env: process.env, timeoutMs: 5 };
    const runner = createTurnRunner({ seat: 'delta', turnTimeoutMs: 5, supervise: false, superviseRun, env: {} });
    await expect(turnOf(runner, { name: 'claude', spawn }, ctx)).resolves.toEqual({ text: REPLY });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe(PROMPT);
    expect(spawn.mock.calls[0][1]).toBe(ctx);
    expect(Object.keys(ctx)).toEqual(['cwd', 'env', 'timeoutMs']);
    expect(superviseRun).not.toHaveBeenCalled();
    // Nothing is written with the flag off, not even the directory.
    expect(fs.existsSync(path.join(home, '.commonly'))).toBe(false);
  });

  test('flag on: the turn goes through superviseRun with the turn log policy and a no-record store, and no relay', async () => {
    const superviseRun = jest.fn(async ({ store }) => {
      store.startRun({}).emit('run.settled', { outcome: 'ok' });
      return { outcome: 'ok', attempts: 1, result: { text: REPLY } };
    });
    const spawn = jest.fn();
    const runner = createTurnRunner({ seat: 'delta', turnTimeoutMs: 2_700_000, supervise: true, superviseRun, env: {} });
    await expect(turnOf(runner, { name: 'codex', spawn }, { cwd: '/w' }, { eventType: 'inbox.batch' }))
      .resolves.toEqual({ text: REPLY });
    expect(spawn).not.toHaveBeenCalled();
    expect(superviseRun).toHaveBeenCalledTimes(1);
    const args = superviseRun.mock.calls[0][0];
    expect(args.prompt).toBe(PROMPT);
    expect(args.policy).toEqual({ stallMs: 900_000, cancelGraceMs: 15_000, timeoutMs: 2_760_000 });
    expect(args).not.toHaveProperty('relay');
    expect(typeof args.ctx.onSpawn).toBe('function');
    expect(args.label).toBe('inbox.batch');
  });

  test('a stalled real child is named stuck, killed, and thrown; the metric line says so', async () => {
    // Under a mutant that never supervises, run() never settles: race it so the test fails, not hangs.
    const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`no settle in ${ms}ms`)), ms).unref();
    })]);
    // 300 ms, not less: a loaded CI host must not count the child's own start as a stall.
    const env = { COMMONLY_SUPERVISE_STALL_MS: '300', COMMONLY_SUPERVISE_CANCEL_GRACE_MS: '40' };
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
    const runner = createTurnRunner({ seat: 'delta', turnTimeoutMs: 60_000, supervise: true, env, log: (l) => logs.push(l) });
    const error = await within(turnOf(runner, adapter), 5000).catch((e) => e);
    expect(error.kind).toBe('stuck');
    expect(isRunning(pid)).toBe(false);
    expect(logs).toEqual([expect.stringMatching(/^\[chat\.mention\] supervised turn failed: stuck \(child killed\)$/)]);
    expect(readMetrics('delta')).toEqual([expect.objectContaining({
      path: 'supervised', outcome: 'failed', ok: false, failure: 'stuck', failureSource: 'supervisor', stalled: true,
      cancelled: true, killed: true, signal: 'SIGKILL', exitObserved: true, childLeftRunning: false, stallMs: 300,
    })]);
  });

  test('a stalled child in its own group is killed with its grandchild (group kill on the turn log path)', async () => {
    const env = { COMMONLY_SUPERVISE_STALL_MS: '500', COMMONLY_SUPERVISE_CANCEL_GRACE_MS: '40' };
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
    const runner = createTurnRunner({ seat: 'delta', turnTimeoutMs: 60_000, supervise: true, env });
    const error = await turnOf(runner, adapter).catch((e) => e);
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

  test('flag on, one line per turn once delivery settles; flag off, none; and no line carries text', async () => {
    const env = { COMMONLY_SUPERVISE_STALL_MS: '0' };
    const ok = { name: 'codex', spawn: async () => ({ text: REPLY }) };
    const bad = { name: 'codex', spawn: async () => { throw new Error(`codex exited with code 3: ${ERROR_TEXT}`); } };
    const named = { name: 'codex', spawn: async () => { throw runFailure('exited', ERROR_TEXT); } };
    const plain = createTurnRunner({ seat: 'delta', turnTimeoutMs: 1000, supervise: false, env });
    const supervised = createTurnRunner({ seat: 'delta', turnTimeoutMs: 1000, supervise: true, env });
    await turnOf(plain, ok);
    await turnOf(plain, bad).catch(() => {});
    expect(readMetrics('delta')).toEqual([]);

    // A spawn that resolved writes nothing until the run loop says what
    // became of the reply, and only the first finish counts.
    const held = supervised.begin({ eventType: 'inbox.batch' });
    await held.run(ok, PROMPT, {});
    expect(readMetrics('delta')).toEqual([]);
    held.finish('reply_lost');
    held.finish('delivered');
    for (const outcome of ['delivered', 'silent', 'claim_lost']) {
      // eslint-disable-next-line no-await-in-loop
      await turnOf(supervised, ok, {}, { eventType: 'inbox.batch', outcome });
    }
    // A failed spawn is written at once; a finish after it adds nothing.
    for (const adapter of [bad, named]) {
      const turn = supervised.begin({ eventType: 'inbox.batch' });
      // eslint-disable-next-line no-await-in-loop
      await turn.run(adapter, PROMPT, {}).catch(() => turn.finish('reply_lost'));
    }

    const lines = readMetrics('delta');
    expect(lines.map((l) => [l.path, l.outcome, l.ok, l.failure])).toEqual([
      ['supervised', 'reply_lost', false, null],
      ['supervised', 'delivered', true, null],
      ['supervised', 'silent', true, null],
      ['supervised', 'claim_lost', false, null],
      ['supervised', 'failed', false, 'adapter_exit'],
      ['supervised', 'failed', false, 'exited'],
    ]);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(METRIC_KEYS);
      for (const value of Object.values(line)) {
        expect(['string', 'number', 'boolean'].includes(typeof value) || value === null).toBe(true);
      }
    }
    const raw = fs.readFileSync(metricsFile('delta'), 'utf8');
    for (const text of [PROMPT, REPLY, ERROR_TEXT, 'PROMPT-TEXT', 'REPLY-TEXT', 'ERROR-TEXT']) expect(raw).not.toContain(text);
  });

  test('the seat name cannot leave the turn log directory, and a bad event label is dropped', async () => {
    const dir = path.join(home, 'turn-log');
    const ok = { name: 'codex', spawn: async () => ({ text: REPLY }) };
    for (const seat of ['../../etc/x', 'a'.repeat(200)]) {
      const runner = createTurnRunner({
        seat, turnTimeoutMs: 1000, supervise: true, env: { COMMONLY_SUPERVISE_STALL_MS: '0', COMMONLY_TURN_LOG_DIR: dir },
      });
      expect(path.dirname(runner.metricsPath)).toBe(dir);
      // eslint-disable-next-line no-await-in-loop
      await turnOf(runner, ok, {}, { eventType: 'chat mention\nforged: true' });
    }
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file).toMatch(/^[A-Za-z0-9_.-]{1,64}\.jsonl$/);
      const [line] = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(line.eventType).toBeNull();
      expect(line.seat).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    }
    expect(fs.existsSync(path.join(home, 'etc'))).toBe(false);
  });

  test('metricLine drops anything it does not list, and an outcome it does not know is unknown, not ok', () => {
    const line = metricLine({
      seat: 'delta', adapter: 'codex', path: 'supervised', startMs: 0, endMs: 5, outcome: 'delivered', text: REPLY, prompt: PROMPT, detail: ERROR_TEXT,
    });
    expect(Object.keys(line).sort()).toEqual(METRIC_KEYS);
    expect(line).toMatchObject({ outcome: 'delivered', ok: true });
    expect(JSON.stringify(line)).not.toMatch(/TEXT-/);
    expect(metricLine({ startMs: 0, endMs: 5, outcome: REPLY })).toMatchObject({ outcome: 'unknown', ok: false });
    expect(metricLine({ startMs: 0, endMs: 5 })).toMatchObject({ outcome: 'unknown', ok: false });
    expect(TURN_OUTCOMES.filter((o) => metricLine({ startMs: 0, endMs: 5, outcome: o }).ok)).toEqual(['delivered', 'silent']);
  });

  test('a metrics write failure never fails a turn, and is said once', async () => {
    const blocker = path.join(home, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    const logs = [];
    const runner = createTurnRunner({
      seat: 'delta',
      turnTimeoutMs: 1000,
      supervise: true,
      env: { COMMONLY_SUPERVISE_STALL_MS: '0', COMMONLY_TURN_LOG_DIR: path.join(blocker, 'x') },
      log: (l) => logs.push(l),
    });
    const adapter = { name: 'codex', spawn: async () => ({ text: REPLY }) };
    await expect(turnOf(runner, adapter)).resolves.toEqual({ text: REPLY });
    await turnOf(runner, adapter);
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
  _id: id, type: 'chat.mention', podId: POD, agentName: 'delta', instanceId: 'default',
  payload: { content: `@delta ${PROMPT} (${id})`, messageId: id.replace(/\D/g, '') || '1', username: 'growth-ops' },
});

const CLAIM_RENEW_MS = 45_000; // the default 90 s lease renews at half-life
const claimed = { claimed: true, expiresAt: 'later' };

const loop = ({
  batches, adapter, superviseRuns, env = {}, postImpl = async (route) => (String(route).endsWith('/claim') ? claimed : {}),
}) => {
  let polls = 0;
  const get = jest.fn(async (route) => {
    if (route === '/api/agents/runtime/events') { polls += 1; return { events: batches[polls - 1] || [] }; }
    if (route === '/api/agents/runtime/memory') return { sections: {} };
    if (String(route).endsWith('/messages')) return { messages: [] };
    return {};
  });
  const post = jest.fn(postImpl);
  createClient.mockReturnValue({ get, post, del: jest.fn().mockResolvedValue({}) });
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const logs = [];
  const errors = [];
  const scheduled = [];
  const intervals = [];
  const handle = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_test',
    adapter,
    agentName: 'delta',
    environment: { model: 'gpt-test' },
    retryJitterRatio: 0,
    claimYieldDelayMs: 0,
    sleepImpl: async () => {},
    superviseRuns,
    log: (line) => { logs.push(String(line)); },
    // `commonly agent run` stamps onError into the same seat log as log().
    onError: (err) => { errors.push(err); },
    setTimeoutImpl: (callback, delayMs) => { scheduled.push({ callback, delayMs }); return 0; },
    setIntervalImpl: (callback, delayMs) => { intervals.push({ callback, delayMs }); return intervals.length; },
    clearIntervalImpl: () => {},
  });
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  const acks = () => post.mock.calls.filter(([r]) => String(r).endsWith('/ack')).map(([r, b]) => ({ id: String(r).split('/').at(-2), result: b.result }));
  // The claim keeper's renewal ticks, fired by hand (mid-turn, from a spawn).
  const renewClaims = () => Promise.all(intervals.filter((i) => i.delayMs === CLAIM_RENEW_MS).map((i) => i.callback()));
  return { handle, logs, errors, scheduled, acks, restore, post, renewClaims };
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
    const run = loop({ batches: [[event('evt-1')]], adapter, superviseRuns, env: {} });
    try {
      await until(() => run.acks().length === 1);
    } finally { run.handle.stop(); run.restore(); }
    // Only superviseRun hands an adapter a cancel signal and a trace hook.
    expect('signal' in ctxs[0]).toBe(superviseRuns);
    expect('trace' in ctxs[0]).toBe(superviseRuns);
    // Flag off writes no turn line at all; flag on writes one once the reply is posted.
    expect(readMetrics('delta').map((l) => [l.path, l.outcome, l.ok])).toEqual(superviseRuns ? [[pathName, 'delivered', true]] : []);
    expect(fs.existsSync(path.join(home, '.commonly', 'state', 'turns'))).toBe(superviseRuns);
    expect(fs.existsSync(path.join(home, '.commonly', 'traces'))).toBe(false);
  });

  test('a stalled turn is named stuck in the log, surfaces like any failed turn, and its held event is retried', async () => {
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
      env: { COMMONLY_SUPERVISE_STALL_MS: '300', COMMONLY_SUPERVISE_CANCEL_GRACE_MS: '40' },
    });
    try {
      await until(() => run.errors.length === 1 && run.scheduled.length === 1);
      // The run loop takes a single event or an inbox batch; either way the
      // turn is named in the seat log and surfaces through onError.
      expect(run.logs).toEqual(expect.arrayContaining([
        expect.stringMatching(/^\[(chat\.mention|inbox\.batch)\] supervised turn failed: stuck \(child killed\)$/),
      ]));
      expect(run.errors[0]).toMatchObject({ code: 'agent_spawn_retry_scheduled', eventId: 'evt-a' });
      expect(run.errors[0].message).toMatch(/retrying 1 held event in \d+s: stuck: no progress signal/);
      expect(run.acks()).toEqual([]);
      expect(isRunning(pid)).toBe(false);
      // The retry re-runs the held event (it is still claimed by this runner,
      // so no poll could return it); the next poll's event is served too.
      run.scheduled.shift().callback();
      await until(() => ['evt-a', 'evt-b'].every((id) => run.acks().some((a) => a.id === id)));
      expect(run.acks().filter((a) => a.id === 'evt-a')).toEqual([{ id: 'evt-a', result: { outcome: 'posted' } }]);
    } finally { run.handle.stop(); run.restore(); }
    const turns = readMetrics('delta').map((l) => [l.path, l.outcome, l.failure, l.killed]);
    expect(turns[0]).toEqual(['supervised', 'failed', 'stuck', true]);
    expect(turns.slice(1).length).toBeGreaterThan(0);
    for (const turn of turns.slice(1)) expect(turn).toEqual(['supervised', 'delivered', null, false]);
  });

  // A turn is ok only once its outcome reached the pod. Each case below runs
  // the real run loop with the flag on, then reads the turn back from its turn line.

  test('a lease lost mid-turn is claim_lost, not ok: the reply is not posted', async () => {
    const renewals = { n: 0 };
    let run;
    const adapter = {
      name: 'codex',
      detect: async () => null,
      spawn: async () => { await run.renewClaims(); return { text: REPLY }; },
    };
    run = loop({
      batches: [[event('evt-1')]],
      adapter,
      superviseRuns: true,
      env: { COMMONLY_SUPERVISE_STALL_MS: '0' },
      postImpl: async (route) => {
        if (!String(route).endsWith('/claim')) return {};
        renewals.n += 1;
        // Acquired, then a peer holds it at the first renewal.
        return renewals.n === 1 ? claimed : { claimed: false, claimedBy: 'peer' };
      },
    });
    try {
      await until(() => readMetrics('delta').length === 1);
    } finally { run.handle.stop(); run.restore(); }
    expect(renewals.n).toBeGreaterThan(1);
    expect(run.logs).toEqual(expect.arrayContaining([expect.stringMatching(/stood down — claim lost mid-turn to peer; reply suppressed/)]));
    expect(run.post.mock.calls.filter(([r]) => String(r).endsWith('/messages'))).toEqual([]);
    expect(readMetrics('delta')).toEqual([expect.objectContaining({ path: 'supervised', outcome: 'claim_lost', ok: false, failure: null })]);
  });

  test('a reply every delivery rung refused is reply_lost, not ok: the event stays unacked', async () => {
    const adapter = { name: 'codex', detect: async () => null, spawn: async () => ({ text: REPLY }) };
    const rungs = [];
    const run = loop({
      batches: [[event('evt-1')]],
      adapter,
      superviseRuns: true,
      env: { COMMONLY_SUPERVISE_STALL_MS: '0' },
      postImpl: async (route) => {
        const r = String(route);
        if (r.endsWith('/claim')) return claimed;
        if (r.includes('/messages') || r.includes('/upload')) {
          rungs.push(r);
          throw Object.assign(new Error('HTTP 502'), { status: 502 });
        }
        return {};
      },
    });
    try {
      await until(() => readMetrics('delta').length === 1 && run.errors.length === 1);
    } finally { run.handle.stop(); run.restore(); }
    expect(rungs.length).toBeGreaterThan(0);
    expect(run.logs).toEqual(expect.arrayContaining([expect.stringMatching(/ERROR reply NOT delivered to pod/)]));
    expect(run.acks()).toEqual([]);
    expect(readMetrics('delta')).toEqual([expect.objectContaining({ path: 'supervised', outcome: 'reply_lost', ok: false, failure: null })]);
  });
});
