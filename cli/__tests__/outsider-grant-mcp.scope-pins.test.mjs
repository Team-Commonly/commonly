// A confined seat's declared `environment.mcp` list is the whole set of MCP
// servers it runs with only because every adapter keeps user-scope and
// project-scope MCP config out of the child it spawns. The outsider-grant check
// in `src/lib/outsider-grant-mcp.js` reads the declared list and nothing else.
// This file pins the exclusions in one place: if an adapter starts loading the
// operator's own MCP config (`~/.claude.json`, `<cwd>/.mcp.json`,
// `~/.codex/config.toml`, the operator's opencode config, and so on) for a
// public or workspace seat, a test here fails, and the failure names the
// outsider-grant check that would otherwise stop being sound.
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { currentJsShim, fakeFs } from './fixtures/windows-shims.cjs';

const WHY = 'outsider-grant-mcp.js assumes a confined seat loads no user or project MCP config';

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
const { buildArgs: piBuildArgs } = await import('../src/lib/adapters/pi.js');
const { commonlyMcpServer } = await import('../src/lib/default-environment.js');

const OPENCODE_VERSION = '1.19.4';

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

const tempRoot = async (fn) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-scope-pins-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
};

// ---- claude ---------------------------------------------------------------
// Windows with `hostUnconfined: true` keeps the public policy flags and needs
// the least mocking (see adapters.claude.windows-unconfined.test.mjs).
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

const claudeTurn = async (trust) => {
  const calls = [];
  await claude.spawn('hello from a stranger', {
    environment: { model: 'test-model', sandbox: { trust } },
    sessionId: null,
    hostUnconfined: true,
    _spawnImpl: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return fakeChild('ok'); },
    _commandResolution: windows(),
    _platform: 'win32',
    _home: 'C:\\Users\\ada',
    env: {
      Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\ada',
      APPDATA: 'C:\\Users\\ada\\AppData\\Roaming',
    },
  });
  return calls[0];
};

describe.each(['public', 'workspace'])('claude, %s trust', (trust) => {
  test('a confined claude seat loads no user or project MCP config', async () => {
    const { args } = await claudeTurn(trust);
    // --strict-mcp-config: only servers named by --mcp-config load, so neither
    // ~/.claude.json nor <cwd>/.mcp.json adds one.
    expect({ why: WHY, strict: args.includes('--strict-mcp-config') }).toEqual({ why: WHY, strict: true });
    // --setting-sources '' loads no user, project or local settings file.
    const at = args.indexOf('--setting-sources');
    expect({ why: WHY, at: at >= 0, value: args[at + 1] }).toEqual({ why: WHY, at: true, value: '' });
  });
});

// ---- codex ----------------------------------------------------------------
test('a public codex seat ignores the operator config.toml and runs from its own home', async () => {
  const codex = {
    ...codexAdapter,
    spawn: (prompt, ctx) => codexAdapter.spawn(prompt, {
      _codexVersion: '0.162.1', _refuseCodeRunningGitSetup: () => {}, ...ctx,
    }),
  };
  await tempRoot(async (root) => {
    const operatorHome = join(root, 'operator-codex');
    const publicHome = join(root, 'public-codex');
    await mkdir(operatorHome, { recursive: true });
    await writeFile(join(operatorHome, 'auth.json'), '{"test":true}', 'utf8');
    await writeFile(join(operatorHome, 'config.toml'), '[mcp_servers.stranger]\ncommand = "x"\n', 'utf8');
    const calls = [];
    await codex.spawn('work safely', {
      sessionId: null,
      cwd: '/tmp/public-agent-workspace',
      environment: { model: 'test-model', sandbox: { mode: 'workspace', trust: 'public' } },
      env: { ...process.env, CODEX_HOME: operatorHome },
      agentName: 'scope-pins-codex',
      _publicCodexHome: publicHome,
      _spawnImpl: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        const out = args[args.indexOf('-o') + 1];
        const proc = fakeChild('{"type":"turn.completed"}\n');
        writeFile(out, 'ok', 'utf8').catch(() => {});
        return proc;
      },
    });
    const { args, opts } = calls[0];
    expect({ why: WHY, ignored: args.includes('--ignore-user-config') }).toEqual({ why: WHY, ignored: true });
    expect({ why: WHY, home: opts.env.CODEX_HOME }).toEqual({ why: WHY, home: publicHome });
    expect(opts.env.CODEX_HOME).not.toBe(operatorHome);
  });
});

// ---- opencode -------------------------------------------------------------
test('a public opencode seat reads only its generated config, never project or operator config', async () => {
  await tempRoot(async (root) => {
    const workspace = join(root, 'workspace');
    const xdgData = join(root, 'operator-data');
    await mkdir(workspace, { recursive: true });
    await mkdir(join(xdgData, 'opencode'), { recursive: true });
    await writeFile(join(xdgData, 'opencode', 'auth.json'), JSON.stringify({ provider: 'dummy-auth' }));
    const keyFile = join(root, 'provider-key');
    await writeFile(keyFile, 'upstream-secret', { mode: 0o600 });
    const calls = [];
    const events = [
      { type: 'step_start', sessionID: 'ses-1', part: { type: 'step-start' } },
      { type: 'text', sessionID: 'ses-1', part: { type: 'text', text: 'hi', time: { end: 1 } } },
      { type: 'step_finish', sessionID: 'ses-1', part: { type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 1 } } },
    ].map((e) => `${JSON.stringify(e)}\n`).join('');
    await opencode.spawn('hello', {
      sessionId: null,
      cwd: workspace,
      env: {
        ...process.env,
        XDG_DATA_HOME: xdgData,
        OPENCODE_CONFIG: '/operator/global/opencode.json',
      },
      environment: {
        model: 'example-model',
        provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
        sandbox: { trust: 'public', mode: 'workspace' },
        mcp: [],
      },
      runtimeToken: 'cm_agent_runtime_token',
      instanceUrl: 'https://api.example.test',
      agentName: 'scope-pins-opencode',
      metadata: { event: { podId: 'pod-1' } },
      _binaryPath: '/usr/local/bin/opencode',
      _platform: 'darwin',
      _wrapArgvWithSeatbelt: (argv) => argv,
      _spawnImpl: (cmd, args, options) => {
        calls.push({ cmd, args, options, config: options.env.OPENCODE_CONFIG });
        return fakeChild(events);
      },
    }).catch((error) => { if (!calls.length) throw error; });
    expect(calls).toHaveLength(1);
    const { options } = calls[0];
    expect({ why: WHY, project: options.env.OPENCODE_DISABLE_PROJECT_CONFIG }).toEqual({ why: WHY, project: '1' });
    expect(options.env.OPENCODE_CONFIG).not.toBe('/operator/global/opencode.json');
    expect(options.env.OPENCODE_CONFIG.startsWith(tmpdir()) || options.env.OPENCODE_CONFIG.includes('opencode')).toBe(true);
    expect(options.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(options.env.XDG_CONFIG_HOME).not.toBe(process.env.XDG_CONFIG_HOME);
  });
});

// ---- qwen -----------------------------------------------------------------
test('a public qwen seat runs bare, in safe mode, from a per-spawn home', async () => {
  await tempRoot(async (root) => {
    const cwd = join(root, 'workspace');
    const keyFile = join(root, 'provider-key');
    const packageDir = join(root, 'qwen-package');
    const binDir = join(root, 'npm', 'bin');
    const binary = join(binDir, 'qwen');
    await mkdir(cwd);
    await mkdir(packageDir);
    await mkdir(binDir, { recursive: true });
    await writeFile(join(packageDir, 'cli.js'), '#!/usr/bin/env node\n');
    await symlink(join(packageDir, 'cli.js'), binary);
    await writeFile(keyFile, 'upstream-secret', { mode: 0o600 });
    await chmod(keyFile, 0o600);
    await mkdir(join(cwd, '.qwen'));
    await writeFile(join(cwd, '.qwen', 'settings.json'), '{"mcpServers":{"stranger":{}}}');
    const calls = [];
    await qwen.spawn('hello', {
      cwd, agentName: 'scope-pins-qwen', runtimeToken: 'cm_agent_test_token',
      instanceUrl: 'https://api.commonly.me', _binaryPath: binary,
      _platform: 'darwin', _wrapArgvWithSeatbelt: (argv) => argv,
      env: { PATH: '/usr/bin', HOME: '/Users/operator' },
      environment: {
        model: 'example-model',
        provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
        sandbox: { trust: 'public', mode: 'workspace' },
        mcp: [],
      },
      _spawnImpl: (cmd, args, options) => {
        calls.push({ args, options, mcp: readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8') });
        return fakeChild('{"type":"result","result":"ok"}\n');
      },
    });
    const { args, options, mcp } = calls[0];
    expect({ why: WHY, bare: args.includes('--bare'), safe: args.includes('--safe-mode') })
      .toEqual({ why: WHY, bare: true, safe: true });
    expect(options.env.HOME).not.toBe('/Users/operator');
    expect(options.env.HOME).toContain('commonly-qwen-home-');
    expect(options.env.QWEN_HOME).toBe(options.env.HOME);
    // The MCP set is the file the adapter wrote, not the workspace's settings.
    expect(JSON.parse(mcp).mcpServers).toEqual({});
  });
});

// ---- goose ----------------------------------------------------------------
test('a public goose seat runs from a per-spawn home and takes MCP only from its recipe', async () => {
  await tempRoot(async (root) => {
    const home = join(root, 'mcp-home');
    const pkgDir = join(home, '0.3.13', 'node_modules', '@commonlyai', 'mcp');
    await mkdir(join(pkgDir, 'src'), { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': 'src/index.js' }, commonly: { readyFile: true },
    }));
    await writeFile(join(pkgDir, 'src', 'index.js'), '');
    await writeFile(join(home, 'current'), '0.3.13\n');
    // A held warm lock keeps prepareMcpSpawn from starting a real warm.
    await writeFile(join(home, '.warm.lock'), 'warming\n');
    const keyFile = join(root, 'provider-key');
    await writeFile(keyFile, 'upstream-secret', { mode: 0o600 });
    const prior = process.env.COMMONLY_MCP_HOME;
    process.env.COMMONLY_MCP_HOME = home;
    const seen = [];
    try {
      await goose.spawn('hello', {
        agentName: 'scope-pins-goose', cwd: process.cwd(), runtimeToken: 'cm_agent_test_runtime_token',
        instanceUrl: 'https://api.commonly.me', _version: TESTED_GOOSE_VERSIONS[0],
        env: { PATH: process.env.PATH, HOME: '/Users/operator', XDG_CONFIG_HOME: '/Users/operator/.config' },
        environment: {
          model: 'deepseek-v4-flash',
          mcp: [commonlyMcpServer()],
          provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
          sandbox: { trust: 'public', mode: 'workspace' },
        },
        _binaryPath: '/usr/bin/true',
        _platform: 'darwin',
        _wrapArgvWithSeatbelt: (argv) => argv,
        _spawnImpl: (cmd, args, options) => {
          const recipe = JSON.parse(readFileSync(args[args.indexOf('--recipe') + 1], 'utf8'));
          seen.push({ args, options, recipe });
          return fakeChild('{"type":"complete","total_tokens":1}\n');
        },
      });
    } finally {
      if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
      else process.env.COMMONLY_MCP_HOME = prior;
    }
    const { args, options, recipe } = seen[0];
    // A public goose turn is launched from a recipe whose extensions are the
    // only MCP set; the operator's config.yaml lives under HOME / the config
    // root, both overridden below.
    expect({ why: WHY, recipe: args.includes('--recipe') }).toEqual({ why: WHY, recipe: true });
    expect(options.env.HOME).not.toBe('/Users/operator');
    expect(options.env.XDG_CONFIG_HOME).not.toBe('/Users/operator/.config');
    expect(options.env.XDG_CONFIG_HOME.startsWith(options.env.HOME)).toBe(true);
    expect(options.env.GOOSE_PATH_ROOT).toBe(options.env.HOME);
    // The MCP servers are exactly the recipe's extensions: the shipped ones.
    expect(recipe.extensions.length).toBeGreaterThan(0);
    expect(recipe.extensions.map((extension) => extension.name)).toEqual(['commonly']);
    expect(args).not.toContain('--with-extension');
  });
});

// ---- pi -------------------------------------------------------------------
// pi's spawn path calls `buildArgs` (pi.js, in spawn()), so pinning the pure
// builder pins the argv a seat is launched with.
describe('pi', () => {
  const base = {
    prompt: 'hello', provider: 'local', model: 'm', sessionId: 'sid', isResume: false, sessionDir: '/tmp/s',
  };
  test.each([true, false])('a pi seat loads no extensions (publicSeat=%s)', (publicSeat) => {
    const args = piBuildArgs({ ...base, publicSeat });
    expect({ why: WHY, off: args.includes('--no-extensions') }).toEqual({ why: WHY, off: true });
  });
});
