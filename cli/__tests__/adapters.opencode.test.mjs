import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { existsSync, readFileSync, readlinkSync, realpathSync } from 'fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const spawnSyncMock = jest.fn();
await jest.unstable_mockModule('child_process', () => ({
  spawnSync: spawnSyncMock,
  spawn: jest.fn(),
}));

const {
  default: opencode,
  DISABLED_ENV,
  buildArgs,
  buildMcpConfig,
  buildProviderConfig,
  makeEventParser,
  publicPermissions,
  qualifiedProviderModel,
  resolveProviderKeyFile,
} = await import('../src/lib/adapters/opencode.js');

const EXPECTED_DISABLED_ENV = [
  'OPENCODE_DISABLE_CLAUDE_CODE',
  'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT',
  'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS',
  'OPENCODE_DISABLE_EXTERNAL_SKILLS',
  'OPENCODE_DISABLE_DEFAULT_PLUGINS',
  'OPENCODE_DISABLE_AUTOUPDATE',
];

const event = (type, sessionID, part) => `${JSON.stringify({ type, sessionID, part })}\n`;
const sampleEvents = (sessionID = 'ses_test') => [
  event('step_start', sessionID, { type: 'step-start' }),
  event('text', sessionID, { type: 'text', text: 'Hello from OpenCode.' }),
  event('step_finish', sessionID, {
    type: 'step-finish',
    tokens: { input: 8, output: 3, reasoning: 1, cache: { write: 0, read: 0 } },
  }),
];

const fakeChild = ({ chunks = [], stderr = '', code = 0, onKill = null } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn((signal) => { if (onKill) onKill(proc, signal); });
  setTimeout(() => {
    for (const chunk of chunks) proc.stdout.emit('data', Buffer.from(chunk));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', code);
  }, 0);
  return proc;
};

const makeSpawnImpl = ({ chunks = sampleEvents(), stderr = '', code = 0, onCall = null } = {}) => {
  const calls = [];
  const impl = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    onCall?.(cmd, args, options);
    return fakeChild({ chunks, stderr, code });
  };
  return { impl, calls };
};

const withTemp = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-adapter-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe('opencode adapter — detect()', () => {
  beforeEach(() => spawnSyncMock.mockReset());

  test('finds opencode and reports its version', async () => {
    spawnSyncMock.mockImplementation((cmd) => (cmd === 'which'
      ? { status: 0, stdout: '/opt/homebrew/bin/opencode\n' }
      : { status: 0, stdout: '1.18.35\n' }));
    await expect(opencode.detect()).resolves.toEqual({
      path: '/opt/homebrew/bin/opencode',
      version: '1.18.35',
    });
    expect(spawnSyncMock).toHaveBeenCalledWith('opencode', ['--version'], expect.any(Object));
  });

  test('returns null when opencode is unavailable', async () => {
    spawnSyncMock.mockReturnValue({ status: null, error: new Error('ENOENT') });
    await expect(opencode.detect()).resolves.toBeNull();
  });
});

describe('opencode adapter — argv and event contract', () => {
  test('builds fresh and resumed CLI arguments without --auto', () => {
    const fresh = buildArgs({
      prompt: 'fresh prompt', cwd: '/work/agent', model: 'openai/gpt-5.4', effort: 'high', title: 'Kai seat',
    });
    expect(fresh).toEqual([
      '--pure', 'run', '--format', 'json', '-m', 'openai/gpt-5.4', '--variant', 'high',
      '--dir', '/work/agent', '--title', 'Kai seat', 'fresh prompt',
    ]);
    const resumed = buildArgs({ prompt: 'next', sessionId: 'ses-1', cwd: '/work/agent' });
    expect(resumed.slice(0, 6)).toEqual(['--pure', 'run', '--format', 'json', '-s', 'ses-1']);
    expect(resumed).not.toContain('--auto');
  });

  test('qualifies a custom provider model without changing built-in model ids', () => {
    expect(qualifiedProviderModel({ id: 'litellm' }, 'gpt-5.4')).toBe('litellm/gpt-5.4');
    expect(qualifiedProviderModel(null, 'anthropic/claude-sonnet-4-5'))
      .toBe('anthropic/claude-sonnet-4-5');
  });

  test('parses final text, session id, and step token counts from JSONL', () => {
    const parser = makeEventParser();
    parser.consume(Buffer.from(sampleEvents().join('').slice(0, 72)));
    parser.consume(Buffer.from(sampleEvents().join('').slice(72)));
    parser.flush();
    expect(parser.sessionId).toBe('ses_test');
    expect(parser.text).toBe('Hello from OpenCode.');
    expect(parser.usage).toEqual({ input: 8, output: 3, reasoning: 1, cache: { write: 0, read: 0 } });
  });

  test('headless approval errors remain visible as a typed adapter failure', () => {
    const parser = makeEventParser();
    parser.consume(Buffer.from(`${JSON.stringify({
      type: 'error', error: { data: { message: 'provider request failed' } },
    })}\n`));
    expect(parser.errorMessage).toBe('provider request failed');
  });

  test('pins every foreign prompt, skills, plugin, and update import off', () => {
    expect(DISABLED_ENV).toEqual(EXPECTED_DISABLED_ENV);
  });
});

describe('opencode MCP config', () => {
  test('writes local stdio and remote grant entries with file-backed Commonly credentials', () => {
    const token = 'cm_agent_secret_value';
    const config = buildMcpConfig([
      {
        name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'],
        env: { COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}', COMMONLY_API_URL: '${COMMONLY_API_URL}' },
      },
      {
        name: 'room-grants', transport: 'http',
        url: '${COMMONLY_API_URL}/api/mcp/grants/g-1',
        headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
      },
    ], {
      runtimeToken: token,
      instanceUrl: 'https://api.example.test',
      credentialFile: '/tmp/commonly-token-file',
    });
    expect(config.commonly).toEqual({
      type: 'local', enabled: true, command: ['npx', '-y', '@commonlyai/mcp@latest'],
      environment: {
        COMMONLY_TOKEN_FILE: '/tmp/commonly-token-file',
        COMMONLY_API_URL: 'https://api.example.test',
      },
    });
    expect(config['room-grants']).toEqual({
      type: 'remote', enabled: true,
      url: 'https://api.example.test/api/mcp/grants/g-1',
      headers: { Authorization: 'Bearer {file:/tmp/commonly-token-file}' },
    });
    expect(JSON.stringify(config)).not.toContain(token);
  });

  test('does not serialize runtime credentials into non-bearer headers or URLs', () => {
    const config = buildMcpConfig([
      { name: 'bad-url', transport: 'http', url: 'https://example.test/${COMMONLY_AGENT_TOKEN}' },
      {
        name: 'bad-header', transport: 'http', url: 'https://example.test/mcp',
        headers: { 'X-Token': '${COMMONLY_AGENT_TOKEN}' },
      },
    ], { runtimeToken: 'cm_agent_secret', credentialFile: '/tmp/token' });
    expect(config).toEqual({});
  });

  test('public permissions deny shell execution and external paths, while allowing declared MCP tools', () => {
    const permission = publicPermissions('workspace', ['commonly', 'room-grants']);
    expect(permission['*']).toBe('deny');
    expect(permission.bash).toBe('deny');
    expect(permission.external_directory).toBe('deny');
    expect(permission['commonly_*']).toBe('allow');
    expect(permission['room_grants_*']).toBe('allow');
    expect(permission.edit['*']).toBe('allow');
    expect(publicPermissions('bwrap', []).edit['*']).toBe('allow');
    expect(publicPermissions('read-only', [])).toMatchObject({ edit: { '*': 'deny' } });
  });
});

describe('opencode external provider config', () => {
  test('uses file-backed provider auth and materializes only the selected model when models are omitted', () => {
    const config = buildProviderConfig({
      id: 'litellm',
      baseURL: 'https://llm.example.test/v1',
    }, 'gpt-5.4', '/private/keys/litellm');
    expect(config).toEqual({
      litellm: {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: 'https://llm.example.test/v1',
          apiKey: '{file:/private/keys/litellm}',
        },
        models: { 'gpt-5.4': { name: 'gpt-5.4' } },
      },
    });
  });

  test('preserves caller model metadata and adds the selected model if missing', () => {
    const config = buildProviderConfig({
      id: 'openrouter',
      baseURL: 'https://openrouter.example.test/v1',
      models: { 'other-model': { name: 'Other', limit: { context: 1000, output: 500 } } },
    }, 'gpt-5.4', '/private/keys/openrouter');
    expect(config.openrouter.models).toEqual({
      'other-model': { name: 'Other', limit: { context: 1000, output: 500 } },
      'gpt-5.4': { name: 'gpt-5.4' },
    });
    expect(buildProviderConfig({
      id: 'litellm',
      baseURL: 'https://llm.example.test/v1',
      models: { 'gpt-5.4': { limit: { context: 1000, output: 500 } } },
    }, 'gpt-5.4', '/private/keys/litellm').litellm.models['gpt-5.4']).toEqual({
      limit: { context: 1000, output: 500 },
      name: 'gpt-5.4',
    });
  });

  test('key files must be absolute, 0600 regular files outside the workspace', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const keyFile = join(root, 'secrets', 'provider-key');
      await mkdir(workspace, { recursive: true });
      await mkdir(join(root, 'secrets'), { recursive: true });
      await writeFile(keyFile, 'provider-key-value');
      await chmod(keyFile, 0o600);
      const provider = { keyFile };
      await expect(resolveProviderKeyFile(provider, workspace)).resolves.toBe(realpathSync(keyFile));

      await chmod(keyFile, 0o640);
      await expect(resolveProviderKeyFile(provider, workspace)).rejects.toThrow(/mode 0600/);

      const inside = join(workspace, 'provider-key');
      await writeFile(inside, 'inside-workspace-key');
      await chmod(inside, 0o600);
      await expect(resolveProviderKeyFile({ keyFile: inside }, workspace)).rejects.toThrow(/outside the workspace/);

      const link = join(root, 'secrets', 'provider-key-link');
      await symlink(keyFile, link);
      await expect(resolveProviderKeyFile({ keyFile: link }, workspace)).rejects.toThrow(/regular, non-symlink/);
      await expect(resolveProviderKeyFile({ keyFile: 'relative/key' }, workspace)).rejects.toThrow(/absolute path/);
    });
  });

  test('spawns with provider-qualified model and keeps key bytes out of config and environment', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const keyFile = join(root, 'secrets', 'provider-key');
      const key = 'provider-secret-never-inline';
      await mkdir(workspace, { recursive: true });
      await mkdir(join(root, 'secrets'), { recursive: true });
      await writeFile(keyFile, key);
      await chmod(keyFile, 0o600);
      const spawn = makeSpawnImpl({
        onCall: (_cmd, args, options) => {
          expect(args).toContain('litellm/gpt-5.4');
          const configText = readFileSync(options.env.OPENCODE_CONFIG, 'utf8');
          const config = JSON.parse(configText);
          expect(config.provider.litellm).toEqual({
            npm: '@ai-sdk/openai-compatible',
            options: {
              baseURL: 'http://127.0.0.1:11434/v1',
              apiKey: `{file:${realpathSync(keyFile)}}`,
            },
            models: { 'gpt-5.4': { name: 'gpt-5.4' } },
          });
          expect(configText).not.toContain(key);
          expect(Object.values(options.env)).not.toContain(key);
        },
      });
      await opencode.spawn('provider turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH, XDG_DATA_HOME: join(root, 'operator-data') },
        environment: {
          model: 'gpt-5.4',
          provider: {
            id: 'litellm', baseURL: 'http://127.0.0.1:11434/v1', keyFile,
          },
        },
        _binaryPath: '/usr/local/bin/opencode',
        _spawnImpl: spawn.impl,
      });
    });
  });

  test('refuses provider keys with unsafe paths before spawning', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      await mkdir(workspace, { recursive: true });
      const spawn = makeSpawnImpl();
      await expect(opencode.spawn('bad key', {
        cwd: workspace,
        env: { PATH: process.env.PATH },
        environment: {
          model: 'gpt-5.4',
          provider: {
            id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile: join(workspace, 'key'),
          },
        },
        _spawnImpl: spawn.impl,
      })).rejects.toThrow(/unavailable/);
      expect(spawn.calls).toHaveLength(0);
    });
  });

  test('adds only the exact provider key file to public Seatbelt read paths', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const keyFile = join(root, 'secrets', 'provider-key');
      await mkdir(workspace, { recursive: true });
      await mkdir(join(root, 'secrets'), { recursive: true });
      await writeFile(keyFile, 'provider-key');
      await chmod(keyFile, 0o600);
      const realKey = realpathSync(keyFile);
      const spawn = makeSpawnImpl();
      await opencode.spawn('public provider turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH, XDG_DATA_HOME: join(root, 'operator-data') },
        environment: {
          model: 'gpt-5.4',
          provider: { id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile },
          sandbox: { trust: 'public', mode: 'workspace' },
        },
        agentName: 'public-provider-seat',
        _opencodeHomeRoot: join(root, 'seat-state'),
        _binaryPath: '/usr/local/bin/opencode',
        _platform: 'darwin',
        _spawnImpl: spawn.impl,
        _wrapArgvWithSeatbelt: (argv, opts) => {
          expect(opts.readOnlyPaths).toEqual([realKey]);
          return ['/usr/bin/sandbox-exec', '-p', '(deny default)', ...argv];
        },
      });
    });
  });

  test('adds only the exact provider key file to public bwrap read paths', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const keyFile = join(root, 'secrets', 'provider-key');
      await mkdir(workspace, { recursive: true });
      await mkdir(join(root, 'secrets'), { recursive: true });
      await writeFile(keyFile, 'provider-key');
      await chmod(keyFile, 0o600);
      const realKey = realpathSync(keyFile);
      const spawn = makeSpawnImpl();
      await opencode.spawn('public provider turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH, XDG_DATA_HOME: join(root, 'operator-data') },
        environment: {
          model: 'gpt-5.4',
          provider: { id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile },
          sandbox: { trust: 'public', mode: 'bwrap' },
        },
        agentName: 'public-provider-seat',
        _opencodeHomeRoot: join(root, 'seat-state'),
        _binaryPath: '/usr/local/bin/opencode',
        _platform: 'linux',
        _detectBwrap: () => ({ available: true, path: '/usr/bin/bwrap' }),
        _spawnImpl: spawn.impl,
        _wrapArgvWithBwrap: (argv, _environment, opts) => {
          expect(opts.readOnlyPaths).toEqual([
            expect.stringMatching(/commonly-opencode-/),
            '/usr/local/bin/opencode',
            process.execPath,
            realKey,
          ]);
          return ['/usr/bin/bwrap', '--test', ...argv];
        },
      });
    });
  });
});

describe('opencode adapter — spawn()', () => {
  test('a seat with no public sandbox declaration runs as trusted', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      await mkdir(workspace, { recursive: true });
      const spawn = makeSpawnImpl({
        onCall: (cmd, _args, options) => {
          expect(cmd).toBe('/usr/local/bin/opencode');
          const config = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
          expect(config.permission).toBe('allow');
        },
      });
      const wrap = jest.fn(() => { throw new Error('trusted seat must not enter public wrapper'); });
      await opencode.spawn('trusted turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH },
        environment: { mcp: [] },
        agentName: 'trusted-agent',
        _binaryPath: '/usr/local/bin/opencode',
        _platform: 'darwin',
        _spawnImpl: spawn.impl,
        _wrapArgvWithSeatbelt: wrap,
      });
      expect(wrap).not.toHaveBeenCalled();
    });
  });

  test('writes isolated per-spawn MCP config, strips ambient config, and resumes the same session', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const xdgData = join(root, 'operator-data');
      const appData = join(xdgData, 'opencode');
      await mkdir(workspace, { recursive: true });
      await mkdir(appData, { recursive: true });
      await writeFile(join(appData, 'auth.json'), JSON.stringify({ provider: 'dummy-auth' }));
      const seatRoot = join(root, 'seat-state');
      const env = {
        ...process.env,
        COMMONLY_AGENT_TOKEN: 'launcher-token-must-be-removed',
        OPENCODE_CONFIG_CONTENT: '{"mcp":{"stranger":{"type":"remote"}}}',
        OPENCODE_CONFIG: '/operator/global/opencode.json',
        OPENCODE_CONFIG_DIR: '/operator/global/config',
        XDG_CONFIG_HOME: '/operator/global/config',
        XDG_DATA_HOME: xdgData,
      };
      const mcp = [{
        name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'],
        env: { COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}', COMMONLY_API_URL: '${COMMONLY_API_URL}' },
      }, {
        name: 'room-grants', transport: 'http',
        url: '${COMMONLY_API_URL}/api/mcp/grants/g-1',
        headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
      }];

      const first = makeSpawnImpl({
        chunks: sampleEvents('ses-created'),
        onCall: (cmd, args, options) => {
          expect(cmd).toBe('/usr/local/bin/opencode');
          expect(args).toEqual(expect.arrayContaining([
            '--pure', 'run', '--format', 'json', '-m', 'anthropic/claude-sonnet-4-5',
            '--variant', 'high', '--dir', workspace, '--title', 'kai-seat',
          ]));
          expect(args).not.toContain('--auto');
          const configPath = options.env.OPENCODE_CONFIG;
          const config = JSON.parse(readFileSync(configPath, 'utf8'));
          expect(config.mcp['room-grants'].headers.Authorization)
            .toBe(`Bearer {file:${options.env.COMMONLY_TOKEN_FILE}}`);
          expect(readFileSync(options.env.COMMONLY_TOKEN_FILE, 'utf8').trim())
            .toBe('cm_agent_runtime_token');
          expect(config.mcp.commonly.environment.COMMONLY_AGENT_TOKEN).toBeUndefined();
          expect(config.mcp.commonly.environment.COMMONLY_TOKEN_FILE)
            .toBe(options.env.COMMONLY_TOKEN_FILE);
          expect(JSON.stringify(config)).not.toContain('cm_agent_runtime_token');
          expect(options.env.COMMONLY_AGENT_TOKEN).toBeUndefined();
          expect(options.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
          expect(options.env.OPENCODE_CONFIG_DIR).not.toBe('/operator/global/config');
          expect(options.env.XDG_CONFIG_HOME).not.toBe('/operator/global/config');
          expect(options.env.XDG_DATA_HOME).toBe(xdgData);
          expect(options.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
          for (const key of EXPECTED_DISABLED_ENV) expect(options.env[key]).toBe('1');
          expect(existsSync(join(seatRoot, 'data', 'opencode', 'auth.json'))).toBe(false);
        },
      });
      const baseContext = {
        sessionId: null,
        cwd: workspace,
        env,
        environment: { model: 'anthropic/claude-sonnet-4-5', effort: 'high', mcp },
        runtimeToken: 'cm_agent_runtime_token',
        instanceUrl: 'https://api.example.test',
        agentName: 'kai-seat',
        metadata: { event: { podId: 'pod-1' } },
        _binaryPath: '/usr/local/bin/opencode',
        _spawnImpl: first.impl,
      };
      await expect(opencode.spawn('first turn', baseContext)).resolves.toMatchObject({
        text: 'Hello from OpenCode.', newSessionId: 'ses-created',
        usage: { input: 8, output: 3 },
      });

      const resumed = makeSpawnImpl({
        chunks: sampleEvents('ses-created'),
        onCall: (_cmd, args, options) => {
          expect(args.slice(0, 6)).toEqual(['--pure', 'run', '--format', 'json', '-s', 'ses-created']);
          expect(options.env.XDG_DATA_HOME).toBe(xdgData);
        },
      });
      await expect(opencode.spawn('second turn', {
        ...baseContext, sessionId: 'ses-created', _spawnImpl: resumed.impl,
      })).resolves.toMatchObject({ newSessionId: 'ses-created' });
    });
  });

  test('a public spawn wraps the CLI in the host sandbox and denies prompt-only tools', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const xdgData = join(root, 'operator-data');
      const appData = join(xdgData, 'opencode');
      const authPath = join(appData, 'auth.json');
      const seatRoot = join(root, 'opencode-state');
      await mkdir(workspace, { recursive: true });
      await mkdir(appData, { recursive: true });
      await writeFile(authPath, '{"provider":"dummy-auth"}');
      const resolvedAuthPath = realpathSync(authPath);
      const spawn = makeSpawnImpl({
        onCall: (cmd, args, options) => {
          expect(cmd).toBe('/usr/bin/sandbox-exec');
          expect(args[0]).toBe('-p');
          const policy = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
          expect(policy.permission.bash).toBe('deny');
          expect(policy.permission['*']).toBe('deny');
          expect(policy.permission.edit['*']).toBe('allow');
          expect(options.env.XDG_DATA_HOME).toBe(join(seatRoot, 'data'));
          expect(options.env.XDG_STATE_HOME).toBe(join(seatRoot, 'state'));
          expect(options.env.XDG_CACHE_HOME).toBe(join(seatRoot, 'cache'));
          expect(options.env.HOME).toBe(seatRoot);
          expect(options.env.TMPDIR).toBe(join(seatRoot, 'tmp'));
          expect(options.env.PATH).toBe(process.env.PATH);
          expect(options.env.OPENAI_API_KEY).toBeUndefined();
          expect(options.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
          expect(readlinkSync(join(seatRoot, 'data', 'opencode', 'auth.json'))).toBe(resolvedAuthPath);
        },
      });
      await opencode.spawn('public turn', {
        cwd: workspace,
        env: {
          PATH: process.env.PATH,
          XDG_DATA_HOME: xdgData,
          OPENAI_API_KEY: 'operator-provider-key',
          AWS_SECRET_ACCESS_KEY: 'operator-cloud-key',
        },
        environment: { sandbox: { trust: 'public', mode: 'workspace' }, mcp: [] },
        agentName: 'public-agent',
        _opencodeHomeRoot: seatRoot,
        _binaryPath: '/usr/local/bin/opencode',
        _platform: 'darwin',
        _spawnImpl: spawn.impl,
        _wrapArgvWithSeatbelt: (argv, opts) => {
          expect(opts.readOnlyPaths).toEqual([resolvedAuthPath]);
          return ['/usr/bin/sandbox-exec', '-p', '(deny default)', ...argv];
        },
      });
    });
  });

  test('a public macOS read-only spawn uses Seatbelt read access', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const seatRoot = join(root, 'opencode-state');
      await mkdir(workspace, { recursive: true });
      const spawn = makeSpawnImpl({
        onCall: (cmd, args, options) => {
          expect(cmd).toBe('/usr/bin/sandbox-exec');
          expect(args[0]).toBe('-p');
          const policy = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
          expect(policy.permission.edit['*']).toBe('deny');
        },
      });
      await opencode.spawn('read-only turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH, XDG_DATA_HOME: join(root, 'operator-data') },
        environment: { sandbox: { trust: 'public', mode: 'read-only' }, mcp: [] },
        agentName: 'read-only-agent',
        _opencodeHomeRoot: seatRoot,
        _binaryPath: '/usr/local/bin/opencode',
        _platform: 'darwin',
        _spawnImpl: spawn.impl,
        _wrapArgvWithSeatbelt: (argv, opts) => {
          expect(opts.workspaceAccess).toBe('read');
          expect(opts.executablePath).toBe('/usr/local/bin/opencode');
          return ['/usr/bin/sandbox-exec', '-p', '(deny default)', ...argv];
        },
      });
    });
  });

  test('a public Linux spawn derives bwrap, keeps seat state writable, and binds provider auth read-only', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const xdgData = join(root, 'operator-data');
      const appData = join(xdgData, 'opencode');
      const authPath = join(appData, 'auth.json');
      const seatRoot = join(root, 'opencode-state');
      await mkdir(workspace, { recursive: true });
      await mkdir(appData, { recursive: true });
      await writeFile(authPath, '{"provider":"dummy-auth"}');
      const resolvedAuthPath = realpathSync(authPath);
      const spawn = makeSpawnImpl({
        onCall: (cmd, args, options) => {
          expect(cmd).toBe('/usr/bin/bwrap');
          expect(args[0]).toBe('--test');
          const policy = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
          expect(policy.permission.edit['*']).toBe('allow');
        },
      });
      await opencode.spawn('public Linux turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH, XDG_DATA_HOME: xdgData },
        environment: { sandbox: { trust: 'public', mode: 'bwrap' }, mcp: [] },
        agentName: 'public-linux-agent',
        _opencodeHomeRoot: seatRoot,
        _binaryPath: '/usr/local/bin/opencode',
        _platform: 'linux',
        _detectBwrap: () => ({ available: true, path: '/usr/bin/bwrap' }),
        _wrapArgvWithBwrap: (argv, environment, opts) => {
          expect(opts.workspacePath).toBe(workspace);
          expect(opts.readOnlyPaths).toContain(resolvedAuthPath);
          expect(environment.sandbox.filesystem['write-outside']).toContain(seatRoot);
          return ['/usr/bin/bwrap', '--test', ...argv];
        },
        _spawnImpl: spawn.impl,
      });
    });
  });
});
