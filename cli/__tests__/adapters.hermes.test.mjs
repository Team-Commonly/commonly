/**
 * Fixtures are stdout captured from NousResearch/hermes-agent tag v0.22.2
 * (commit d923a5eb487a) on 2026-10-21. The real CLI was run twice with
 * --query-file - --format stream-json --provider openrouter --model test/model,
 * using an isolated HERMES_HOME and a local OpenAI-compatible test endpoint
 * answering PONG. The second capture passed --resume with the first session ID.
 * No provider credential or request body is stored in these fixtures.
 */
import { EventEmitter } from 'events';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { jest } from '@jest/globals';
import hermes, { TESTED_HERMES_VERSION, readHermesJsonl } from '../src/lib/adapters/hermes.js';
import { validateEnvironmentSpec } from '../src/lib/environment.js';

const fixture = async (name) => readFile(
  new URL(`./fixtures/hermes-0.22.2/${name}.jsonl`, import.meta.url), 'utf8',
);

const versionProbe = (version = TESTED_HERMES_VERSION) => jest.fn(() => ({
  status: 0, stdout: `Hermes Agent v${version} (local build)\n`,
}));

const recordedSpawn = (recording, onSpawn = () => {}, exitCode = 0) => (command, args, options) => {
  onSpawn(command, args, options);
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();
  queueMicrotask(() => {
    const middle = Math.floor(recording.length / 2);
    child.stdout.write(recording.slice(0, middle));
    child.stdout.end(recording.slice(middle));
    child.stderr.end();
    child.emit('close', exitCode);
  });
  return child;
};

const withHome = async (run) => {
  const home = await mkdtemp(join(tmpdir(), 'commonly-hermes-test-'));
  try { return await run(home); } finally { await rm(home, { recursive: true, force: true }); }
};

test('real 0.22.2 first and resumed JSONL return one final reply and a stable session', async () => {
  const first = await fixture('first-turn');
  const resumed = await fixture('resume');
  const firstEvents = first.trim().split('\n').map(JSON.parse);
  const resumeEvents = resumed.trim().split('\n').map(JSON.parse);
  expect(firstEvents.map((event) => event.type)).toEqual(['system', 'text', 'result']);
  expect(resumeEvents.map((event) => event.type)).toEqual(['system', 'text', 'result']);
  expect(resumeEvents[0].session_id).toBe(firstEvents[0].session_id);

  await withHome(async (home) => {
    const calls = [];
    const context = {
      cwd: home, agentName: 'pa1-test', env: { PATH: '/bin', OPENROUTER_API_KEY: 'fixture-only' },
      _hermesHome: join(home, 'profiles', 'pa1'), _spawnSyncImpl: versionProbe(),
    };
    const firstResult = await hermes.spawn('Reply PONG', {
      ...context, _spawnImpl: recordedSpawn(first, (...call) => calls.push(call)),
    });
    expect(firstResult).toEqual({ text: 'PONG', newSessionId: firstEvents[0].session_id });

    const resumeResult = await hermes.spawn('Reply again', {
      ...context, sessionId: firstResult.newSessionId,
      _spawnImpl: recordedSpawn(resumed, (...call) => calls.push(call)),
    });
    expect(resumeResult).toEqual({ text: 'PONG', newSessionId: firstResult.newSessionId });
    expect(calls).toHaveLength(2);
    for (const [command, args, options] of calls) {
      expect(command).toBe('hermes');
      expect(args).toEqual(expect.arrayContaining([
        'chat', '--oneshot', '--query-file', '-', '--format', 'stream-json',
        '--provider', 'openrouter', '--source', 'tool',
      ]));
      expect(args.join(' ')).not.toContain('fixture-only');
      expect(args.join(' ')).not.toContain('Reply');
      expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
      expect(options.env.HERMES_HOME).toBe(join(home, 'profiles', 'pa1'));
    }
    expect(calls[1][1]).toEqual(expect.arrayContaining(['--resume', firstResult.newSessionId]));
    expect(calls[0][1]).not.toContain('--resume');
  });
});

test('refuses any Hermes version other than 0.22.2 before starting a turn', async () => {
  await withHome(async (home) => {
    const child = jest.fn();
    for (const version of ['0.22.3', '0.22.1', '0.22.2+1.gabcdef0']) {
      // A post-release checkout may retain the 0.22.2 prefix but is not the pin.
      // eslint-disable-next-line no-await-in-loop
      await expect(hermes.spawn('hello', {
        cwd: home, _hermesHome: home, env: { OPENROUTER_API_KEY: 'fixture-only' },
        _spawnSyncImpl: versionProbe(version), _spawnImpl: child,
      })).rejects.toThrow(`Hermes ${version} is unsupported; this adapter requires 0.22.2`);
    }
    expect(child).not.toHaveBeenCalled();
  });
});

test('retries a failed cold-home version probe before the first turn', async () => {
  await withHome(async (home) => {
    const probe = jest.fn()
      .mockReturnValueOnce({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } })
      .mockReturnValueOnce({ status: 0, stdout: 'Hermes Agent v0.22.2 (local build)\n' });
    const recording = await fixture('first-turn');
    await expect(hermes.spawn('hello', {
      cwd: home, _hermesHome: home, env: { OPENROUTER_API_KEY: 'fixture-only' },
      _spawnSyncImpl: probe, _spawnImpl: recordedSpawn(recording),
    })).resolves.toMatchObject({ text: 'PONG' });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[0][2].timeout).toBe(15000);
  });
});

test('reports timeout, signal and status when a version probe fails twice', async () => {
  await withHome(async (home) => {
    const probe = jest.fn(() => ({
      status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' },
    }));
    const child = jest.fn();
    await expect(hermes.spawn('hello', {
      cwd: home, _hermesHome: home, env: { OPENROUTER_API_KEY: 'fixture-only' },
      _spawnSyncImpl: probe, _spawnImpl: child,
    })).rejects.toThrow('status=none, signal=SIGTERM, code=ETIMEDOUT, timeout=15000ms');
    expect(probe).toHaveBeenCalledTimes(2);
    expect(child).not.toHaveBeenCalled();
  });
});

test('reports a non-zero cold-home probe status without suggesting a reinstall', async () => {
  await withHome(async (home) => {
    const probe = jest.fn(() => ({ status: 1, signal: null }));
    await expect(hermes.spawn('hello', {
      cwd: home, _hermesHome: home, env: { OPENROUTER_API_KEY: 'fixture-only' },
      _spawnSyncImpl: probe, _spawnImpl: jest.fn(),
    })).rejects.toThrow('status=1, signal=none, code=none, timeout=15000ms');
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

test('refuses a public seat before probing or spawning Hermes', async () => {
  const probe = jest.fn();
  const child = jest.fn();
  await expect(hermes.spawn('hello', {
    environment: { sandbox: { trust: 'public' } },
    _spawnSyncImpl: probe, _spawnImpl: child,
  })).rejects.toThrow('no enforced confinement adapter exists');
  expect(probe).not.toHaveBeenCalled();
  expect(child).not.toHaveBeenCalled();
});

test('refuses a declared MCP server rather than silently dropping its tools', async () => {
  await expect(hermes.validateEnvironment({
    mcp: [{ name: 'commonly', transport: 'stdio', command: ['npx', '@commonlyai/mcp'] }],
  })).rejects.toThrow('does not yet consume environment.mcp');
});

test('does not advertise the provider object contract it cannot consume', async () => {
  const environment = {
    model: 'test-model',
    provider: { id: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', keyFile: '/tmp/test-only-key' },
  };
  expect(validateEnvironmentSpec(environment)).toEqual({ ok: true, errors: [] });
  expect(hermes.supportsProvider).toBe(false);
  await expect(hermes.validateEnvironment(environment)).rejects.toThrow('does not consume environment.provider');
});

test('preserves a UTF-8 JSONL result split inside a character', async () => {
  await withHome(async (home) => {
    const recording = Buffer.from([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'unicode-test' }),
      JSON.stringify({ type: 'result', session_id: 'unicode-test', exit_code: 0, text: '你好🙂' }),
    ].join('\n') + '\n');
    const cut = recording.indexOf(Buffer.from('你')) + 1;
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = jest.fn();
      queueMicrotask(() => {
        child.stdout.write(recording.subarray(0, cut));
        child.stdout.write(recording.subarray(cut));
        child.emit('close', 0);
      });
      return child;
    };
    await expect(hermes.spawn('hello', {
      cwd: home, _hermesHome: home, env: { OPENROUTER_API_KEY: 'fixture-only' },
      _spawnSyncImpl: versionProbe(), _spawnImpl: spawnImpl,
    })).resolves.toMatchObject({ text: '你好🙂' });
  });
});

test('malformed JSONL still force-kills a child that ignores TERM', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  try {
    await withHome(async (home) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = jest.fn();
      await expect(hermes.spawn('hello', {
        cwd: home, _hermesHome: home, env: { OPENROUTER_API_KEY: 'fixture-only' },
        _spawnSyncImpl: versionProbe(),
        _spawnImpl: () => {
          queueMicrotask(() => child.stdout.write('{bad}\n'));
          return child;
        },
      })).rejects.toThrow('invalid JSONL');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await jest.advanceTimersByTimeAsync(5000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });
  } finally { jest.useRealTimers(); }
});

test('stdin failure also retains force-kill escalation', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  try {
    await withHome(async (home) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = jest.fn();
      await expect(hermes.spawn('hello', {
        cwd: home, _hermesHome: home, env: { OPENROUTER_API_KEY: 'fixture-only' },
        _spawnSyncImpl: versionProbe(),
        _spawnImpl: () => {
          queueMicrotask(() => child.stdin.emit('error', new Error('broken pipe')));
          return child;
        },
      })).rejects.toThrow('broken pipe');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await jest.advanceTimersByTimeAsync(5000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });
  } finally { jest.useRealTimers(); }
});

test('rejects invalid JSONL and a process that exits before its terminal result', async () => {
  const state = { started: false, result: null };
  readHermesJsonl('{"type":"system","subtype":"init","session_id":"s"}', state);
  expect(state.result).toBeNull();
  expect(() => readHermesJsonl('{bad', state)).toThrow('invalid JSONL');

  await withHome(async (home) => {
    const recording = (await fixture('first-turn')).split('\n')[0];
    await expect(hermes.spawn('hello', {
      cwd: home, _hermesHome: home, env: { OPENROUTER_API_KEY: 'fixture-only' },
      _spawnSyncImpl: versionProbe(), _spawnImpl: recordedSpawn(`${recording}\n`),
    })).rejects.toThrow('without a complete JSONL result');
  });
});
