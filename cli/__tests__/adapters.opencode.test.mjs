import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { createServer, request as httpRequest } from 'http';
import { existsSync, readFileSync, realpathSync } from 'fs';
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
import { buildSeatbeltProfile } from '../src/lib/sandbox/seatbelt.js';
import { validateEnvironmentSpec } from '../src/lib/environment.js';

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
  startProviderProxy,
  ALLOW_UNTESTED_OPENCODE_VERSION_ENV,
  TESTED_OPENCODE_VERSION,
} = await import('../src/lib/adapters/opencode.js');

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation((_cmd, args = []) => (args[0] === '--version'
    ? { status: 0, stdout: `OpenCode ${TESTED_OPENCODE_VERSION}\n` }
    : { status: 0, stdout: '/usr/local/bin/opencode\n' }));
});

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

const withProcessEnv = async (name, value, fn) => {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
};

const requestProxy = (port, requestPath, headers) => new Promise((resolve, reject) => {
  const request = httpRequest({
    hostname: '127.0.0.1', port, path: requestPath, method: 'POST', headers,
  }, (response) => {
    response.resume();
    response.on('end', () => resolve(response.statusCode));
  });
  request.on('error', reject);
  request.end('{}');
});

describe('opencode adapter — detect()', () => {
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
  test('proxies provider requests with a per-spawn bearer and never forwards that bearer upstream', async () => {
    await withTemp(async (root) => {
      const keyFile = join(root, 'provider-key');
      const proxyTokenFile = join(root, 'proxy-token');
      await writeFile(keyFile, 'upstream-secret');
      await chmod(keyFile, 0o600);
      let observed = null;
      const upstream = createServer((req, res) => {
        observed = {
          authorization: req.headers.authorization,
          host: req.headers.host,
          url: req.url,
        };
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const upstreamPort = upstream.address().port;
      const proxy = await startProviderProxy({
        provider: { baseURL: `http://127.0.0.1:${upstreamPort}/v1` },
        keyFile,
        tokenFile: proxyTokenFile,
      });
      try {
        const proxyToken = readFileSync(proxyTokenFile, 'utf8');
        const maliciousHost = await requestProxy(proxy.port, '/v1/chat/completions', {
          authorization: `Bearer ${proxyToken}`,
          host: 'attacker.example:4444',
        });
        expect(maliciousHost).toBe(200);
        expect(observed).toEqual({
          authorization: 'Bearer upstream-secret',
          host: `127.0.0.1:${upstreamPort}`,
          url: '/v1/chat/completions',
        });

        const response = await fetch(`${proxy.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json' },
          body: '{"model":"fake"}',
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('{"ok":true}');
        expect(observed).toEqual({
          authorization: 'Bearer upstream-secret',
          host: `127.0.0.1:${upstreamPort}`,
          url: '/v1/chat/completions',
        });

        const missing = await fetch(`${proxy.baseURL}/chat/completions`, {
          method: 'POST',
          body: '{}',
        });
        expect(missing.status).toBe(401);
        expect(observed).toEqual({
          authorization: 'Bearer upstream-secret',
          host: `127.0.0.1:${upstreamPort}`,
          url: '/v1/chat/completions',
        });

        const denied = await fetch(`${proxy.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { authorization: 'Bearer wrong-token' },
          body: '{}',
        });
        expect(denied.status).toBe(401);
        expect(observed).toEqual({
          authorization: 'Bearer upstream-secret',
          host: `127.0.0.1:${upstreamPort}`,
          url: '/v1/chat/completions',
        });

        const models = await fetch(`${proxy.baseURL}/models`, {
          headers: { authorization: `Bearer ${proxyToken}` },
        });
        expect(models.status).toBe(200);
        expect(observed).toEqual({
          authorization: 'Bearer upstream-secret',
          host: `127.0.0.1:${upstreamPort}`,
          url: '/v1/models',
        });

        const unsupported = await fetch(`${proxy.baseURL}/admin`, {
          method: 'POST',
          headers: { authorization: `Bearer ${proxyToken}` },
          body: '{}',
        });
        expect(unsupported.status).toBe(403);
        await expect(unsupported.text()).resolves.toBe('Unsupported provider request: POST /v1/admin');
        expect(observed).toEqual({
          authorization: 'Bearer upstream-secret',
          host: `127.0.0.1:${upstreamPort}`,
          url: '/v1/models',
        });

        const query = await fetch(`${proxy.baseURL}/chat/completions?url=http://127.0.0.1/admin`, {
          method: 'POST',
          headers: { authorization: `Bearer ${proxyToken}` },
          body: '{}',
        });
        expect(query.status).toBe(403);
        expect(observed).toEqual({
          authorization: 'Bearer upstream-secret',
          host: `127.0.0.1:${upstreamPort}`,
          url: '/v1/models',
        });

        const outsideBasePath = await fetch(`${proxy.baseURL.replace(/\/v1$/, '')}/admin`, {
          headers: { authorization: `Bearer ${proxyToken}` },
        });
        expect(outsideBasePath.status).toBe(403);
        expect(observed).toEqual({
          authorization: 'Bearer upstream-secret',
          host: `127.0.0.1:${upstreamPort}`,
          url: '/v1/models',
        });

        for (const encodedPath of ['/v1/..%2fadmin', '/v1/%5cadmin', '/v1/%2e%2e/admin']) {
          const encodedPathStatus = await requestProxy(proxy.port, encodedPath, {
            authorization: `Bearer ${proxyToken}`,
          });
          expect(encodedPathStatus).toBe(400);
          expect(observed).toEqual({
            authorization: 'Bearer upstream-secret',
            host: `127.0.0.1:${upstreamPort}`,
            url: '/v1/models',
          });
        }

        const authorityPath = await requestProxy(
          proxy.port,
          `//127.0.0.1:${upstreamPort}/v1/chat/completions`,
          { authorization: `Bearer ${proxyToken}` },
        );
        expect(authorityPath).toBe(400);
        expect(observed).toEqual({
          authorization: 'Bearer upstream-secret',
          host: `127.0.0.1:${upstreamPort}`,
          url: '/v1/models',
        });
      } finally {
        await proxy.close();
        await new Promise((resolve) => upstream.close(resolve));
      }
    });
  });

  test('logs each refused provider route to wrapper stderr using only its normalized path', async () => {
    await withTemp(async (root) => {
      const keyFile = join(root, 'provider-key');
      const proxyTokenFile = join(root, 'proxy-token');
      await writeFile(keyFile, 'upstream-secret');
      await chmod(keyFile, 0o600);
      let upstreamCalls = 0;
      const upstream = createServer((req, res) => {
        upstreamCalls += 1;
        req.resume();
        res.writeHead(200).end('{}');
      });
      await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const upstreamPort = upstream.address().port;
      const proxy = await startProviderProxy({
        provider: { baseURL: `http://127.0.0.1:${upstreamPort}/v1` },
        keyFile,
        tokenFile: proxyTokenFile,
      });
      const proxyToken = readFileSync(proxyTokenFile, 'utf8');
      const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const unsupported = await fetch(`${proxy.baseURL}/embeddings?secret=do-not-log`, {
          method: 'POST',
          headers: { authorization: `Bearer ${proxyToken}` },
          body: 'request body must not be logged',
        });
        expect(unsupported.status).toBe(403);
        await unsupported.text();

        const malformed = await requestProxy(proxy.port, '/v1/%2fadmin?secret=do-not-log', {
          authorization: `Bearer ${proxyToken}`,
        });
        expect(malformed).toBe(400);

        expect(stderrWrite.mock.calls.map(([line]) => String(line))).toEqual([
          '[opencode] provider proxy refused POST /v1/embeddings\n',
          '[opencode] provider proxy refused POST /v1/%2fadmin\n',
        ]);
        expect(stderrWrite.mock.calls).toHaveLength(2);
        expect(upstreamCalls).toBe(0);
      } finally {
        stderrWrite.mockRestore();
        await proxy.close();
        await new Promise((resolve) => upstream.close(resolve));
      }
    });
  });

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
          expect(config.enabled_providers).toEqual(['litellm']);
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

  test('public Seatbelt provider config uses only the proxy credential, not the upstream key or auth.json', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const operatorAppData = join(root, 'operator-data', 'opencode');
      const authPath = join(operatorAppData, 'auth.json');
      const keyFile = join(root, 'secrets', 'provider-key');
      await mkdir(workspace, { recursive: true });
      await mkdir(operatorAppData, { recursive: true });
      await mkdir(join(root, 'secrets'), { recursive: true });
      await writeFile(keyFile, 'provider-key');
      await chmod(keyFile, 0o600);
      await writeFile(authPath, '{"provider":"operator-auth"}');
      const realKey = realpathSync(keyFile);
      const realAuthPath = realpathSync(authPath);
      const seatRoot = join(root, 'seat-state');
      const spawn = makeSpawnImpl({
        onCall: (_cmd, _args, options) => {
          expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
          const config = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
          expect(existsSync(options.env.OPENCODE_CONFIG_DIR)).toBe(true);
          expect(existsSync(join(options.env.XDG_CONFIG_HOME, 'opencode'))).toBe(true);
          const expectedIgnore = [
            'node_modules', 'package.json', 'package-lock.json', 'bun.lock', '.gitignore',
          ].join('\n');
          expect(readFileSync(join(options.env.OPENCODE_CONFIG_DIR, '.gitignore'), 'utf8'))
            .toBe(expectedIgnore);
          expect(readFileSync(join(options.env.XDG_CONFIG_HOME, 'opencode', '.gitignore'), 'utf8'))
            .toBe(expectedIgnore);
          const homeConfigDir = join(options.env.HOME, '.opencode');
          expect(options.env.HOME).toContain('commonly-opencode-');
          expect(options.env.HOME).not.toBe(seatRoot);
          expect(existsSync(homeConfigDir)).toBe(false);
          const permission = config.permission;
          const providerConfig = config.provider.litellm;
          const tokenFile = providerConfig.options.apiKey.match(/^\{file:(.+)\}$/)[1];
          expect(permission.external_directory).toBe('deny');
          expect(permission.read['*']).toBe('allow');
          expect(permission.grep).toBe('allow');
          expect(permission.glob).toBe('allow');
          expect(permission.list).toBe('allow');
          expect(providerConfig.options.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
          expect(providerConfig.options.apiKey).not.toContain(realKey);
          expect(JSON.stringify(config)).not.toContain('provider-key');
          expect(readFileSync(tokenFile, 'utf8')).not.toBe('provider-key');
          expect(Object.values(options.env).join('\n')).not.toContain('provider-key');
          expect(existsSync(join(seatRoot, 'data', 'opencode', 'auth.json'))).toBe(false);
        },
      });
      await opencode.spawn('public provider turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH, XDG_DATA_HOME: join(root, 'operator-data') },
        environment: {
          model: 'gpt-5.4',
          provider: { id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile },
          sandbox: { trust: 'public', mode: 'workspace' },
        },
        agentName: 'public-provider-seat',
        _opencodeHomeRoot: seatRoot,
        _binaryPath: '/usr/local/bin/opencode',
        _platform: 'darwin',
        _spawnImpl: spawn.impl,
        _wrapArgvWithSeatbelt: (argv, opts) => {
          expect(opts.loopbackNetworkPorts).toHaveLength(1);
          const profile = buildSeatbeltProfile(opts);
          expect(profile).not.toContain(realKey);
          expect(opts.readOnlyPaths).not.toContain(realKey);
          expect(profile).toContain(`(allow network-outbound (remote tcp "localhost:${opts.loopbackNetworkPorts[0]}"))`);
          expect(profile).not.toContain(realAuthPath);
          expect(opts.mcpConfigDir).not.toContain(realKey);
          expect(opts.readOnlyPaths).not.toContain(realAuthPath);
          return ['/usr/bin/sandbox-exec', '-p', '(deny default)', ...argv];
        },
      });
    });
  });

  test('public bwrap provider config does not expose the upstream key or operator auth.json', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const keyFile = join(root, 'secrets', 'provider-key');
      const authPath = join(root, 'operator-data', 'opencode', 'auth.json');
      await mkdir(workspace, { recursive: true });
      await mkdir(join(root, 'secrets'), { recursive: true });
      await mkdir(join(root, 'operator-data', 'opencode'), { recursive: true });
      await writeFile(keyFile, 'provider-key');
      await chmod(keyFile, 0o600);
      await writeFile(authPath, '{"provider":"operator-auth"}');
      const realKey = realpathSync(keyFile);
      const realAuthPath = realpathSync(authPath);
      const seatRoot = join(root, 'opencode-state');
      const spawn = makeSpawnImpl({
        onCall: (_cmd, _args, options) => {
          const config = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
          const permission = config.permission;
          const tokenFile = config.provider.litellm.options.apiKey.match(/^\{file:(.+)\}$/)[1];
          for (const path of [realKey, realKey.replace(/^\/+/, '')]) {
            expect(permission.read[path]).toBeUndefined();
            expect(permission.edit[path]).toBeUndefined();
          }
          expect(permission.external_directory).toBe('deny');
          expect(permission.read[tokenFile]).toBeUndefined();
          expect(permission.grep).toBe('allow');
          expect(permission.glob).toBe('allow');
          expect(permission.list).toBe('allow');
          expect(permission.lsp).toBe('allow');
          expect(config.provider.litellm.options.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
          expect(JSON.stringify(config)).not.toContain('provider-key');
          expect(readFileSync(tokenFile, 'utf8')).not.toBe('provider-key');
          expect(Object.values(options.env).join('\n')).not.toContain('provider-key');
          expect(existsSync(join(seatRoot, 'data', 'opencode', 'auth.json'))).toBe(false);
        },
      });
      await opencode.spawn('public provider turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH, XDG_DATA_HOME: join(root, 'operator-data') },
        environment: {
          model: 'gpt-5.4',
          provider: { id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile },
          sandbox: { trust: 'public', mode: 'bwrap' },
        },
        agentName: 'public-provider-seat',
        _opencodeHomeRoot: seatRoot,
        _binaryPath: '/usr/local/bin/opencode',
        _platform: 'linux',
        _detectBwrap: () => ({ available: true, path: '/usr/bin/bwrap' }),
        _spawnImpl: spawn.impl,
        _wrapArgvWithBwrap: (argv, _environment, opts) => {
          expect(opts.readOnlyPaths).toEqual([
            expect.stringMatching(/commonly-opencode-/),
            '/usr/local/bin/opencode',
            process.execPath,
          ]);
          expect(opts.readOnlyPaths).not.toContain(realKey);
          expect(opts.readOnlyPaths).not.toContain(realAuthPath);
          return ['/usr/bin/bwrap', '--test', ...argv];
        },
      });
    });
  });

  test('refuses a public bwrap provider when restricted networking cannot reach the loopback proxy', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      await mkdir(workspace, { recursive: true });
      const spawn = makeSpawnImpl();
      await expect(opencode.spawn('public provider turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH },
        environment: {
          model: 'gpt-5.4',
          provider: { id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile: '/unused/provider-key' },
          sandbox: {
            trust: 'public', mode: 'bwrap', network: { policy: 'restricted' },
          },
        },
        agentName: 'public-provider-seat',
        _binaryPath: '/usr/local/bin/opencode',
        _platform: 'linux',
        _detectBwrap: () => ({ available: true, path: '/usr/bin/bwrap' }),
        _spawnImpl: spawn.impl,
      })).rejects.toThrow(/restricted cannot reach the loopback proxy/);
      expect(spawn.calls).toHaveLength(0);
    });
  });

  test('refuses public seats without an explicit provider instead of using OpenCode implicit public models', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      await mkdir(workspace, { recursive: true });
      const spawn = makeSpawnImpl();
      await expect(opencode.spawn('public unconfigured turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH, XDG_DATA_HOME: join(root, 'empty-operator-data') },
        environment: { sandbox: { trust: 'public', mode: 'workspace' }, mcp: [] },
        agentName: 'public-unconfigured-seat',
        _binaryPath: '/usr/local/bin/opencode',
        _platform: 'darwin',
        _spawnImpl: spawn.impl,
      })).rejects.toThrow(/environment\.provider.*implicit public tier.*auth\.json/);
      expect(spawn.calls).toHaveLength(0);
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
      const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
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
        expect(spawn.calls).toHaveLength(1);
        expect(wrap).not.toHaveBeenCalled();
        expect(spawnSyncMock).toHaveBeenCalledWith(
          '/usr/local/bin/opencode', ['--version'], expect.objectContaining({
            encoding: 'utf8', timeout: 5000, env: expect.any(Object),
          }),
        );
        const versionProbe = spawnSyncMock.mock.calls.find(([, args]) => args[0] === '--version');
        expect(versionProbe[2].env).toMatchObject(
          Object.fromEntries(DISABLED_ENV.map((key) => [key, '1'])),
        );
        expect(warning).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
      }
    });
  });

  test('a trusted seat warns on a newer version and still spawns', async () => {
    await withProcessEnv(ALLOW_UNTESTED_OPENCODE_VERSION_ENV, '1', async () => {
      await withTemp(async (root) => {
        const workspace = join(root, 'workspace');
        await mkdir(workspace, { recursive: true });
        spawnSyncMock.mockImplementation((_cmd, args = []) => (args[0] === '--version'
          ? { status: 0, stdout: 'OpenCode 1.19.0\n' }
          : { status: 0, stdout: '/usr/local/bin/opencode\n' }));
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const spawn = makeSpawnImpl({ onCall: (_cmd, _args, options) => {
          expect(options.env[ALLOW_UNTESTED_OPENCODE_VERSION_ENV]).toBeUndefined();
        } });
        try {
          await opencode.spawn('trusted turn', {
            cwd: workspace,
            env: { PATH: process.env.PATH, [ALLOW_UNTESTED_OPENCODE_VERSION_ENV]: '1' },
            environment: { mcp: [] },
            _binaryPath: '/usr/local/bin/opencode',
            _spawnImpl: spawn.impl,
          });
          expect(spawn.calls).toHaveLength(1);
          expect(warning).toHaveBeenCalledWith(
            '[opencode] installed OpenCode 1.19.0 is newer than smoke-tested 1.18.35; trusted seat continues',
          );
        } finally {
          warning.mockRestore();
        }
      });
    });
  });

  test.each([
    {
      description: 'older',
      result: { status: 0, stdout: 'OpenCode 1.18.0\n' },
      message: /installed OpenCode 1\.18\.0 is older than smoke-tested 1\.18\.35.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
    },
    {
      description: 'unavailable',
      result: { status: 1, stdout: '', stderr: 'version command failed' },
      message: /installed OpenCode version is unknown.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
    },
    {
      description: 'update announcement containing multiple versions',
      result: {
        status: 0,
        stdout: 'A new release is available: 1.18.35 -> 1.19.0\n',
      },
      message: /installed OpenCode version is unknown.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
    },
  ])('a public seat refuses an $description version before creating state or spawning', async ({
    result,
    message,
  }) => {
    await withProcessEnv(ALLOW_UNTESTED_OPENCODE_VERSION_ENV, undefined, async () => {
      await withTemp(async (root) => {
        const workspace = join(root, 'workspace');
        const keyFile = join(root, 'provider-key');
        const seatRoot = join(root, 'seat-state');
        await mkdir(workspace, { recursive: true });
        await writeFile(keyFile, 'version-gate-test-key');
        await chmod(keyFile, 0o600);
        spawnSyncMock.mockImplementation((_cmd, args = []) => (args[0] === '--version'
          ? result
          : { status: 0, stdout: '/usr/local/bin/opencode\n' }));
        const spawn = makeSpawnImpl();
        await expect(opencode.spawn('public turn', {
          cwd: workspace,
          env: { PATH: process.env.PATH },
          environment: {
            model: 'test-model',
            provider: {
              id: 'test-provider', baseURL: 'https://llm.example.test/v1', keyFile,
            },
            sandbox: { trust: 'public', mode: 'workspace' },
            mcp: [],
          },
          agentName: 'public-version-gate-seat',
          _opencodeHomeRoot: seatRoot,
          _binaryPath: '/usr/local/bin/opencode',
          _platform: 'darwin',
          _spawnImpl: spawn.impl,
        })).rejects.toThrow(message);
        expect(spawn.calls).toHaveLength(0);
        expect(existsSync(seatRoot)).toBe(false);
      });
    });
  });

  test('a public seat cannot receive the version override through seat context', async () => {
    await withProcessEnv(ALLOW_UNTESTED_OPENCODE_VERSION_ENV, undefined, async () => {
      await withTemp(async (root) => {
        const workspace = join(root, 'workspace');
        const keyFile = join(root, 'provider-key');
        await mkdir(workspace, { recursive: true });
        await writeFile(keyFile, 'version-gate-test-key');
        await chmod(keyFile, 0o600);
        spawnSyncMock.mockImplementation((_cmd, args = []) => (args[0] === '--version'
          ? { status: 0, stdout: 'OpenCode 1.19.0\n' }
          : { status: 0, stdout: '/usr/local/bin/opencode\n' }));
        const spawn = makeSpawnImpl();
        await expect(opencode.spawn('public turn', {
          cwd: workspace,
          env: { PATH: process.env.PATH, [ALLOW_UNTESTED_OPENCODE_VERSION_ENV]: '1' },
          environment: {
            [ALLOW_UNTESTED_OPENCODE_VERSION_ENV]: '1',
            model: 'test-model',
            provider: {
              id: 'test-provider', baseURL: 'https://llm.example.test/v1', keyFile,
            },
            sandbox: { trust: 'public', mode: 'workspace' },
            mcp: [],
          },
          _binaryPath: '/usr/local/bin/opencode',
          _platform: 'darwin',
          _spawnImpl: spawn.impl,
        })).rejects.toThrow(/refuse to run.*1\.19\.0.*1\.18\.35.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/);
        expect(spawn.calls).toHaveLength(0);
        expect(validateEnvironmentSpec({
          version: 1, [ALLOW_UNTESTED_OPENCODE_VERSION_ENV]: '1',
        })).toMatchObject({ ok: false, errors: [expect.stringContaining('unknown top-level key')] });
      });
    });
  });

  test.each([
    { value: '1', allow: true, outcome: 'honored' },
    { value: 'true', allow: false, outcome: 'rejected' },
  ])('a host-process override with value "$value" is $outcome', async ({
    value,
    allow,
  }) => {
    await withProcessEnv(ALLOW_UNTESTED_OPENCODE_VERSION_ENV, value, async () => {
      await withTemp(async (root) => {
        const workspace = join(root, 'workspace');
        const keyFile = join(root, 'provider-key');
        await mkdir(workspace, { recursive: true });
        await writeFile(keyFile, 'version-gate-test-key');
        await chmod(keyFile, 0o600);
        spawnSyncMock.mockImplementation((_cmd, args = []) => (args[0] === '--version'
          ? { status: 0, stdout: 'OpenCode 1.19.0\n' }
          : { status: 0, stdout: '/usr/local/bin/opencode\n' }));
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const spawn = makeSpawnImpl({ onCall: (_cmd, _args, options) => {
          expect(options.env[ALLOW_UNTESTED_OPENCODE_VERSION_ENV]).toBeUndefined();
        } });
        const spawnOptions = {
          cwd: workspace,
          env: { PATH: process.env.PATH, [ALLOW_UNTESTED_OPENCODE_VERSION_ENV]: value },
          environment: {
            model: 'test-model',
            provider: {
              id: 'test-provider', baseURL: 'https://llm.example.test/v1', keyFile,
            },
            sandbox: { trust: 'public', mode: 'workspace' },
            mcp: [],
          },
          _binaryPath: '/usr/local/bin/opencode',
          _platform: 'darwin',
          _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', '-p', '(deny default)', ...argv],
          _spawnImpl: spawn.impl,
        };
        try {
          if (allow) {
            await opencode.spawn('public turn', spawnOptions);
            expect(spawn.calls).toHaveLength(1);
            expect(warning).toHaveBeenCalledWith(
              '[opencode] installed OpenCode 1.19.0 is newer than smoke-tested 1.18.35; continuing because the host process set COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1',
            );
          } else {
            await expect(opencode.spawn('public turn', spawnOptions)).rejects.toThrow(
              /refuse to run.*1\.19\.0.*1\.18\.35.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
            );
            expect(spawn.calls).toHaveLength(0);
            expect(warning).not.toHaveBeenCalled();
          }
        } finally {
          warning.mockRestore();
        }
      });
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
      const spawn = makeSpawnImpl();
      await expect(opencode.spawn('public turn', {
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
        _wrapArgvWithSeatbelt: () => { throw new Error('refusal must precede sandbox spawn'); },
      })).rejects.toThrow(/environment\.provider.*auth\.json.*unsupported for public trust/);
      expect(spawn.calls).toHaveLength(0);
      expect(existsSync(join(seatRoot, 'data', 'opencode', 'auth.json'))).toBe(false);
    });
  });

  test('a public macOS read-only spawn uses Seatbelt read access', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const seatRoot = join(root, 'opencode-state');
      const keyFile = join(root, 'provider-key');
      const xdgData = join(root, 'operator-data');
      const operatorAuth = join(xdgData, 'opencode', 'auth.json');
      await mkdir(workspace, { recursive: true });
      await mkdir(join(xdgData, 'opencode'), { recursive: true });
      await writeFile(operatorAuth, '{"access":"operator-auth-must-not-be-linked"}');
      await writeFile(keyFile, 'read-only-provider-key');
      await chmod(keyFile, 0o600);
      let loopbackPort;
      let readOnlyConfigRoot;
      const spawn = makeSpawnImpl({
        onCall: (cmd, args, options) => {
          expect(cmd).toBe('/usr/bin/sandbox-exec');
          expect(args[0]).toBe('-p');
          expect(options.env.HOME).toBe(join(readOnlyConfigRoot, 'home'));
          expect(existsSync(join(options.env.HOME, '.opencode'))).toBe(false);
          const policy = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
          expect(policy.permission.edit['*']).toBe('deny');
          expect(policy.permission.external_directory).toBe('deny');
          expect(policy.enabled_providers).toEqual(['litellm']);
          expect(Number(new URL(policy.provider.litellm.options.baseURL).port)).toBe(loopbackPort);
          expect(existsSync(join(seatRoot, 'data', 'opencode', 'auth.json'))).toBe(false);
        },
      });
      await opencode.spawn('read-only turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH, XDG_DATA_HOME: xdgData },
        environment: {
          model: 'gpt-5.4',
          provider: { id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile },
          sandbox: { trust: 'public', mode: 'read-only' },
          mcp: [],
        },
        agentName: 'read-only-agent',
        _opencodeHomeRoot: seatRoot,
        _binaryPath: '/usr/local/bin/opencode',
        _platform: 'darwin',
        _spawnImpl: spawn.impl,
        _wrapArgvWithSeatbelt: (argv, opts) => {
          readOnlyConfigRoot = opts.mcpConfigDir;
          expect(opts.workspaceAccess).toBe('read');
          expect(opts.executablePath).toBe('/usr/local/bin/opencode');
          expect(opts.readOnlyPaths).toEqual([]);
          expect(opts.loopbackNetworkPorts).toHaveLength(1);
          loopbackPort = opts.loopbackNetworkPorts[0];
          const profile = buildSeatbeltProfile(opts);
          expect(profile).not.toContain(keyFile);
          expect(profile).not.toContain(operatorAuth);
          const writableRules = profile.split(/\n\n+/).filter((rule) => rule.includes('file-write*'));
          expect(writableRules.some((rule) => rule.includes(opts.mcpConfigDir))).toBe(false);
          expect(profile).toContain(`(allow network-outbound (remote tcp "localhost:${loopbackPort}"))`);
          expect(profile).not.toContain(`localhost:${loopbackPort === 65535 ? 1 : loopbackPort + 1}`);
          return ['/usr/bin/sandbox-exec', '-p', '(deny default)', ...argv];
        },
      });
    });
  });

  test('a public Linux spawn derives bwrap without binding operator auth.json', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const xdgData = join(root, 'operator-data');
      const seatRoot = join(root, 'opencode-state');
      const keyFile = join(root, 'provider-key');
      let readOnlyConfigRoot;
      await mkdir(workspace, { recursive: true });
      await writeFile(keyFile, 'linux-provider-key');
      await chmod(keyFile, 0o600);
      const spawn = makeSpawnImpl({
        onCall: (cmd, args, options) => {
          expect(cmd).toBe('/usr/bin/bwrap');
          expect(args[0]).toBe('--test');
          expect(options.env.HOME).toBe(join(readOnlyConfigRoot, 'home'));
          expect(options.env.HOME).toContain('commonly-opencode-');
          expect(options.env.HOME).not.toBe(seatRoot);
          expect(existsSync(join(options.env.HOME, '.opencode'))).toBe(false);
          const policy = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
          expect(policy.permission.edit['*']).toBe('allow');
        },
      });
      await opencode.spawn('public Linux turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH, XDG_DATA_HOME: xdgData },
        environment: {
          model: 'gpt-5.4',
          provider: { id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile },
          sandbox: { trust: 'public', mode: 'bwrap' },
          mcp: [],
        },
        agentName: 'public-linux-agent',
        _opencodeHomeRoot: seatRoot,
        _binaryPath: '/usr/local/bin/opencode',
        _platform: 'linux',
        _detectBwrap: () => ({ available: true, path: '/usr/bin/bwrap' }),
        _wrapArgvWithBwrap: (argv, environment, opts) => {
          readOnlyConfigRoot = opts.readOnlyPaths[0];
          expect(opts.workspacePath).toBe(workspace);
          expect(opts.readOnlyPaths).toEqual([
            expect.any(String), '/usr/local/bin/opencode', process.execPath,
          ]);
          expect(opts.readOnlyPaths).not.toContain(keyFile);
          expect(opts.readOnlyPaths).not.toContain(join(xdgData, 'opencode', 'auth.json'));
          expect(opts).not.toHaveProperty('loopbackNetworkPorts');
          expect(environment.sandbox.filesystem['write-outside']).not.toContain(opts.readOnlyPaths[0]);
          expect(environment.sandbox.filesystem['write-outside']).toContain(seatRoot);
          return ['/usr/bin/bwrap', '--test', ...argv];
        },
        _spawnImpl: spawn.impl,
      });
    });
  });
});
