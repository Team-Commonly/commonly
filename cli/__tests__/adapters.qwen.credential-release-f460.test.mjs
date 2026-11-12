/**
 * F460 on Qwen. A public Qwen seat's runtime credential file is deleted once
 * our Commonly server has written its ready file (in the seat home, the one
 * folder the jail writes), or at the deadline. A delete that fails ends the
 * turn. A warm build from before ready files is refused on a public seat.
 */
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import {
  chmodSync, existsSync, readFileSync, rmSync,
} from 'fs';
import {
  chmod, mkdir, mkdtemp, rm, symlink, writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const spawnSyncMock = jest.fn();
await jest.unstable_mockModule('child_process', () => ({
  spawnSync: spawnSyncMock,
  spawn: jest.fn(),
  execFile: (cmd, args, options, callback) => {
    const result = spawnSyncMock(cmd, args, options) || {};
    setImmediate(() => callback(result.status === 0 && !result.error ? null : (result.error || new Error('exit')), result.stdout || ''));
  },
}));
const { default: qwen, TESTED_QWEN_VERSIONS } = await import('../src/lib/adapters/qwen.js');

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation((_cmd, args = []) => (args[0] === '--version'
    ? { status: 0, stdout: `${TESTED_QWEN_VERSIONS.at(-1)}\n` }
    : { status: 0, stdout: '/usr/local/bin/qwen\n' }));
});

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// A Qwen whose Commonly server writes its ready file (or not), then answers
// after `turnMs`. Records whether the credential existed at start and at end.
const fakeQwen = ({ writeReady = true, turnMs = 400 } = {}) => {
  const seen = {};
  const impl = (_cmd, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn(() => { setTimeout(() => proc.emit('close', null), 5); });
    const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
    const env = config.mcpServers.commonly?.env || {};
    seen.tokenFile = env.COMMONLY_TOKEN_FILE;
    seen.readyFile = env.COMMONLY_MCP_READY_FILE;
    seen.atStart = Boolean(seen.tokenFile && existsSync(seen.tokenFile));
    setTimeout(async () => {
      if (writeReady && seen.readyFile) await writeFile(seen.readyFile, 'ready\n');
      await sleep(turnMs);
      seen.atEnd = Boolean(seen.tokenFile && existsSync(seen.tokenFile));
      if (proc.kill.mock.calls.length) return;
      proc.stdout.emit('data', Buffer.from('{"type":"result","result":"Qwen reply"}\n'));
      proc.emit('close', 0);
    }, 10);
    return proc;
  };
  return { impl, seen };
};

const withSeat = async (fn, { readyFile = true } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-f460-'));
  const cwd = join(root, 'workspace');
  const keyFile = join(root, 'provider-key');
  const packageDir = join(root, 'qwen-package');
  const binDir = join(root, 'npm', 'bin');
  const binary = join(binDir, 'qwen');
  const mcpHome = join(root, 'mcp-home');
  const mcpPackage = join(mcpHome, '0.3.20', 'node_modules', '@commonlyai', 'mcp');
  await mkdir(cwd);
  await mkdir(packageDir);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(mcpPackage, 'src'), { recursive: true });
  await writeFile(join(packageDir, 'cli.js'), '#!/usr/bin/env node\n');
  await symlink(join(packageDir, 'cli.js'), binary);
  await writeFile(keyFile, 'upstream-secret', { mode: 0o600 });
  await chmod(keyFile, 0o600);
  await writeFile(join(mcpPackage, 'package.json'), JSON.stringify({
    name: '@commonlyai/mcp', version: '0.3.20', bin: { 'commonly-mcp': 'src/index.js' },
    ...(readyFile ? { commonly: { readyFile: true } } : {}),
  }));
  await writeFile(join(mcpPackage, 'src', 'index.js'), '#!/usr/bin/env node\n');
  await writeFile(join(mcpHome, 'current'), '0.3.20\n');
  await writeFile(join(mcpHome, '.warm.lock'), 'warming\n');
  const prior = process.env.COMMONLY_MCP_HOME;
  process.env.COMMONLY_MCP_HOME = mcpHome;
  const ctx = {
    cwd, agentName: 'qwen-f460', runtimeToken: 'cm_agent_f460_token',
    instanceUrl: 'https://api.commonly.me', _binaryPath: binary,
    _platform: 'darwin', _wrapArgvWithSeatbelt: (argv) => argv,
    env: { PATH: '/usr/bin' },
    environment: {
      model: 'example-model',
      provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
      sandbox: { trust: 'public', mode: 'workspace' },
      mcp: [{
        name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'],
        env: { COMMONLY_API_URL: '${COMMONLY_API_URL}', COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' },
      }],
    },
  };
  try {
    await fn(ctx);
  } finally {
    if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
    else process.env.COMMONLY_MCP_HOME = prior;
    await rm(root, { recursive: true, force: true });
  }
};

test('the credential is gone once the Commonly server has written its ready file', async () => {
  await withSeat(async (ctx) => {
    const fake = fakeQwen();
    const result = await qwen.spawn('hello', { ...ctx, _spawnImpl: fake.impl });
    expect(result.text).toBe('Qwen reply');
    expect(fake.seen.readyFile).toEqual(expect.stringContaining('mcp-ready'));
    expect(fake.seen.atStart).toBe(true);
    expect(fake.seen.atEnd).toBe(false);
  });
});

test('a server that never gets ready: the credential still goes, at the deadline', async () => {
  await withSeat(async (ctx) => {
    const fake = fakeQwen({ writeReady: false, turnMs: 500 });
    const warn = jest.fn();
    await qwen.spawn('hello', { ...ctx, _spawnImpl: fake.impl, _credentialRelease: { deadlineMs: 150, warn } });
    expect(fake.seen.atStart).toBe(true);
    expect(fake.seen.atEnd).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/public Qwen seat: MCP servers not ready .*deleted anyway/));
  });
});

test('a delete that fails ends the turn and kills Qwen', async () => {
  await withSeat(async (ctx) => {
    const fake = fakeQwen();
    await expect(qwen.spawn('hello', {
      ...ctx,
      _spawnImpl: fake.impl,
      _credentialRelease: { fs: { rmSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }, existsSync } },
    })).rejects.toThrow(/could not delete its runtime credential.*EPERM/);
  });
});

// A delete made to fail for real, as the walk of the published build did: the
// folder holding the credential is read-only, so the release cannot delete it
// and the adapter's own cleanup cannot remove that folder either. The turn ends
// with the release's error, not the cleanup's. Root ignores the mode, so skip.
const asRoot = process.getuid?.() === 0;
(asRoot ? test.skip : test)('a delete that fails for real ends the turn with the release error, not the cleanup one', async () => {
  await withSeat(async (ctx) => {
    let locked = null;
    const fake = fakeQwen({ turnMs: 600 });
    const impl = (...args) => {
      const child = fake.impl(...args);
      locked = dirname(dirname(fake.seen.tokenFile));
      chmodSync(locked, 0o500);
      return child;
    };
    try {
      await expect(qwen.spawn('hello', { ...ctx, _spawnImpl: impl })).rejects.toThrow(/could not delete its runtime credential/);
    } finally {
      if (locked) { chmodSync(locked, 0o700); rmSync(locked, { recursive: true, force: true }); }
    }
  });
});

test('a warm build from before ready files is refused before Qwen runs', async () => {
  await withSeat(async (ctx) => {
    const fake = fakeQwen();
    await expect(qwen.spawn('hello', { ...ctx, _spawnImpl: fake.impl })).rejects.toThrow(/update @commonlyai\/mcp/);
    expect(fake.seen.tokenFile).toBeUndefined();
  }, { readyFile: false });
});
