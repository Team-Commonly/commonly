/**
 * A public Codex seat runs a turn only on a tested Codex version. Fake binaries
 * and a fake spawn, so this holds in CI, where no Codex is installed. The
 * confinement itself is measured against the real binary in
 * adapters.codex.public-tools.test.mjs.
 */
import { EventEmitter } from 'node:events';
import {
  chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import codex, { PUBLIC_CODEX_MIN_VERSION } from '../src/lib/adapters/codex.js';
import { PUBLIC_CODEX_VERSION_CODE } from '../src/lib/adapters/tested-version.js';
import { currentJsShim, fakeFs } from './fixtures/windows-shims.cjs';

const PUBLIC = { trust: 'public', mode: 'workspace' };

let root;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'codex-version-floor-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const fakeChild = () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from('{"type":"turn.completed"}\n'));
    proc.emit('close', 0);
  }, 1);
  return proc;
};

const spawnRecorder = () => {
  const calls = [];
  return { calls, impl: (cmd, args) => { calls.push({ cmd, args }); return fakeChild(); } };
};

// A `codex` on PATH that counts its version probes. `body` is its shell script.
const fakeCodex = async (body) => {
  const dir = await mkdtemp(join(root, 'bin-'));
  const probes = join(dir, 'probes');
  await writeFile(join(dir, 'codex'), `#!/bin/sh\nprintf x >> ${JSON.stringify(probes)}\n${body}\n`);
  await chmod(join(dir, 'codex'), 0o755);
  return { path: `${dir}:/usr/bin:/bin`, probes: async () => (await readFile(probes, 'utf8').catch(() => '')).length };
};

const runSeat = async ({ sandbox = PUBLIC, version, path = '/nonexistent', ...rest } = {}) => {
  const { impl, calls } = spawnRecorder();
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  const outcome = await codex.spawn('hi', {
    cwd,
    agentName: 'floor-test',
    environment: { model: 'test-model', ...(sandbox ? { sandbox } : {}) },
    env: { PATH: path, HOME: root, CODEX_HOME: join(root, 'operator') },
    _publicCodexHome: join(root, 'public'),
    _spawnImpl: impl,
    ...(version !== undefined ? { _codexVersion: version } : {}),
    ...rest,
  }).then((value) => ({ value }), (error) => ({ error }));
  return { ...outcome, calls };
};

const publicHomeExists = () => stat(join(root, 'public')).then(() => true, () => false);

describe('a public seat needs a tested Codex version', () => {
  test('the floor is the version the confinement checks passed on', () => {
    expect(PUBLIC_CODEX_MIN_VERSION).toBe('0.159.3');
  });

  test.each([
    ['0.159.2'],
    ['0.149.1'],
    ['0.133.0'],
    ['0.125.0'],
    ['0.159.3-alpha.1'],
    [null],
    [''],
    ['unknown'],
  ])('%s runs no turn', async (version) => {
    const { error, calls } = await runSeat({ version });
    expect(error?.code).toBe(PUBLIC_CODEX_VERSION_CODE);
    expect(error.message).toContain(`at least ${PUBLIC_CODEX_MIN_VERSION}`);
    expect(calls).toEqual([]);
    expect(await publicHomeExists()).toBe(false);
  });

  test.each([
    ['0.159.3'],
    ['0.159.4'],
    ['0.160.0'],
    ['0.162.1'],
    ['0.164.0'],
    ['0.170.0-alpha.1'],
    ['1.0.0'],
  ])('%s runs the turn', async (version) => {
    const { error, calls } = await runSeat({ version });
    expect(error).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test('a read-only public seat is held to the same floor', async () => {
    const { error, calls } = await runSeat({ sandbox: { trust: 'public', mode: 'read-only' }, version: '0.149.1' });
    expect(error?.code).toBe(PUBLIC_CODEX_VERSION_CODE);
    expect(calls).toEqual([]);
  });

  test('the seat log names the version found and what to do', async () => {
    const { error } = await runSeat({ version: '0.149.1' });
    expect(error.message).toContain('Codex 0.149.1');
    expect(error.message).toContain('Upgrade Codex to at least 0.159.3');
  });

  test('a version that could not be read says so, and what to do', async () => {
    const { error } = await runSeat({ version: null });
    expect(error.message).toContain('could not read the Codex version');
    expect(error.message).toContain('`codex --version`');
    expect(error.message).toContain('at least 0.159.3');
  });
});

describe('the version comes from the binary on the seat\'s PATH', () => {
  test.each([
    ['a tested version', 'echo "codex-cli 0.162.1"', true],
    ['the floor itself', 'echo "codex-cli 0.159.3"', true],
    ['a noisy launcher', 'echo "starting up"\necho "codex-cli 0.162.1"', true],
    ['an older version', 'echo "codex-cli 0.149.1"', false],
    ['a prerelease of the floor', 'echo "codex-cli 0.159.3-alpha.1"', false],
    ['a failed probe', 'echo "codex-cli 0.162.1"\nexit 1', false],
    ['empty output', ':', false],
    ['output it cannot parse', 'echo "codex something new"', false],
    ['some other version on the line', 'echo "node 22.3.0"', false],
  ])('%s', async (_name, body, runs) => {
    const { path } = await fakeCodex(body);
    const { error, calls } = await runSeat({ path });
    if (runs) {
      expect(error).toBeUndefined();
      expect(calls).toHaveLength(1);
    } else {
      expect(error?.code).toBe(PUBLIC_CODEX_VERSION_CODE);
      expect(calls).toEqual([]);
    }
  });

  test('no codex on PATH runs no turn', async () => {
    const { error, calls } = await runSeat({});
    expect(error?.code).toBe(PUBLIC_CODEX_VERSION_CODE);
    expect(calls).toEqual([]);
  });

  test('a probe that hangs is timed out, and runs no turn', async () => {
    const { path } = await fakeCodex('exec sleep 20');
    const started = Date.now();
    const { error, calls } = await runSeat({ path, _versionProbe: { timeoutMs: 200 } });
    expect(error?.code).toBe(PUBLIC_CODEX_VERSION_CODE);
    expect(calls).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('the probe waits 30 s', async () => {
    const seen = [];
    await runSeat({
      _versionProbe: {
        execFileImpl: (_file, _args, options, done) => { seen.push(options.timeout); done(null, 'codex-cli 0.162.1\n'); },
      },
    });
    expect(seen).toEqual([30000]);
  });

  test('on Windows the probe runs what the turn launches, not the name', async () => {
    const npm = 'C:\\npm';
    const script = `${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const probed = [];
    const { error, calls } = await runSeat({
      _platform: 'win32',
      _commandResolution: {
        platform: 'win32',
        env: { Path: npm },
        execPath: 'C:\\node\\node.exe',
        ...fakeFs({
          [`${npm}\\codex.cmd`]: currentJsShim('node_modules\\@openai\\codex\\bin\\codex.js'),
          [script]: '',
        }),
      },
      _versionProbe: {
        execFileImpl: (file, args, _options, done) => { probed.push([file, ...args]); done(null, 'codex-cli 0.162.1\n'); },
      },
    });
    expect(error).toBeUndefined();
    expect(probed).toHaveLength(1);
    expect(probed[0].slice(-2)).toEqual([script, '--version']);
    expect(calls[0].cmd).toBe(probed[0][0]);
    expect(calls[0].args[0]).toBe(script);
  });
});

describe('a Windows launch that cannot be resolved', () => {
  test('is an unread version, not a turn', async () => {
    const { error, calls } = await runSeat({
      _platform: 'win32',
      _commandResolution: { platform: 'win32', env: { Path: 'C:\\empty' }, ...fakeFs({}) },
    });
    expect(error?.code).toBe(PUBLIC_CODEX_VERSION_CODE);
    expect(calls).toEqual([]);
  });
});

describe('an internal seat keeps working on any version', () => {
  test.each([
    ['0.100.0'],
    ['0.149.1'],
    [null],
    ['unknown'],
  ])('%s runs the turn', async (version) => {
    const { error, calls } = await runSeat({ sandbox: null, version });
    expect(error).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test('it never asks for the version, so a broken probe costs it nothing', async () => {
    const { path, probes } = await fakeCodex('exit 1');
    const { error, calls } = await runSeat({ sandbox: null, path });
    expect(error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(await probes()).toBe(0);
  });

  test('a legacy trust value resolves to public, so it is held to the floor', async () => {
    const { error, calls } = await runSeat({ sandbox: { trust: 'internal' }, version: '0.149.1' });
    expect(error?.code).toBe(PUBLIC_CODEX_VERSION_CODE);
    expect(calls).toEqual([]);
  });
});
