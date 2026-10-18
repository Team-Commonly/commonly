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
  PUBLIC_TOOL_FAILED_CODE,
  publicToolFailure,
  publicPermissions,
  qualifiedProviderModel,
  resolveProviderKeyFile,
  startProviderProxy,
  ALLOW_UNTESTED_OPENCODE_VERSION_ENV,
  TESTED_OPENCODE_VERSIONS,
} = await import('../src/lib/adapters/opencode.js');

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation((_cmd, args = []) => (args[0] === '--version'
    ? { status: 0, stdout: `OpenCode ${TESTED_OPENCODE_VERSIONS[0]}\n` }
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
    expect(permission.edit['**/.npmrc']).toBe('deny');
    expect(permission.edit['**/.yarnrc*']).toBe('deny');
    expect(permission.read['**/.npmrc']).toBeUndefined();
    expect(publicPermissions('bwrap', []).edit['*']).toBe('allow');
    expect(publicPermissions('read-only', [])).toMatchObject({ edit: { '*': 'deny' } });
  });

  test('a public cold MCP is omitted from OpenCode config', async () => {
    await withTemp(async (root) => {
      const home = join(root, 'mcp-home');
      await mkdir(home);
      await writeFile(join(home, '.warm.lock'), 'warming\n');
      const unavailableMcp = [];
      await withProcessEnv('COMMONLY_MCP_HOME', home, async () => {
        const config = buildMcpConfig([{
          name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'],
        }], { publicSeat: true, unavailableMcp });
        expect(config).toEqual({});
        expect(unavailableMcp).toEqual(['commonly']);
      });
    });
  });

  test('a warm public MCP grants only its selected version directory to Seatbelt', async () => {
    await withTemp(async (root) => {
      const home = join(root, 'mcp-home');
      const versionDir = join(home, '0.3.13');
      const pkgDir = join(versionDir, 'node_modules', '@commonlyai', 'mcp');
      await mkdir(join(pkgDir, 'src'), { recursive: true });
      await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
        name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': 'src/index.js' },
      }));
      await writeFile(join(pkgDir, 'src', 'index.js'), '');
      await writeFile(join(home, 'current'), '0.3.13\n');
      await writeFile(join(home, '.warm.lock'), 'warming\n');
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      const keyFile = join(root, 'provider-key');
      await writeFile(keyFile, 'provider-secret', { mode: 0o600 });
      await withProcessEnv('COMMONLY_MCP_HOME', home, async () => {
        let profileOptions;
        const spawn = makeSpawnImpl();
        await opencode.spawn('warm turn', {
          cwd: workspace,
          env: { PATH: process.env.PATH },
          environment: {
            model: 'gpt-5.4',
            sandbox: { trust: 'public', mode: 'workspace' },
            provider: { id: 'local', baseURL: 'https://llm.example.test/v1', keyFile },
            mcp: [{ name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] }],
          },
          agentName: 'public-agent',
          _opencodeHomeRoot: join(root, 'opencode-state'),
          _binaryPath: '/usr/local/bin/opencode',
          _platform: 'darwin',
          _spawnImpl: spawn.impl,
          _wrapArgvWithSeatbelt: (argv, options) => { profileOptions = options; return argv; },
        });
        expect(profileOptions.readOnlyDirectories).toEqual([versionDir]);
        expect(profileOptions.readOnlyDirectories).not.toContain(home);
        expect(buildSeatbeltProfile(profileOptions)).toContain(`(subpath "${realpathSync(versionDir)}")`);
      });
    });
  });
});

// 2026-10-21: a canary of Commonly HQ's support seat (this adapter, its prompt,
// an unreachable API) told the asker "every Commonly tool call (`list_pods`,
// `list_artifacts`) is returning `fetch failed`". A public seat withholds such a
// turn: nothing is posted and the event stays unacked. Events are the shape
// OpenCode 1.19.0 emits, captured from that canary.
// Vera's HOLD on #2374 (79595): matching connection failures let an API 5xx
// through, because the shipped MCP reports it as `{ status, body, message }`.
// The rule is now inverted: only named answerable errors leave the turn to post.
describe('opencode public seat withholds a turn whose Commonly tools failed', () => {
  const toolError = (tool, error) => event('tool_use', 'ses_test', {
    type: 'tool', tool, state: { status: 'error', input: {}, error, time: {} },
  });
  const narration = 'Every Commonly call is returning fetch failed, so the backend is unreachable.';
  const turn = (...extra) => [
    event('step_start', 'ses_test', { type: 'step-start' }),
    ...extra,
    event('text', 'ses_test', { type: 'text', text: narration }),
    event('step_finish', 'ses_test', { type: 'step-finish', tokens: { input: 1, output: 1 } }),
  ];
  const COMMONLY_MCP = [{ name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] }];

  const runSeat = async (chunks, { trust = 'public', mcp = COMMONLY_MCP } = {}) => {
    let outcome;
    await withTemp(async (root) => {
      const home = join(root, 'mcp-home');
      const versionDir = join(home, '0.3.13');
      const pkgDir = join(versionDir, 'node_modules', '@commonlyai', 'mcp');
      await mkdir(join(pkgDir, 'src'), { recursive: true });
      await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
        name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': 'src/index.js' },
      }));
      await writeFile(join(pkgDir, 'src', 'index.js'), '');
      await writeFile(join(home, 'current'), '0.3.13\n');
      // The selected MCP is already installed for this fixture. Keep the
      // detached warmer from racing with withTemp's teardown.
      await writeFile(join(home, '.warm.lock'), 'warming\n');
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      const keyFile = join(root, 'provider-key');
      await writeFile(keyFile, 'provider-secret', { mode: 0o600 });
      return withProcessEnv('COMMONLY_MCP_HOME', home, () => opencode.spawn('a stranger asks which pods they are in', {
        cwd: workspace,
        env: { PATH: process.env.PATH },
        environment: {
          model: 'gpt-5.4',
          ...(trust === 'public' ? { sandbox: { trust: 'public', mode: 'read-only' } } : {}),
          provider: { id: 'local', baseURL: 'https://llm.example.test/v1', keyFile },
          mcp,
        },
        agentName: 'hq-canary',
        _opencodeHomeRoot: join(root, 'opencode-state'),
        _binaryPath: '/usr/local/bin/opencode',
        _platform: 'darwin',
        _spawnImpl: makeSpawnImpl({ chunks }).impl,
        _wrapArgvWithSeatbelt: (argv) => argv,
      }).then((result) => { outcome = result; }));
    });
    return outcome;
  };

  // The shipped MCP's error payloads (commonly-mcp/src/tools.js `err`).
  const http = (status, message, body = { message }) => JSON.stringify({ status, body, message });

  test('a Commonly tool that could not connect withholds the reply, and the narration is not in the error', async () => {
    const outcome = runSeat(turn(toolError('commonly_commonly_list_pods', '{"message":"fetch failed"}')));
    await expect(outcome).rejects.toMatchObject({ code: PUBLIC_TOOL_FAILED_CODE });
    await expect(runSeat(turn(toolError('commonly_commonly_list_pods', '{"message":"fetch failed"}'))))
      .rejects.toThrow(/^(?!.*backend is unreachable).*commonly_commonly_list_pods failed in a way the model must not narrate/);
  });

  test.each([
    ['an ingress 503 page while the socket connects', http(503, '<html><body>503 Service Temporarily Unavailable</body></html>', '<html><body>503 Service Temporarily Unavailable</body></html>')],
    ['a 502 with only its status', http(502, 'HTTP 502', null)],
    ['a backend 500 with its own message', http(500, 'Internal server error')],
    ['a 504 whose text names no timeout', http(504, 'Bad gateway upstream')],
    ['a rejected seat token', http(401, 'Invalid agent token')],
    ['a rate limit', http(429, 'Too many requests')],
    ['an MCP transport failure', 'MCP error -32000: Connection closed'],
    ['an error-flagged result with no text', 'MCP tool returned an error'],
    ['an empty error', ''],
    ['text this guard does not recognise', 'something unexpected happened'],
  ])('%s withholds the reply', async (_label, error) => {
    await expect(runSeat(turn(toolError('commonly_commonly_list_pods', error))))
      .rejects.toMatchObject({ code: PUBLIC_TOOL_FAILED_CODE });
  });

  test.each([
    ['a 403 the person can be told about', http(403, 'You are not a member of this pod')],
    ['a 404', http(404, 'Pod not found')],
    ['a 422 validation refusal', http(422, 'content is required')],
    ['a 400', http(400, 'podId must be an ObjectId')],
    ['a 409', http(409, 'Already claimed')],
    ['OpenCode\'s own schema check', 'The commonly_commonly_post_message tool was called with invalid arguments: podId: Required. Please rewrite the input so it satisfies the expected schema.'],
  ])('%s is still answered', async (_label, error) => {
    const result = await runSeat(turn(toolError('commonly_commonly_post_message', error)));
    expect(result.text).toBe(narration);
  });

  test('one answerable error does not excuse another that is not', async () => {
    await expect(runSeat(turn(
      toolError('commonly_commonly_get_context', http(404, 'Pod not found')),
      toolError('commonly_commonly_list_pods', http(503, 'HTTP 503', null)),
    ))).rejects.toMatchObject({ code: PUBLIC_TOOL_FAILED_CODE });
  });

  test('a connection failure in a tool that is not Commonly\'s is still answered', async () => {
    const result = await runSeat(turn(toolError('webfetch', 'fetch failed')));
    expect(result.text).toBe(narration);
  });

  test('a private seat is not affected', async () => {
    const result = await runSeat(turn(toolError('commonly_commonly_list_pods', '{"message":"fetch failed"}')), { trust: 'private' });
    expect(result.text).toBe(narration);
  });

  test('the parser records failed tool calls, whether the error is text or an object', () => {
    const parser = makeEventParser();
    parser.consume(toolError('commonly_commonly_list_pods', '{"message":"fetch failed"}'));
    parser.consume(toolError('commonly_commonly_get_context', { message: 'connect ECONNREFUSED 127.0.0.1:9' }));
    parser.consume(event('tool_use', 'ses_test', { type: 'tool', tool: 'read', state: { status: 'completed', output: 'ok' } }));
    parser.flush();
    expect(parser.toolErrors).toEqual([
      { tool: 'commonly_commonly_list_pods', error: '{"message":"fetch failed"}' },
      { tool: 'commonly_commonly_get_context', error: '{"message":"connect ECONNREFUSED 127.0.0.1:9"}' },
    ]);
  });

  test('only the shipped Commonly server counts, under whatever name it was declared', () => {
    const failed = [{ tool: 'hq_commonly_list_pods', error: 'fetch failed' }];
    expect(publicToolFailure(failed, [{ name: 'hq', command: ['npx', '-y', '@commonlyai/mcp@0.3.13'] }]))
      .toEqual(failed[0]);
    expect(publicToolFailure(failed, [{ name: 'hq', command: ['node', '/elsewhere/server.js'] }])).toBeNull();
    expect(publicToolFailure(failed, undefined)).toBeNull();
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
      let observedBody = null;
      const requestBytes = Buffer.from('{ "model": "fake", "messages": [{ "role": "assistant", "thought_signature": "σ雪" }] }');
      const responseBytes = Buffer.from('{ "ok": true, "thought_signature": "σ雪" }\n');
      const upstream = createServer((req, res) => {
        observed = {
          authorization: req.headers.authorization,
          host: req.headers.host,
          url: req.url,
        };
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          observedBody = Buffer.concat(chunks);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(responseBytes);
        });
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
          body: requestBytes,
        });
        expect(response.status).toBe(200);
        expect(observedBody).toEqual(requestBytes);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(responseBytes);
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

  // OpenCode 1.18.35 and 1.19.0 replay Gemini thought signatures natively.
  // Private seats can use the same direct provider path as other private seats.
  test('a private Gemini seat uses its provider directly', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const keyFile = join(root, 'secrets', 'gemini-key');
      await mkdir(workspace, { recursive: true });
      await mkdir(join(root, 'secrets'), { recursive: true });
      await writeFile(keyFile, 'gemini-secret-never-inline');
      await chmod(keyFile, 0o600);
      const spawn = makeSpawnImpl({
        onCall: (_cmd, _args, options) => {
          const config = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
          const { baseURL, apiKey } = config.provider.google.options;
          expect(baseURL).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
          expect(apiKey).toBe(`{file:${realpathSync(keyFile)}}`);
        },
      });
      await opencode.spawn('gemini turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH, XDG_DATA_HOME: join(root, 'operator-data') },
        environment: {
          model: 'gemini-3-flash-preview',
          provider: {
            id: 'google', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', keyFile,
          },
        },
        _binaryPath: '/usr/local/bin/opencode',
        _spawnImpl: spawn.impl,
      });
      expect(spawn.calls).toHaveLength(1);
    });
  });

  test.each([
    ['older', { status: 0, stdout: 'OpenCode 1.18.0\n' }, '1.18.0'],
    ['boundary prerelease', { status: 0, stdout: 'OpenCode 1.18.35-rc.1\n' }, '1.18.35-rc.1'],
    ['later patch prerelease', { status: 0, stdout: 'OpenCode 1.18.36-rc.1\n' }, '1.18.36-rc.1'],
    ['later minor prerelease', { status: 0, stdout: 'OpenCode 1.19.0-rc.1\n' }, '1.19.0-rc.1'],
    ['unknown', { status: 1, stdout: '' }, 'unknown'],
  ])('a private Gemini seat refuses %s OpenCode before spawning', async (_label, result, version) => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const keyFile = join(root, 'secrets', 'gemini-key');
      await mkdir(workspace, { recursive: true });
      await mkdir(join(root, 'secrets'), { recursive: true });
      await writeFile(keyFile, 'gemini-test-key');
      await chmod(keyFile, 0o600);
      spawnSyncMock.mockReturnValue(result);
      const spawn = makeSpawnImpl();
      await expect(opencode.spawn('gemini turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH },
        environment: {
          model: 'gemini-3-flash-preview',
          provider: {
            id: 'google', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', keyFile,
          },
        },
        _binaryPath: '/usr/local/bin/opencode',
        _spawnImpl: spawn.impl,
      })).rejects.toThrow(`Gemini requires stable OpenCode 1.18.35 or later for native thought-signature replay; installed version is ${version}`);
      expect(spawn.calls).toHaveLength(0);
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
        _wrapArgvWithBwrap: (argv, wrappedEnvironment, opts) => {
          expect(wrappedEnvironment.sandbox.network.policy).toBe('restricted');
          expect(opts.readOnlyPaths).toEqual([
            expect.stringMatching(/commonly-opencode-/),
            '/usr/local/bin/opencode',
            process.execPath,
            expect.stringMatching(/opencode-loopback\.mjs$/),
          ]);
          expect(opts.optionalReadOnlyPaths).toEqual(['/usr/sbin', '/sbin']);
          expect(opts.enableLoopback).toBe(true);
          expect(argv.slice(0, 2)).toEqual([process.execPath, expect.stringMatching(/opencode-loopback\.mjs$/)]);
          expect(argv[2]).toMatch(/provider-proxy\.sock$/);
          expect(opts.readOnlyPaths).not.toContain(realKey);
          expect(opts.readOnlyPaths).not.toContain(realAuthPath);
          return ['/usr/bin/bwrap', '--test', ...argv];
        },
      });
    });
  });

  test('public bwrap uses its isolated proxy even when restricted networking is requested', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const keyFile = join(root, 'provider-key');
      await mkdir(workspace, { recursive: true });
      await writeFile(keyFile, 'provider-key', { mode: 0o600 });
      const spawn = makeSpawnImpl();
      await opencode.spawn('public provider turn', {
        cwd: workspace,
        env: { PATH: process.env.PATH },
        environment: {
          model: 'gpt-5.4',
          provider: { id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile },
          sandbox: {
            trust: 'public', mode: 'bwrap', network: { policy: 'restricted' },
          },
        },
        agentName: 'public-provider-seat',
        _binaryPath: '/usr/local/bin/opencode',
        _platform: 'linux',
        _detectBwrap: () => ({ available: true, path: '/usr/bin/bwrap' }),
        _spawnImpl: spawn.impl,
        _wrapArgvWithBwrap: (argv, environment, opts) => {
          expect(environment.sandbox.network.policy).toBe('restricted');
          expect(opts.enableLoopback).toBe(true);
          expect(argv[2]).toMatch(/provider-proxy\.sock$/);
          return ['/usr/bin/bwrap', '--test', ...argv];
        },
      });
      expect(spawn.calls).toHaveLength(1);
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
  test('records both smoke-tested OpenCode versions', () => {
    expect(TESTED_OPENCODE_VERSIONS).toEqual(['1.18.35', '1.19.0']);
  });

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

  test.each(['1.18.35', '1.19.0'])('a public seat accepts smoke-tested OpenCode %s', async (version) => {
    await withProcessEnv(ALLOW_UNTESTED_OPENCODE_VERSION_ENV, undefined, async () => {
      await withTemp(async (root) => {
        const workspace = join(root, 'workspace');
        const keyFile = join(root, 'provider-key');
        await mkdir(workspace, { recursive: true });
        await writeFile(keyFile, 'version-gate-test-key');
        await chmod(keyFile, 0o600);
        spawnSyncMock.mockImplementation((_cmd, args = []) => (args[0] === '--version'
          ? { status: 0, stdout: `OpenCode ${version}\n` }
          : { status: 0, stdout: '/usr/local/bin/opencode\n' }));
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const spawn = makeSpawnImpl();
        try {
          await opencode.spawn('public turn', {
            cwd: workspace,
            env: { PATH: process.env.PATH },
            environment: {
              model: 'test-model',
              provider: { id: 'test-provider', baseURL: 'https://llm.example.test/v1', keyFile },
              sandbox: { trust: 'public', mode: 'workspace' },
              mcp: [],
            },
            agentName: 'public-version-gate-seat',
            _binaryPath: '/usr/local/bin/opencode',
            _platform: 'darwin',
            _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', '-p', '(deny default)', ...argv],
            _spawnImpl: spawn.impl,
          });
          expect(spawn.calls).toHaveLength(1);
          expect(warning).not.toHaveBeenCalled();
        } finally {
          warning.mockRestore();
        }
      });
    });
  });

  test('a trusted seat warns on a newer version and still spawns', async () => {
    await withProcessEnv(ALLOW_UNTESTED_OPENCODE_VERSION_ENV, '1', async () => {
      await withTemp(async (root) => {
        const workspace = join(root, 'workspace');
        await mkdir(workspace, { recursive: true });
        spawnSyncMock.mockImplementation((_cmd, args = []) => (args[0] === '--version'
          ? { status: 0, stdout: 'OpenCode 1.20.0\n' }
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
            '[opencode] installed OpenCode 1.20.0 is newer than smoke-tested versions 1.18.35, 1.19.0; trusted seat continues',
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
      message: /installed OpenCode 1\.18\.0 is older than smoke-tested versions 1\.18\.35, 1\.19\.0.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
    },
    {
      description: 'between smoke-tested versions',
      result: { status: 0, stdout: 'OpenCode 1.18.40\n' },
      message: /installed OpenCode 1\.18\.40 differs from smoke-tested versions 1\.18\.35, 1\.19\.0.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
    },
    {
      description: 'newer',
      result: { status: 0, stdout: 'OpenCode 1.20.0\n' },
      message: /installed OpenCode 1\.20\.0 is newer than smoke-tested versions 1\.18\.35, 1\.19\.0.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
    },
    {
      description: 'unavailable',
      result: { status: 1, stdout: '', stderr: 'version command failed' },
      message: /installed OpenCode version is unknown; smoke-tested versions: 1\.18\.35, 1\.19\.0.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
    },
    {
      description: 'update announcement containing multiple versions',
      result: {
        status: 0,
        stdout: 'A new release is available: 1.18.35 -> 1.19.0\n',
      },
      message: /installed OpenCode version is unknown; smoke-tested versions: 1\.18\.35, 1\.19\.0.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
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
          ? { status: 0, stdout: 'OpenCode 1.20.0\n' }
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
        })).rejects.toThrow(/refuse to run.*1\.20\.0.*1\.18\.35, 1\.19\.0.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/);
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
          ? { status: 0, stdout: 'OpenCode 1.20.0\n' }
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
              '[opencode] installed OpenCode 1.20.0 is newer than smoke-tested versions 1.18.35, 1.19.0; continuing because the host process set COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1',
            );
          } else {
            await expect(opencode.spawn('public turn', spawnOptions)).rejects.toThrow(
              /refuse to run.*1\.20\.0.*1\.18\.35, 1\.19\.0.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
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

  // TASK-273: on 2026-10-15 a public seat whose MCP did not start narrated the
  // failure ("The commonly MCP server failed to connect…") and the run loop
  // posted it to a stranger. A public seat with a cold MCP now refuses the turn
  // before the model runs, so there is nothing to post.
  test('a public seat whose MCP has no host-prepared build refuses before the model runs', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const seatRoot = join(root, 'opencode-state');
      const keyFile = join(root, 'provider-key');
      const home = join(root, 'mcp-home');
      await mkdir(workspace, { recursive: true });
      await mkdir(home);
      await writeFile(join(home, '.warm.lock'), 'warming\n');
      await writeFile(keyFile, 'cold-mcp-provider-key');
      await chmod(keyFile, 0o600);
      const spawn = makeSpawnImpl();
      let wrapped = false;
      await withProcessEnv('COMMONLY_MCP_HOME', home, async () => {
        await expect(opencode.spawn('hi', {
          cwd: workspace,
          env: { PATH: process.env.PATH },
          environment: {
            model: 'deepseek-v4-flash',
            provider: { id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile },
            sandbox: { trust: 'public', mode: 'read-only' },
            mcp: [{ name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] }],
          },
          agentName: 'cold-mcp-agent',
          _opencodeHomeRoot: seatRoot,
          _binaryPath: '/usr/local/bin/opencode',
          _platform: 'darwin',
          _spawnImpl: spawn.impl,
          _wrapArgvWithSeatbelt: (argv) => { wrapped = true; return argv; },
        })).rejects.toMatchObject({ code: 'public_mcp_unavailable' });
      });
      expect(spawn.calls).toHaveLength(0);
      expect(wrapped).toBe(false);
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
            expect.stringMatching(/opencode-loopback\.mjs$/),
          ]);
          expect(opts.optionalReadOnlyPaths).toEqual(['/usr/sbin', '/sbin']);
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
