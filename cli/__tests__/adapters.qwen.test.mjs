import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { readFileSync, realpathSync } from 'fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { buildSeatbeltProfile } from '../src/lib/sandbox/seatbelt.js';

const spawnSyncMock = jest.fn();
await jest.unstable_mockModule('child_process', () => ({
  spawnSync: spawnSyncMock,
  spawn: jest.fn(),
}));
const {
  default: qwen,
  TESTED_QWEN_VERSIONS,
  ALLOW_UNTESTED_QWEN_VERSION_ENV,
  buildQwenMcpConfig,
} = await import('../src/lib/adapters/qwen.js');

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation((_cmd, args = []) => (args[0] === '--version'
    ? { status: 0, stdout: `${TESTED_QWEN_VERSIONS[0]}\n` }
    : { status: 0, stdout: '/usr/local/bin/qwen\n' }));
});

const fakeChild = (output = '{"type":"result","result":"Qwen reply"}\n') => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn(() => proc.emit('close', null));
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from(output));
    proc.emit('close', 0);
  }, 0);
  return proc;
};

const withSeat = async (fn) => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-test-'));
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
  const ctx = {
    cwd, agentName: 'qwen-test', runtimeToken: 'cm_agent_test_token',
    instanceUrl: 'https://api.commonly.me', _binaryPath: binary,
    _platform: 'darwin', _wrapArgvWithSeatbelt: (argv) => argv,
    env: { PATH: '/usr/bin', HTTPS_PROXY: 'https://shadow.example', OPENAI_BASE_URL: 'https://shadow.example' },
    environment: {
      model: 'example-model',
      provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
      sandbox: { trust: 'public', mode: 'workspace' },
      mcp: [],
    },
  };
  try { await fn(ctx, root); } finally { await rm(root, { recursive: true, force: true }); }
};

test('public launch isolates HOME and config, strips shadows, and never serializes the provider key', async () => {
  await withSeat(async (ctx, root) => {
    await writeFile(join(ctx.cwd, '.env'), 'OPENAI_BASE_URL=https://shadow.example\n');
    await mkdir(join(ctx.cwd, '.qwen'));
    await writeFile(join(ctx.cwd, '.qwen', '.env'), 'HTTPS_PROXY=https://shadow.example\n');
    await writeFile(join(ctx.cwd, '.qwen', 'settings.json'), '{"mcpServers":{"shadow":{}}}');
    const calls = [];
    const profiles = [];
    const result = await qwen.spawn('hello', {
      ...ctx,
      _wrapArgvWithSeatbelt: (argv, options) => {
        profiles.push({
          options,
          configDir: realpathSync(options.mcpConfigDir),
          profile: buildSeatbeltProfile(options),
        });
        return argv;
      },
      _spawnImpl: (cmd, args, options) => {
        const mcpPath = args[args.indexOf('--mcp-config') + 1];
        calls.push({
          cmd, args, options,
          mcp: readFileSync(mcpPath, 'utf8'),
          settings: readFileSync(options.env.QWEN_CODE_SYSTEM_SETTINGS_PATH, 'utf8'),
        });
        return fakeChild();
      },
    });
    expect(result.text).toBe('Qwen reply');
    const [{ cmd, args, options, mcp, settings }] = calls;
    const executable = join(realpathSync(dirname(ctx._binaryPath)), basename(ctx._binaryPath));
    expect(cmd).toBe(executable);
    expect(args).toEqual(expect.arrayContaining(['--bare', '--safe-mode', '--auth-type', 'openai', '-o', 'stream-json']));
    expect(args).not.toContain('--allowed-tools');
    expect(args[args.indexOf('--exclude-tools') + 1].split(','))
      .toEqual(expect.arrayContaining([
        'agent', 'workflow', 'advisor', 'replace', 'task', 'search_file_content',
      ]));
    expect(options.env.HOME).toBe(options.env.QWEN_HOME);
    expect(options.env.HOME).toContain('commonly-qwen-home-');
    expect(profiles[0].options.statePath).toBe(options.env.HOME);
    expect(profiles[0].options.mcpConfigDir).not.toBe(profiles[0].options.statePath);
    expect(options.env.HOME.startsWith(`${profiles[0].options.mcpConfigDir}/`)).toBe(false);
    const readOnlyConfigDir = profiles[0].configDir;
    expect(profiles[0].profile).toContain(`(allow file-read* file-test-existence (subpath "${readOnlyConfigDir}"))`);
    expect(profiles[0].profile).toContain(`(allow file-read* file-test-existence (subpath "${realpathSync(join(root, 'qwen-package'))}"))`);
    expect(profiles[0].profile).toContain(`(allow file-read* file-test-existence (literal "${executable}"))`);
    expect(profiles[0].profile).not.toContain(`file-write* (subpath "${realpathSync(join(root, 'qwen-package'))}")`);
    expect(profiles[0].profile).not.toContain(`file-write* (subpath "${readOnlyConfigDir}")`);
    const versionProbe = spawnSyncMock.mock.calls.find(([, argv]) => argv[0] === '--version');
    expect(versionProbe[2].env.HOME).toContain('commonly-qwen-version-');
    expect(versionProbe[2].env.QWEN_HOME).toBe(versionProbe[2].env.HOME);
    expect(options.env.HTTPS_PROXY).toBe('');
    expect(options.env.OPENAI_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(options.env.OPENAI_API_KEY).not.toBe('upstream-secret');
    expect(settings).toContain('"usageStatisticsEnabled":false');
    expect(mcp).toBe('{"mcpServers":{}}');
    expect(JSON.stringify({ args, mcp, settings })).not.toContain('upstream-secret');
    expect(JSON.stringify({ args, mcp, settings })).not.toContain('cm_agent_test_token');
    expect(JSON.stringify({ args, mcp, settings })).not.toContain('shadow.example');
  });
});

test('public version drift refuses before launching a provider proxy or child', async () => {
  await withSeat(async (ctx) => {
    spawnSyncMock.mockImplementation(() => ({ status: 0, stdout: '0.26.0\n' }));
    const spawn = jest.fn();
    await expect(qwen.spawn('hello', { ...ctx, _spawnImpl: spawn }))
      .rejects.toThrow(/Public Qwen seats refuse version 0.26.0/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

test('a plain-file executable does not grant its whole bin directory', async () => {
  await withSeat(async (ctx) => {
    await rm(ctx._binaryPath);
    await writeFile(ctx._binaryPath, '#!/usr/bin/env node\n', { mode: 0o755 });
    let profileOptions;
    await qwen.spawn('hello', {
      ...ctx,
      _wrapArgvWithSeatbelt: (argv, options) => {
        profileOptions = options;
        return argv;
      },
      _spawnImpl: () => fakeChild(),
    });
    expect(profileOptions.readOnlyDirectories).toEqual([]);
    expect(buildSeatbeltProfile(profileOptions))
      .not.toContain(`(allow file-read* file-test-existence (subpath "${realpathSync(join(ctx._binaryPath, '..'))}"))`);
  });
});

test('only an exact host-process version override admits a public mismatch', async () => {
  await withSeat(async (ctx) => {
    spawnSyncMock.mockImplementation(() => ({ status: 0, stdout: '0.26.0\n' }));
    const previous = process.env[ALLOW_UNTESTED_QWEN_VERSION_ENV];
    try {
      delete process.env[ALLOW_UNTESTED_QWEN_VERSION_ENV];
      await expect(qwen.spawn('hello', {
        ...ctx, env: { ...ctx.env, [ALLOW_UNTESTED_QWEN_VERSION_ENV]: '1' },
        _spawnImpl: () => fakeChild(),
      })).rejects.toThrow(/refuse version/);
      process.env[ALLOW_UNTESTED_QWEN_VERSION_ENV] = 'yes';
      await expect(qwen.spawn('hello', { ...ctx, _spawnImpl: () => fakeChild() }))
        .rejects.toThrow(/refuse version/);
      process.env[ALLOW_UNTESTED_QWEN_VERSION_ENV] = '1';
      await expect(qwen.spawn('hello', { ...ctx, _spawnImpl: () => fakeChild() }))
        .resolves.toMatchObject({ text: 'Qwen reply' });
    } finally {
      if (previous === undefined) delete process.env[ALLOW_UNTESTED_QWEN_VERSION_ENV];
      else process.env[ALLOW_UNTESTED_QWEN_VERSION_ENV] = previous;
    }
  });
});

test('the bwrap launch binds the fresh HOME instead of the workspace', async () => {
  await withSeat(async (ctx) => {
    const wraps = [];
    await qwen.spawn('hello', {
      ...ctx,
      environment: { ...ctx.environment, sandbox: { trust: 'public', mode: 'bwrap' } },
      _detectBwrap: () => ({ available: true }),
      _wrapArgvWithBwrap: (argv, environment, options) => {
        wraps.push({ argv, environment, options });
        return argv;
      },
      _spawnImpl: () => fakeChild(),
    });
    expect(wraps).toHaveLength(1);
    expect(wraps[0].options.homePath).toContain('commonly-qwen-home-');
    expect(wraps[0].options.homePath).not.toBe(ctx.cwd);
    expect(wraps[0].environment.sandbox.filesystem['write-outside'])
      .toContain(wraps[0].options.homePath);
    const configDir = wraps[0].argv[wraps[0].argv.indexOf('--mcp-config') + 1].replace(/\/mcp\.json$/, '');
    expect(wraps[0].environment.sandbox.filesystem['write-outside']).not.toContain(configDir);
    expect(wraps[0].options.readOnlyPaths).toContain(configDir);
    expect(wraps[0].options.homePath.startsWith(`${configDir}/`)).toBe(false);
  });
});

test('MCP token takes the file path, while credential-bearing HTTP config refuses', () => {
  const ctx = { credentialFile: '/tmp/seat-token', instanceUrl: 'https://api.commonly.me', runtimeToken: 'cm_agent_test_token' };
  const stdio = buildQwenMcpConfig([{
    name: 'commonly', transport: 'stdio', command: ['npx', '@commonlyai/mcp'],
    env: { COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' },
  }], ctx);
  expect(JSON.stringify(stdio)).toContain('/tmp/seat-token');
  expect(JSON.stringify(stdio)).not.toContain('cm_agent_test_token');
  expect(() => buildQwenMcpConfig([{
    name: 'broker', transport: 'http', url: 'https://api.commonly.me/mcp',
    headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
  }], ctx)).toThrow(/requires a credential transport/);
});

test('an explicit MCP server reaches --mcp-config alongside --safe-mode', async () => {
  await withSeat(async (ctx) => {
    let observed;
    await qwen.spawn('hello', {
      ...ctx,
      environment: {
        ...ctx.environment,
        mcp: [{ name: 'probe', transport: 'stdio', command: ['/usr/bin/true'] }],
      },
      _spawnImpl: (_cmd, args) => {
        observed = {
          args,
          config: JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')),
        };
        return fakeChild();
      },
    });
    expect(observed.args).toContain('--safe-mode');
    expect(observed.config.mcpServers.probe).toMatchObject({ command: '/usr/bin/true' });
  });
});

test('private Qwen approves only declared Commonly MCP tools in the non-interactive run', async () => {
  await withSeat(async (ctx) => {
    let observed;
    await qwen.spawn('hello', {
      ...ctx,
      environment: {
        ...ctx.environment,
        sandbox: undefined,
        mcp: [
          { name: 'commonly', transport: 'stdio', command: ['/usr/bin/true'] },
          { name: 'other', transport: 'stdio', command: ['/usr/bin/true'] },
        ],
      },
      _spawnImpl: (_cmd, args) => {
        observed = {
          args,
          config: JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')),
        };
        return fakeChild();
      },
    });
    expect(Object.keys(observed.config.mcpServers)).toEqual(['commonly', 'other']);
    expect(observed.args[observed.args.indexOf('--allowed-tools') + 1]).toBe('mcp__commonly__*');
    expect(observed.args).toContain('--safe-mode');
    expect(observed.args).not.toContain('--approval-mode');
    expect(observed.args).not.toContain('--yolo');
  });
});

test('private Qwen does not approve Commonly tools when that server was not configured', async () => {
  await withSeat(async (ctx) => {
    let args;
    await qwen.spawn('hello', {
      ...ctx,
      environment: { ...ctx.environment, sandbox: undefined },
      _spawnImpl: (_cmd, argv) => { args = argv; return fakeChild(); },
    });
    expect(args).not.toContain('--allowed-tools');
  });
});

// TASK-273: a public seat whose MCP did not start used to run with a notice,
// and the model narrated the failure to a stranger (2026-10-15). It now
// refuses the turn before Qwen runs.
test('a public cold MCP refuses the turn before Qwen runs', async () => {
  await withSeat(async (ctx, root) => {
    const home = join(root, 'mcp-home');
    await mkdir(home);
    await writeFile(join(home, '.warm.lock'), 'warming\n');
    const prior = process.env.COMMONLY_MCP_HOME;
    process.env.COMMONLY_MCP_HOME = home;
    try {
      let spawned = false;
      await expect(qwen.spawn('hello', {
        ...ctx,
        environment: {
          ...ctx.environment,
          mcp: [{ name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] }],
        },
        _spawnImpl: () => { spawned = true; return fakeChild(); },
      })).rejects.toMatchObject({ code: 'public_mcp_unavailable' });
      expect(spawned).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
      else process.env.COMMONLY_MCP_HOME = prior;
    }
  });
});

test('a warm public Qwen spawn grants only the selected MCP version directory', async () => {
  await withSeat(async (ctx, root) => {
    const home = join(root, 'mcp-home');
    const versionDir = join(home, '0.3.13');
    const packageDir = join(versionDir, 'node_modules', '@commonlyai', 'mcp');
    await mkdir(join(packageDir, 'src'), { recursive: true });
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': 'src/index.js' },
    }));
    await writeFile(join(packageDir, 'src', 'index.js'), '#!/usr/bin/env node\n');
    await writeFile(join(home, 'current'), '0.3.13\n');
    await writeFile(join(home, '.warm.lock'), 'warming\n');
    const prior = process.env.COMMONLY_MCP_HOME;
    process.env.COMMONLY_MCP_HOME = home;
    try {
      let profileOptions;
      let config;
      let launchArgs;
      await qwen.spawn('hello', {
        ...ctx,
        environment: { ...ctx.environment, mcp: [{
          name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'],
        }] },
        _wrapArgvWithSeatbelt: (argv, options) => { profileOptions = options; return argv; },
        _spawnImpl: (_cmd, args) => {
          launchArgs = args;
          config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
          return fakeChild();
        },
      });
      expect(launchArgs).not.toContain('--allowed-tools');
      expect(config.mcpServers.commonly).toMatchObject({
        command: 'node', args: [join(packageDir, 'src', 'index.js')],
      });
      expect(profileOptions.readOnlyDirectories).toContain(versionDir);
      expect(profileOptions.readOnlyDirectories).not.toContain(home);
      expect(buildSeatbeltProfile(profileOptions)).toContain(`(subpath "${realpathSync(versionDir)}")`);
    } finally {
      if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
      else process.env.COMMONLY_MCP_HOME = prior;
    }
  });
});
