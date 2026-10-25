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
const { honourAbort } = await import('../src/lib/supervised-child.js');
const { runFailure } = await import('@commonlyai/seats/failures');

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

// A real child that never writes and never exits on its own.
const silentChild = () => childSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
const isRunning = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

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
    const error = await runner.run(adapter, PROMPT, {}, { eventType: 'chat.mention' }).catch((e) => e);
    expect(error.kind).toBe('stuck');
    expect(isRunning(pid)).toBe(false);
    expect(logs).toEqual([expect.stringMatching(/^\[chat\.mention\] supervised turn failed: stuck \(child killed\)$/)]);
    expect(readMetrics('nib')).toEqual([expect.objectContaining({
      path: 'supervised', outcome: 'failed', failure: 'stuck', failureSource: 'supervisor', stalled: true,
      cancelled: true, killed: true, signal: 'SIGKILL', exitObserved: true, childLeftRunning: false, relay: false, stallMs: 60,
    })]);
  });

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

describe('honourAbort', () => {
  test('SIGTERMs on abort, at once if already aborted, and detaches', () => {
    const proc = { kill: jest.fn() };
    const controller = new AbortController();
    const stop = honourAbort(proc, controller.signal);
    controller.abort();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    const late = { kill: jest.fn() };
    honourAbort(late, controller.signal);
    expect(late.kill).toHaveBeenCalledWith('SIGTERM');
    const detached = { kill: jest.fn() };
    const c2 = new AbortController();
    honourAbort(detached, c2.signal)();
    c2.abort();
    expect(detached.kill).not.toHaveBeenCalled();
    expect(honourAbort(proc, undefined)).toEqual(expect.any(Function));
    stop();
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
      expect(run.logs.some((l) => /^\[chat\.mention\] supervised turn failed: stuck \(child killed\)$/.test(l))).toBe(true);
      expect(run.errors[0]).toMatchObject({ code: 'agent_spawn_retry_scheduled', eventId: 'evt-a' });
      expect(run.errors[0].message).toMatch(/remains unacked.*stuck: no progress signal/);
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
