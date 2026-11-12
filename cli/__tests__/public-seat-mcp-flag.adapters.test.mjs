// The public-seat MCP flag (src/lib/public-seat-mcp-flag.js) is declared as a
// literal env key on the shipped Commonly MCP entry, and the MCP server reads it
// from its own process environment (commonly-mcp/src/public-seat-gate.js). That
// only works if every adapter hands the declared key to the server it starts.
// This file spawns a public seat through each adapter that runs public seats,
// with the flag declared, and reads the MCP launch config the adapter produced.
// goose once refused the key outright, so a public goose seat would not start.
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { mkdir, mkdtemp, rm, symlink, writeFile, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { currentJsShim, fakeFs } from './fixtures/windows-shims.cjs';

const FLAG = 'COMMONLY_MCP_PUBLIC_SEAT';

const spawnSyncMock = jest.fn();
await jest.unstable_mockModule('child_process', () => ({
  spawnSync: spawnSyncMock,
  spawn: jest.fn(),
  execFile: (cmd, args, options, callback) => {
    const result = spawnSyncMock(cmd, args, options) || {};
    setImmediate(() => callback(result.status === 0 && !result.error ? null : (result.error || new Error('exit')), result.stdout || ''));
  },
}));

const claude = (await import('../src/lib/adapters/claude.js')).default;
const codexAdapter = (await import('../src/lib/adapters/codex.js')).default;
const opencode = (await import('../src/lib/adapters/opencode.js')).default;
const { default: qwen, TESTED_QWEN_VERSIONS } = await import('../src/lib/adapters/qwen.js');
const { default: goose, TESTED_GOOSE_VERSIONS } = await import('../src/lib/adapters/goose.js');
const { resolveMcpServers } = await import('../src/lib/adapters/pi.js');
const { connectStdioMcp } = await import('../src/lib/adapters/pi-mcp-client.mjs');
const { withPublicSeatMcpFlag } = await import('../src/lib/public-seat-mcp-flag.js');
const { commonlyMcpServer } = await import('../src/lib/default-environment.js');

const OPENCODE_VERSION = '1.19.4';

// What a public seat's environment looks like after agent.js has flagged it.
const flaggedMcp = () => withPublicSeatMcpFlag({ mcp: [commonlyMcpServer()] }).mcp;

let root;
let mcpHome;
let priorHome;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'public-seat-flag-'));
  // A host-prepared MCP build: public seats never run npx from the jail.
  mcpHome = join(root, 'mcp-home');
  const pkgDir = join(mcpHome, '0.3.13', 'node_modules', '@commonlyai', 'mcp');
  await mkdir(join(pkgDir, 'src'), { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
    name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': 'src/index.js' }, commonly: { readyFile: true },
  }));
  await writeFile(join(pkgDir, 'src', 'index.js'), '');
  await writeFile(join(mcpHome, 'current'), '0.3.13\n');
  // A held warm lock keeps prepareMcpSpawn from starting a real warm.
  await writeFile(join(mcpHome, '.warm.lock'), 'warming\n');
  priorHome = process.env.COMMONLY_MCP_HOME;
  process.env.COMMONLY_MCP_HOME = mcpHome;
});

afterAll(async () => {
  if (priorHome === undefined) delete process.env.COMMONLY_MCP_HOME;
  else process.env.COMMONLY_MCP_HOME = priorHome;
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation((cmd, args = []) => {
    if (args[0] === '--version') {
      if (String(cmd).includes('opencode')) return { status: 0, stdout: `OpenCode ${OPENCODE_VERSION}\n` };
      return { status: 0, stdout: `${TESTED_QWEN_VERSIONS.at(-1)}\n` };
    }
    return { status: 0, stdout: `${cmd}\n` };
  });
});

const fakeChild = (stdout = '') => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn(() => proc.emit('close', null));
  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  }, 0);
  return proc;
};

const keyFileIn = async (name) => {
  const keyFile = join(root, name);
  await writeFile(keyFile, 'upstream-secret', { mode: 0o600 });
  await chmod(keyFile, 0o600);
  return keyFile;
};

// ---- claude ---------------------------------------------------------------
const NODEJS = 'C:\\Program Files\\nodejs';
const NODE = `${NODEJS}\\node.exe`;
const NPM = 'C:\\Users\\ada\\AppData\\Roaming\\npm';
const CLAUDE_JS = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
const windows = () => ({
  platform: 'win32',
  env: { Path: `C:\\Windows\\System32;${NODEJS};${NPM}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
  execPath: NODE,
  ...fakeFs({
    [`${NPM}\\claude.cmd`]: currentJsShim('node_modules\\@anthropic-ai\\claude-code\\cli.js'),
    [CLAUDE_JS]: '',
    [NODE]: 'MZ',
  }),
});

test("a public claude seat's Commonly server gets the public-seat flag", async () => {
  const seen = [];
  await claude.spawn('hello from a stranger', {
    environment: { model: 'test-model', sandbox: { trust: 'public' }, mcp: flaggedMcp() },
    sessionId: null,
    hostUnconfined: true,
    runtimeToken: 'cm_agent_test_runtime_token',
    instanceUrl: 'https://api.commonly.me',
    _spawnImpl: (cmd, args) => {
      const at = args.indexOf('--mcp-config');
      // The config is removed when the turn ends, so read it while it exists.
      seen.push(JSON.parse(readFileSync(args[at + 1], 'utf8')));
      return fakeChild('ok');
    },
    _commandResolution: windows(),
    _platform: 'win32',
    _home: 'C:\\Users\\ada',
    env: {
      Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\ada',
      APPDATA: 'C:\\Users\\ada\\AppData\\Roaming',
    },
    // The fake child never shows the server connected, so the turn is withheld;
    // the launch config is what this test reads.
  }).catch((error) => { if (!seen.length) throw error; });
  expect(seen).toHaveLength(1);
  expect(seen[0].mcpServers.commonly.env[FLAG]).toBe('1');
});

// ---- codex ----------------------------------------------------------------
test("a public codex seat's Commonly server gets the public-seat flag", async () => {
  const calls = [];
  await codexAdapter.spawn('work safely', {
    _codexVersion: '0.162.1',
    _refuseCodeRunningGitSetup: () => {},
    sessionId: null,
    cwd: '/tmp/public-agent-workspace',
    environment: {
      model: 'test-model',
      sandbox: { mode: 'workspace', trust: 'public' },
      mcp: flaggedMcp(),
    },
    env: { ...process.env },
    agentName: 'flag-codex',
    runtimeToken: 'cm_agent_test_runtime_token',
    instanceUrl: 'https://api.commonly.me',
    _publicCodexHome: join(root, 'public-codex'),
    _spawnImpl: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const out = args[args.indexOf('-o') + 1];
      const proc = fakeChild('{"type":"turn.completed"}\n');
      writeFile(out, 'ok', 'utf8').catch(() => {});
      return proc;
    },
  });
  expect(calls).toHaveLength(1);
  const { args } = calls[0];
  const override = args.find((arg) => arg.startsWith('mcp_servers.commonly.env='));
  expect(override).toBeDefined();
  expect(override).toContain(`${FLAG} = "1"`);
});

// ---- opencode -------------------------------------------------------------
test("a public opencode seat's Commonly server gets the public-seat flag", async () => {
  const workspace = join(root, 'opencode-workspace');
  await mkdir(workspace, { recursive: true });
  const keyFile = await keyFileIn('opencode-key');
  const calls = [];
  const events = [
    { type: 'step_start', sessionID: 'ses-1', part: { type: 'step-start' } },
    { type: 'text', sessionID: 'ses-1', part: { type: 'text', text: 'hi', time: { end: 1 } } },
    { type: 'step_finish', sessionID: 'ses-1', part: { type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 1 } } },
  ].map((e) => `${JSON.stringify(e)}\n`).join('');
  await opencode.spawn('hello', {
    sessionId: null,
    cwd: workspace,
    env: { ...process.env },
    environment: {
      model: 'example-model',
      provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
      sandbox: { trust: 'public', mode: 'workspace' },
      mcp: flaggedMcp(),
    },
    runtimeToken: 'cm_agent_runtime_token',
    instanceUrl: 'https://api.commonly.me',
    agentName: 'flag-opencode',
    metadata: { event: { podId: 'pod-1' } },
    _binaryPath: '/usr/local/bin/opencode',
    _platform: 'darwin',
    _wrapArgvWithSeatbelt: (argv) => argv,
    _spawnImpl: (cmd, args, options) => {
      // The generated config is removed when the turn ends, so read it now.
      let config = null;
      try { config = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8')); } catch { /* reported below */ }
      calls.push({ config });
      return fakeChild(events);
    },
  }).catch((error) => { if (!calls.length) throw error; });
  expect(calls).toHaveLength(1);
  expect(calls[0].config.mcp.commonly.environment[FLAG]).toBe('1');
});

// ---- qwen -----------------------------------------------------------------
test("a public qwen seat's Commonly server gets the public-seat flag", async () => {
  const cwd = join(root, 'qwen-workspace');
  const packageDir = join(root, 'qwen-package');
  const binDir = join(root, 'npm', 'bin');
  const binary = join(binDir, 'qwen');
  await mkdir(cwd);
  await mkdir(packageDir);
  await mkdir(binDir, { recursive: true });
  await writeFile(join(packageDir, 'cli.js'), '#!/usr/bin/env node\n');
  await symlink(join(packageDir, 'cli.js'), binary);
  const keyFile = await keyFileIn('qwen-key');
  const calls = [];
  await qwen.spawn('hello', {
    cwd, agentName: 'flag-qwen', runtimeToken: 'cm_agent_test_token',
    instanceUrl: 'https://api.commonly.me', _binaryPath: binary,
    _platform: 'darwin', _wrapArgvWithSeatbelt: (argv) => argv,
    env: { PATH: '/usr/bin', HOME: '/Users/operator' },
    environment: {
      model: 'example-model',
      provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
      sandbox: { trust: 'public', mode: 'workspace' },
      mcp: flaggedMcp(),
    },
    _spawnImpl: (cmd, args) => {
      calls.push(JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')));
      return fakeChild('{"type":"result","result":"ok"}\n');
    },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].mcpServers.commonly.env[FLAG]).toBe('1');
});

// ---- goose ----------------------------------------------------------------
// goose refuses any declared env name outside a short allowlist, before the
// public branch builds the recipe. Without the flag on that list, a public goose
// seat failed to start at all once the CLI set the flag.
test("a public goose seat's Commonly server gets the public-seat flag", async () => {
  const keyFile = await keyFileIn('goose-key');
  const seen = [];
  await goose.spawn('hello', {
    agentName: 'flag-goose', cwd: process.cwd(), runtimeToken: 'cm_agent_test_runtime_token',
    instanceUrl: 'https://api.commonly.me', _version: TESTED_GOOSE_VERSIONS[0],
    env: { PATH: process.env.PATH, HOME: '/Users/operator', XDG_CONFIG_HOME: '/Users/operator/.config' },
    environment: {
      model: 'deepseek-v4-flash',
      mcp: flaggedMcp(),
      provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
      sandbox: { trust: 'public', mode: 'workspace' },
    },
    _binaryPath: '/usr/bin/true',
    _platform: 'darwin',
    _wrapArgvWithSeatbelt: (argv) => argv,
    _spawnImpl: (cmd, args) => {
      seen.push(JSON.parse(readFileSync(args[args.indexOf('--recipe') + 1], 'utf8')));
      return fakeChild('{"type":"complete","total_tokens":1}\n');
    },
  });
  expect(seen).toHaveLength(1);
  const extension = seen[0].extensions.find((entry) => entry.name === 'commonly');
  expect(extension.envs[FLAG]).toBe('1');
});

// ---- pi -------------------------------------------------------------------
// pi's bridge spawns the server itself: resolveMcpServers decides the declared
// env, and connectStdioMcp builds the child's environment from it.
test("a public pi seat's Commonly server gets the public-seat flag", async () => {
  const carried = resolveMcpServers(flaggedMcp(), {
    publicSeat: true,
    instanceUrl: 'https://api.commonly.me',
    runtimeToken: 'cm_agent_test_runtime_token',
  });
  expect(carried).toHaveLength(1);
  expect(carried[0].env[FLAG]).toBe('1');

  const spawned = [];
  const pending = connectStdioMcp(carried[0], {
    timeoutMs: 20,
    parentEnv: { PATH: '/usr/bin' },
    onWarn: () => {},
    spawnImpl: (cmd, args, opts) => {
      spawned.push(opts);
      const channel = Object.assign(new EventEmitter(), { end: () => {} });
      return Object.assign(fakeChild(), { stdin: { write: () => {}, end: () => {} }, stdio: [null, null, null, channel] });
    },
  });
  await Promise.resolve(pending).catch(() => {});
  expect(spawned).toHaveLength(1);
  expect(spawned[0].env[FLAG]).toBe('1');
});

// dsh (F115): a public seat's MCP entry carries the flag, declared or not, and
// a private seat refuses an MCP env it did not build.
test('a public dsh seat hands the Commonly MCP the flag; a private one never does', async () => {
  const { resolveCommonlyMcp } = await import('../src/lib/adapters/dsh.js');
  const base = { credentialFile: '/tmp/seat-token', instanceUrl: 'https://api.commonly.me' };
  expect(resolveCommonlyMcp([], { ...base, publicSeat: true }).config.env[FLAG]).toBe('1');
  const flagged = withPublicSeatMcpFlag({ mcp: [commonlyMcpServer()] }).mcp;
  expect(resolveCommonlyMcp(flagged, { ...base, publicSeat: true }).config.env[FLAG]).toBe('1');
  expect(resolveCommonlyMcp([], base).config.env[FLAG]).toBeUndefined();
  expect(() => resolveCommonlyMcp(flagged, base)).toThrow(/this spawn's credential file/);
});
