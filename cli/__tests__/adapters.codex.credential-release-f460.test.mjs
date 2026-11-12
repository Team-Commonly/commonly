/**
 * F460 on codex. A public codex seat's runtime credential file is deleted once
 * every MCP reader has it: our Commonly server and the grant-broker bridge each
 * name a ready file (COMMONLY_MCP_READY_FILE) and write it after reading the
 * credential. A server that never gets ready costs the deadline, not the turn's
 * whole length. A public seat on a warm build without ready files is refused;
 * a private seat is unchanged.
 */
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import {
  mkdir, mkdtemp, rm, writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

await jest.unstable_mockModule('child_process', () => ({
  spawnSync: jest.fn(() => ({ status: 1, stdout: '', stderr: '' })),
  spawn: jest.fn(),
}));
const { default: codexAdapter } = await import('../src/lib/adapters/codex.js');

const codex = {
  spawn: (prompt, ctx) => codexAdapter.spawn(prompt, {
    _codexVersion: '0.162.1', _refuseCodeRunningGitSetup: () => {}, _platform: 'darwin', ...ctx,
  }),
};

const TOKEN = 'cm_agent_'.padEnd(73, 'R');
const SHIPPED = { name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] };
const BROKER = {
  name: 'commonly-grant-broker',
  transport: 'http',
  url: '${COMMONLY_API_URL}/api/mcp/grants/g1',
  headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
};

const readyPathsOf = (args) => args
  .map((a, i) => (a === '-c' ? args[i + 1] : null))
  .filter((flag) => flag && /\.env=\{/.test(flag))
  .flatMap((flag) => [...flag.matchAll(/COMMONLY_MCP_READY_FILE = "([^"]+)"/g)].map((m) => m[1]));

const outputFileOf = (args) => args[args.indexOf('-o') + 1];
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// A codex that starts its MCP servers, which write their ready files (or not),
// then runs for `turnMs` and finishes. It records whether the credential file
// existed at start and at the end of its turn.
const fakeCodex = ({ writeReady = true, turnMs = 400 } = {}) => {
  const seen = {};
  const impl = (_cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn(() => { setTimeout(() => proc.emit('close', null, 'SIGKILL'), 5); });
    const tokenFile = opts.env.COMMONLY_TOKEN_FILE;
    seen.tokenFile = tokenFile;
    seen.proc = proc;
    seen.readyPaths = readyPathsOf(args);
    seen.atStart = Boolean(tokenFile && existsSync(tokenFile));
    setTimeout(async () => {
      if (writeReady) for (const path of seen.readyPaths) await writeFile(path, 'ready\n');
      await sleep(turnMs);
      seen.atEnd = Boolean(tokenFile && existsSync(tokenFile));
      if (proc.kill.mock.calls.length) return;
      proc.stdout.emit('data', Buffer.from('{"type":"turn.completed"}\n'));
      await writeFile(outputFileOf(args), 'ok', 'utf8');
      proc.emit('close', 0, null);
    }, 10);
    return proc;
  };
  return { impl, seen };
};

let mcpHome;
let publicHome;
let priorHome;
const warmBuild = async ({ readyFile }) => {
  const pkgDir = join(mcpHome, '0.3.20', 'node_modules', '@commonlyai', 'mcp');
  await mkdir(join(pkgDir, 'src'), { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
    name: '@commonlyai/mcp', version: '0.3.20', bin: { 'commonly-mcp': 'src/index.js' },
    ...(readyFile ? { commonly: { readyFile: true } } : {}),
  }));
  await writeFile(join(pkgDir, 'src', 'index.js'), '');
  await writeFile(join(mcpHome, 'current'), '0.3.20\n');
  await writeFile(join(mcpHome, '.warm.lock'), 'warming\n');
};

beforeEach(async () => {
  mcpHome = await mkdtemp(join(tmpdir(), 'codex-f460-mcp-'));
  publicHome = await mkdtemp(join(tmpdir(), 'codex-f460-public-'));
  priorHome = process.env.COMMONLY_MCP_HOME;
  process.env.COMMONLY_MCP_HOME = mcpHome;
});
afterEach(async () => {
  if (priorHome === undefined) delete process.env.COMMONLY_MCP_HOME;
  else process.env.COMMONLY_MCP_HOME = priorHome;
  await rm(mcpHome, { recursive: true, force: true });
  await rm(publicHome, { recursive: true, force: true });
});

const publicTurn = (fake, { mcp = [SHIPPED], extra = {} } = {}) => codex.spawn('hi', {
  cwd: '/tmp/public-workspace',
  runtimeToken: TOKEN,
  instanceUrl: 'https://api.example.test',
  environment: { model: 'test-model', sandbox: { trust: 'public', mode: 'workspace' }, mcp },
  memoryLongTerm: '',
  _publicCodexHome: publicHome,
  _spawnImpl: fake.impl,
  ...extra,
});

describe('a public codex seat', () => {
  test('the credential is gone once our server and the bridge have written their ready files', async () => {
    await warmBuild({ readyFile: true });
    const fake = fakeCodex();
    const result = await publicTurn(fake, { mcp: [SHIPPED, BROKER] });
    expect(result.text).toBe('ok');
    expect(fake.seen.readyPaths).toHaveLength(2);
    expect(fake.seen.atStart).toBe(true);
    expect(fake.seen.atEnd).toBe(false);
  });

  test('a server that never gets ready: the credential still goes, at the deadline', async () => {
    await warmBuild({ readyFile: true });
    const fake = fakeCodex({ writeReady: false, turnMs: 500 });
    const warn = jest.fn();
    await publicTurn(fake, { extra: { _credentialRelease: { deadlineMs: 150, warn } } });
    expect(fake.seen.atStart).toBe(true);
    expect(fake.seen.atEnd).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/public codex seat: MCP servers not ready .*deleted anyway/));
  });

  test('a delete that fails ends the turn and kills codex', async () => {
    await warmBuild({ readyFile: true });
    const fake = fakeCodex();
    await expect(publicTurn(fake, {
      extra: {
        _credentialRelease: {
          fs: { rmSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }, existsSync },
        },
      },
    })).rejects.toThrow(/could not delete its runtime credential.*EPERM/);
    expect(fake.seen.proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  // Opus review HOLD 3: with no reader to wait for, the release runs as it is
  // armed; a delete that fails there ends the turn before Codex starts.
  test('a delete that fails as the release is armed ends the turn before codex starts', async () => {
    await warmBuild({ readyFile: true });
    const fake = fakeCodex();
    await expect(publicTurn(fake, {
      mcp: [],
      extra: {
        _credentialRelease: {
          fs: { rmSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }, existsSync },
        },
      },
    })).rejects.toThrow(/could not delete its runtime credential.*EPERM/);
    expect(fake.seen.proc).toBeUndefined();
  });

  // Opus review HOLD 4: an entry skipped because it wants the token in argv
  // never starts, so no ready file is named for it and nothing waits for one.
  test('a server skipped for a token in its argv is not waited for', async () => {
    await warmBuild({ readyFile: true });
    const fake = fakeCodex();
    const warn = jest.fn();
    await publicTurn(fake, {
      // Our package by path, so it would be named a ready file, then refused as
      // unreportable, if the name came before the skip.
      mcp: [SHIPPED, { name: 'commonly-argv', transport: 'stdio', command: [
        'node', join(mcpHome, '0.3.20', 'node_modules', '@commonlyai', 'mcp', 'src', 'index.js'),
        '--token', '${COMMONLY_AGENT_TOKEN}',
      ] }],
      extra: { _credentialRelease: { deadlineMs: 150, warn } },
    });
    expect(fake.seen.readyPaths).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test('a warm build from before ready files is refused before codex runs', async () => {
    await warmBuild({ readyFile: false });
    const fake = fakeCodex();
    await expect(publicTurn(fake)).rejects.toThrow(/update @commonlyai\/mcp/);
    expect(fake.seen.readyPaths).toBeUndefined();
  });
});

test('reverse: a private seat names no ready file and keeps its credential for the turn', async () => {
  await warmBuild({ readyFile: true });
  const fake = fakeCodex();
  await codex.spawn('hi', {
    cwd: '/tmp/private-workspace',
    runtimeToken: TOKEN,
    instanceUrl: 'https://api.example.test',
    environment: { model: 'test-model', mcp: [SHIPPED] },
    _spawnImpl: fake.impl,
  });
  expect(fake.seen.readyPaths).toEqual([]);
  expect(fake.seen.atEnd).toBe(true);
});
