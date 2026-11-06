/**
 * Qwen and Goose ask their harness for `--version` without blocking the
 * daemon's event loop, and ask once per binary (tested-version.js
 * probeVersion). The daemon hosts every seat and the loopback provider proxies
 * of their live turns in one process, so a synchronous probe stalled all of
 * them while a cold harness started. Real fake binaries, no child_process mock:
 * a synchronous probe of a binary that sleeps is what the timer test catches.
 */
import { EventEmitter } from 'node:events';
import {
  chmod, mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as childProcess from 'node:child_process';
import { realpathSync } from 'node:fs';
import qwen, { TESTED_QWEN_VERSIONS } from '../src/lib/adapters/qwen.js';
import goose, { TESTED_GOOSE_VERSIONS } from '../src/lib/adapters/goose.js';
import { meetsMinimumVersion, probeVersion } from '../src/lib/adapters/tested-version.js';

let root;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'version-probe-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// A harness binary whose --version sleeps, answers, and counts every probe.
// `requireEnvFile` names a variable whose file the harness reads AFTER the
// sleep, as qwen reads its settings: a probe whose environment is torn down
// before the harness answers fails, and answers nothing.
const fakeHarness = async (name, version, sleepMs = 0, { dir = join(root, 'bin'), requireEnvFile = null } = {}) => {
  const binary = join(dir, name);
  const counter = join(root, `${name}-${dir.split('/').pop()}-probes.log`);
  await mkdir(dir, { recursive: true });
  await writeFile(binary, [
    `#!${process.execPath}`,
    'const fs = require("fs");',
    'if (process.argv.includes("--version")) {',
    `  fs.appendFileSync(${JSON.stringify(counter)}, "x");`,
    '  setTimeout(() => {',
    ...(requireEnvFile ? [`    fs.readFileSync(process.env[${JSON.stringify(requireEnvFile)}]);`] : []),
    `    process.stdout.write(${JSON.stringify(`${version}\n`)});`,
    `  }, ${sleepMs});`,
    '}',
    '',
  ].join('\n'));
  await chmod(binary, 0o755);
  return { binary, probes: async () => (await readFile(counter, 'utf8').catch(() => '')).length };
};

const fakeChild = (stdout) => () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  setTimeout(() => { proc.stdout.emit('data', Buffer.from(stdout)); proc.emit('close', 0); }, 5);
  return proc;
};

const ticksDuring = async (run) => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  try { await run(); } finally { clearInterval(timer); }
  return ticks;
};

const qwenCtx = async (binary) => {
  const cwd = join(root, 'workspace');
  const keyFile = join(root, 'provider-key');
  await mkdir(cwd, { recursive: true });
  await writeFile(keyFile, 'upstream-secret', { mode: 0o600 });
  return {
    cwd, agentName: 'qwen-probe', runtimeToken: 'cm_agent_probe', instanceUrl: 'https://api.commonly.me',
    _binaryPath: binary, _platform: 'darwin', _wrapArgvWithSeatbelt: (argv) => argv,
    _spawnImpl: fakeChild('{"type":"result","result":"ok"}\n'),
    env: { PATH: '/usr/bin' },
    environment: {
      model: 'probe-model',
      provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
      sandbox: { trust: 'public', mode: 'workspace' },
      mcp: [],
    },
  };
};

const gooseCtx = (binary) => ({
  cwd: process.cwd(), agentName: 'goose-probe', runtimeToken: 'cm_agent_probe', instanceUrl: 'https://api.commonly.me',
  _binaryPath: binary,
  _spawnImpl: fakeChild(`${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], metadata: { userVisible: true } } })}\n${JSON.stringify({ type: 'complete' })}\n`),
  env: { PATH: '/usr/bin', COMMONLY_LITELLM_KEY: 'litellm-probe-key' },
  environment: { model: 'probe-model', mcp: [] },
});

describe('qwen', () => {
  test('a timer keeps firing while a slow qwen answers --version', async () => {
    // The settings file lives in the probe home, so this also fails if that home
    // is removed before the probe answers (withProbeEnv must await it).
    const { binary } = await fakeHarness('qwen', TESTED_QWEN_VERSIONS[0], 400, {
      requireEnvFile: 'QWEN_CODE_SYSTEM_SETTINGS_PATH',
    });
    const ctx = await qwenCtx(binary);
    let result;
    expect(await ticksDuring(async () => { result = await qwen.spawn('hi', ctx); })).toBeGreaterThanOrEqual(8);
    // A public seat refuses an unknown version, so a reply means the probe read 0.25.1.
    expect(result.text).toBe('ok');
  });

  test('a second turn on the same binary does not probe again', async () => {
    const { binary, probes } = await fakeHarness('qwen', TESTED_QWEN_VERSIONS[0]);
    for (let i = 0; i < 2; i += 1) {
      expect((await qwen.spawn('hi', await qwenCtx(binary))).text).toBe('ok');
    }
    expect(await probes()).toBe(1);
  });
});

describe('goose', () => {
  test('a timer keeps firing while a slow goose answers --version', async () => {
    const { binary } = await fakeHarness('goose', TESTED_GOOSE_VERSIONS[0], 400);
    expect(await ticksDuring(() => goose.spawn('hi', gooseCtx(binary)))).toBeGreaterThanOrEqual(8);
  });

  test('a second turn on the same binary does not probe again', async () => {
    const { binary, probes } = await fakeHarness('goose', TESTED_GOOSE_VERSIONS[0]);
    for (let i = 0; i < 2; i += 1) {
      expect((await goose.spawn('hi', gooseCtx(binary))).text).toBe('ok');
    }
    expect(await probes()).toBe(1);
  });
});

describe('a bare binary name', () => {
  // Private goose launches 'goose', and qwen falls back to 'qwen': names that
  // execFile resolves through PATH. The cache key has to follow the same PATH.
  const parse = (out) => String(out).trim().match(/\d+\.\d+\.\d+/)?.[0] || null;
  const inDir = async (dir, run) => {
    const before = process.cwd();
    process.chdir(dir);
    try { return await run(); } finally { process.chdir(before); }
  };

  test('a private goose turn with no _binaryPath reuses the cache on the second turn', async () => {
    const { probes } = await fakeHarness('goose', TESTED_GOOSE_VERSIONS[0]);
    for (let i = 0; i < 2; i += 1) {
      const ctx = gooseCtx(undefined);
      delete ctx._binaryPath;
      ctx.env = { ...ctx.env, PATH: `${join(root, 'bin')}:/usr/bin` };
      expect((await goose.spawn('hi', ctx)).text).toBe('ok');
    }
    expect(await probes()).toBe(1);
  });

  test('a file named like the binary in the working directory is neither the key nor what runs', async () => {
    const onPath = await fakeHarness('harness', '1.2.3');
    const decoy = await fakeHarness('harness', '9.9.9', 0, { dir: join(root, 'cwd') });
    const cache = new Map();
    const ran = [];
    const execFileImpl = (cmd, ...rest) => { ran.push(cmd); return childProcess.execFile(cmd, ...rest); };
    const version = await inDir(join(root, 'cwd'), () => probeVersion('harness', {
      env: { PATH: join(root, 'bin') }, parse, cache, execFileImpl,
    }));
    expect(version).toBe('1.2.3');
    expect([...cache.keys()]).toEqual([realpathSync(onPath.binary)]);
    // The resolved real path is what executes, so a retarget between the key
    // and the run cannot swap the binary.
    expect(ran).toEqual([realpathSync(onPath.binary)]);
    expect(await decoy.probes()).toBe(0);
  });

  test('a bare name not on PATH is not cached, even when the working directory has one', async () => {
    await fakeHarness('cwd-only', '1.2.3', 0, { dir: join(root, 'cwd') });
    await mkdir(join(root, 'empty'));
    const cache = new Map();
    await inDir(join(root, 'cwd'), () => probeVersion('cwd-only', {
      env: { PATH: join(root, 'empty') }, parse, cache,
    }));
    expect(cache.size).toBe(0);
  });

  test('a launch with its own argv runs that argv, and is asked every time', async () => {
    const script = join(root, 'launcher.cjs');
    await writeFile(script, 'console.log(process.argv.slice(2).join(" ") === "--version" ? "1.2.3" : "wrong argv");\n');
    const cache = new Map();
    const ran = [];
    const execFileImpl = (cmd, args, ...rest) => { ran.push(args); return childProcess.execFile(cmd, args, ...rest); };
    const ask = () => probeVersion(process.execPath, {
      args: [script], env: {}, parse, cache, execFileImpl,
    });
    expect(await ask()).toBe('1.2.3');
    expect(await ask()).toBe('1.2.3');
    // The interpreter's path says nothing about which script it would run.
    expect(cache.size).toBe(0);
    expect(ran).toEqual([[script, '--version'], [script, '--version']]);
  });
});

describe('meetsMinimumVersion', () => {
  test.each([
    ['0.159.3', true],
    ['0.159.4', true],
    ['0.160.0', true],
    ['1.0.0', true],
    ['0.170.0-beta.2', true],
    ['0.159.2', false],
    ['0.158.9', false],
    ['0.159.3-alpha.1', false],
    ['0.159', false],
    ['0.159.3/../x', false],
    ['v0.159.3', false],
    ['unknown', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('%s against 0.159.3: %s', (version, meets) => {
    expect(meetsMinimumVersion(version, '0.159.3')).toBe(meets);
  });
});
