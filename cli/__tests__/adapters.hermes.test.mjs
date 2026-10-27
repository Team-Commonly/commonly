/**
 * Fixtures are stdout captured from NousResearch/hermes-agent tags v0.22.2
 * (commit d923a5eb487a) and v0.22.5 (commit bf0203a794a0). The real CLI was run twice with
 * --query-file - --format stream-json --provider openrouter --model test/model,
 * using an isolated HERMES_HOME and a local OpenAI-compatible test endpoint
 * answering PONG. The second capture passed --resume with the first session ID.
 * On 0.22.5 --in replaced --no-restore-cwd for the gateway transport; the
 * init event now has an empty session_id, while the result carries the ID.
 * No provider credential or request body is stored in these fixtures.
 */
import { EventEmitter } from 'events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { jest } from '@jest/globals';
import hermes, { SUPPORTED_HERMES_VERSION_RANGE, readHermesJsonl } from '../src/lib/adapters/hermes.js';
import { validateEnvironmentSpec } from '../src/lib/environment.js';

const fixture = async (name, version = '0.22.5') => readFile(
  new URL(`./fixtures/hermes-${version}/${name}.jsonl`, import.meta.url), 'utf8',
);

const versionProbe = (version = '0.22.5') => jest.fn(() => ({
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

test('the walked 0.22.2 capture still parses, though the adapter refuses that release', async () => {
  const events = (await fixture('first-turn', '0.22.2')).trim().split('\n').map(JSON.parse);
  expect(events.map((event) => event.type)).toEqual(['system', 'text', 'result']);
  expect(events[2].session_id).toBeTruthy();
});

test('real 0.22.5 JSONL keeps the resumed session in the terminal result', async () => {
  const first = await fixture('first-turn', '0.22.5');
  const resumed = await fixture('resume', '0.22.5');
  const firstEvents = first.trim().split('\n').map(JSON.parse);
  const resumeEvents = resumed.trim().split('\n').map(JSON.parse);
  expect(firstEvents.map((event) => event.type)).toEqual(['system', 'text', 'result']);
  expect(resumeEvents.map((event) => event.type)).toEqual(['system', 'text', 'result']);
  expect(firstEvents[0].session_id).toBe('');
  expect(firstEvents[2].session_id).toBeTruthy();
  expect(resumeEvents[2].session_id).toBe(firstEvents[2].session_id);

  await withHome(async (home) => {
    const calls = [];
    const context = {
      environment: { model: 'test-model' }, cwd: home, agentName: 'pa1-test', env: { OPENROUTER_API_KEY: 'fixture-only' },
      _hermesHome: join(home, 'profiles', 'pa1'), _spawnSyncImpl: versionProbe('0.22.5'),
    };
    const firstResult = await hermes.spawn('Reply PONG', {
      ...context, _spawnImpl: recordedSpawn(first, (...call) => calls.push(call)),
    });
    expect(firstResult).toEqual({ text: 'PONG', newSessionId: firstEvents[2].session_id });
    const resumeResult = await hermes.spawn('Reply again', {
      ...context, sessionId: firstResult.newSessionId,
      _spawnImpl: recordedSpawn(resumed, (...call) => calls.push(call)),
    });
    expect(resumeResult).toEqual({ text: 'PONG', newSessionId: firstResult.newSessionId });
    expect(calls[0][1]).toEqual(expect.arrayContaining(['--in', home]));
    expect(calls[1][1]).toEqual(expect.arrayContaining(['--in', home, '--resume', firstResult.newSessionId]));
  });
});

test('accepts stable Hermes 0.22 releases from 0.22.5 onward', async () => {
  await withHome(async (home) => {
    const recording = await fixture('first-turn');
    for (const version of ['0.22.5', '0.22.9']) {
      // eslint-disable-next-line no-await-in-loop
      await expect(hermes.spawn('hello', { environment: { model: 'test-model' },
        cwd: home, _hermesHome: home, env: { OPENROUTER_API_KEY: 'fixture-only' },
        _spawnSyncImpl: versionProbe(version), _spawnImpl: recordedSpawn(recording),
      })).resolves.toMatchObject({ text: 'PONG' });
    }
  });
});

test('refuses Hermes outside the supported stable range before starting a turn', async () => {
  await withHome(async (home) => {
    const child = jest.fn();
    for (const version of ['0.22.2', '0.22.3', '0.22.4', '0.22.1', '0.23.0', '1.0.0', '0.22.5+1.gabcdef0', '0.22.6-rc.1']) {
      // Development builds and prereleases are outside the tested stable-release contract.
      // eslint-disable-next-line no-await-in-loop
      await expect(hermes.spawn('hello', { environment: { model: 'test-model' },
        cwd: home, _hermesHome: home, env: { OPENROUTER_API_KEY: 'fixture-only' },
        _spawnSyncImpl: versionProbe(version), _spawnImpl: child,
      })).rejects.toThrow(`Hermes ${version} is unsupported; this adapter supports ${SUPPORTED_HERMES_VERSION_RANGE}. Run hermes update`);
    }
    expect(child).not.toHaveBeenCalled();
  });
});

test('missing Hermes on Windows names the supported range and platform-neutral install guide', async () => {
  await withHome(async (home) => {
    const child = jest.fn();
    const missing = hermes.spawn('hello', { environment: { model: 'test-model' },
      cwd: home, _hermesHome: home,
      _spawnSyncImpl: jest.fn(() => ({ error: { code: 'ENOENT' } })), _spawnImpl: child,
    });
    await expect(missing).rejects.toThrow(`Hermes Agent ${SUPPORTED_HERMES_VERSION_RANGE} is not on PATH; install for your OS: https://hermes-agent.nousresearch.com/docs/getting-started/installation`);
    await expect(missing).rejects.not.toThrow(/curl|bash/);
    expect(child).not.toHaveBeenCalled();
  });
});

test('retries a failed cold-home version probe before the first turn', async () => {
  await withHome(async (home) => {
    const probe = jest.fn()
      .mockReturnValueOnce({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } })
      .mockReturnValueOnce({ status: 0, stdout: 'Hermes Agent v0.22.5 (local build)\n' });
    const recording = await fixture('first-turn');
    await expect(hermes.spawn('hello', { environment: { model: 'test-model' },
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
    await expect(hermes.spawn('hello', { environment: { model: 'test-model' },
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
    await expect(hermes.spawn('hello', { environment: { model: 'test-model' },
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
    environment: { model: 'test-model', sandbox: { trust: 'public' } },
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
    await expect(hermes.spawn('hello', { environment: { model: 'test-model' },
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
      await expect(hermes.spawn('hello', { environment: { model: 'test-model' },
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
      await expect(hermes.spawn('hello', { environment: { model: 'test-model' },
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
    await expect(hermes.spawn('hello', { environment: { model: 'test-model' },
      cwd: home, _hermesHome: home, env: { OPENROUTER_API_KEY: 'fixture-only' },
      _spawnSyncImpl: versionProbe(), _spawnImpl: recordedSpawn(`${recording}\n`),
    })).rejects.toThrow('without a complete JSONL result');
  });
});

describe('profile .env: the key reaches a 0.22.5 detached gateway', () => {
  const KEY = 'sk-or-v1-profileenvsentinel0123456789';
  const modeOf = async (path) => (await stat(path)).mode & 0o777;
  const turn = async (home, env, observed = []) => hermes.spawn('hello', {
    environment: { model: 'test-model' }, cwd: home, _hermesHome: join(home, 'profile'), env,
    _spawnSyncImpl: versionProbe(), onSpawn: (event) => observed.push(event),
    _spawnImpl: recordedSpawn(await fixture('first-turn', '0.22.5'), (...call) => observed.push(call)),
  });

  test('creates the profile .env at 0600 in a 0700 home, and leaves it for the gateway', async () => {
    await withHome(async (home) => {
      const observed = [];
      await turn(home, { OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: 'https://openrouter.example/api/v1' }, observed);
      const profile = join(home, 'profile');
      expect(await readFile(join(profile, '.env'), 'utf8'))
        .toBe(`OPENROUTER_API_KEY=${KEY}\nOPENROUTER_BASE_URL=https://openrouter.example/api/v1\n`);
      expect(await modeOf(join(profile, '.env'))).toBe(0o600);
      expect(await modeOf(profile)).toBe(0o700);
      expect((await readdir(profile)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect(observed.length).toBeGreaterThan(0);
      for (const event of observed) {
        const { env, ...rest } = Array.isArray(event) ? { ...event[2], args: event[1] } : event;
        expect(JSON.stringify(rest)).not.toContain(KEY);
      }
    });
  });

  test('keeps the user\'s own lines and overwrites only the keys the wrapper owns', async () => {
    await withHome(async (home) => {
      const profile = join(home, 'profile');
      await mkdir(profile, { recursive: true });
      await writeFile(join(profile, '.env'), [
        '# my profile', 'TELEGRAM_BOT_TOKEN=user-owned', 'OPENROUTER_API_KEY=stale-key',
        'export OPENROUTER_BASE_URL=https://stale.example', 'OPENROUTER_API_KEY_BACKUP=user-backup', '',
      ].join('\n'), { mode: 0o600 });
      await turn(home, { OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: 'https://openrouter.example/api/v1' });
      expect(await readFile(join(profile, '.env'), 'utf8')).toBe([
        '# my profile', 'TELEGRAM_BOT_TOKEN=user-owned', 'OPENROUTER_API_KEY_BACKUP=user-backup',
        `OPENROUTER_API_KEY=${KEY}`, 'OPENROUTER_BASE_URL=https://openrouter.example/api/v1', '',
      ].join('\n'));
    });
  });

  test('an unset base URL leaves the user\'s base URL line alone', async () => {
    await withHome(async (home) => {
      const profile = join(home, 'profile');
      await mkdir(profile, { recursive: true });
      await writeFile(join(profile, '.env'), 'OPENROUTER_BASE_URL=https://mine.example\n', { mode: 0o600 });
      await turn(home, { OPENROUTER_API_KEY: KEY });
      expect(await readFile(join(profile, '.env'), 'utf8'))
        .toBe(`OPENROUTER_BASE_URL=https://mine.example\nOPENROUTER_API_KEY=${KEY}\n`);
    });
  });

  test('a rewrite never loosens the mode, and tightens a loose file or home', async () => {
    await withHome(async (home) => {
      const profile = join(home, 'profile');
      await turn(home, { OPENROUTER_API_KEY: KEY });
      await turn(home, { OPENROUTER_API_KEY: `${KEY}rotated` });
      expect(await modeOf(join(profile, '.env'))).toBe(0o600);
      expect(await readFile(join(profile, '.env'), 'utf8')).toBe(`OPENROUTER_API_KEY=${KEY}rotated\n`);

      await chmod(join(profile, '.env'), 0o644);
      await chmod(profile, 0o755);
      await turn(home, { OPENROUTER_API_KEY: `${KEY}rotated` });
      expect(await modeOf(join(profile, '.env'))).toBe(0o600);
      expect(await modeOf(profile)).toBe(0o700);
    });
  });

  test('neither a refused value nor a failed write puts the key in the error', async () => {
    await withHome(async (home) => {
      const multiline = `${KEY}\nINJECTED=1`;
      const refused = turn(home, { OPENROUTER_API_KEY: multiline });
      await expect(refused).rejects.toThrow('OPENROUTER_API_KEY contains characters');
      await refused.catch((error) => expect(`${error.message}${error.stack}`).not.toContain(KEY));
      await expect(readFile(join(home, 'profile', '.env'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      await mkdir(join(home, 'profile', '.env'), { recursive: true });
      const failed = turn(home, { OPENROUTER_API_KEY: KEY });
      await expect(failed).rejects.toThrow('Hermes profile .env');
      await failed.catch((error) => expect(`${error.message}${error.stack}`).not.toContain(KEY));
      expect((await readdir(join(home, 'profile'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });
});
