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
import qwen, { TESTED_QWEN_VERSIONS } from '../src/lib/adapters/qwen.js';
import goose, { TESTED_GOOSE_VERSIONS } from '../src/lib/adapters/goose.js';

let root;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'version-probe-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// A harness binary whose --version sleeps, answers, and counts every probe.
const fakeHarness = async (name, version, sleepMs = 0) => {
  const binary = join(root, 'bin', name);
  const counter = join(root, `${name}-probes.log`);
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(binary, [
    `#!${process.execPath}`,
    'if (process.argv.includes("--version")) {',
    `  require("fs").appendFileSync(${JSON.stringify(counter)}, "x");`,
    `  setTimeout(() => process.stdout.write(${JSON.stringify(`${version}\n`)}), ${sleepMs});`,
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
    const { binary } = await fakeHarness('qwen', TESTED_QWEN_VERSIONS[0], 400);
    const ctx = await qwenCtx(binary);
    expect(await ticksDuring(() => qwen.spawn('hi', ctx))).toBeGreaterThanOrEqual(8);
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
