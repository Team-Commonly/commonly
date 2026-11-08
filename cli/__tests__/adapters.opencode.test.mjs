import { jest } from '@jest/globals';
// Bound before the mock below: the real git, for the worktree-boundary tests.
import { spawnSync as realSpawnSync } from 'child_process';
import { EventEmitter } from 'events';
import { createServer, request as httpRequest } from 'http';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, relative } from 'path';
import { buildSeatbeltProfile } from '../src/lib/sandbox/seatbelt.js';
import { validateEnvironmentSpec } from '../src/lib/environment.js';

const spawnSyncMock = jest.fn();
await jest.unstable_mockModule('child_process', () => ({
  // git runs for real (the worktree check); everything else is the mock.
  spawnSync: (cmd, ...rest) => (cmd === 'git' ? realSpawnSync(cmd, ...rest) : spawnSyncMock(cmd, ...rest)),
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
  scanWorkspaceLinks,
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
    const ownerTurn = publicPermissions('workspace', ['commonly'], { ownerWoken: true });
    for (const tool of ['commonly_write_agent_memory', 'commonly_save_my_memory', 'commonly_log_cycle']) {
      expect(ownerTurn[`commonly_${tool}`]).toBeUndefined();
    }
    for (const tool of ['commonly_self_install_into_pod', 'commonly_delete_message', 'commonly_attach_file', 'commonly_catch_up']) {
      expect(ownerTurn[`commonly_${tool}`]).toBe('deny');
    }

    const permission = publicPermissions('workspace', ['commonly', 'room-grants']);
    expect(permission['*']).toBe('deny');
    expect(permission.bash).toBe('deny');
    expect(permission.external_directory).toBe('deny');
    expect(permission['commonly_*']).toBe('allow');
    expect(permission['room_grants_*']).toBe('allow');
    // TASK-287: attach_file is denied after the wildcard allow, so the deny wins.
    const keys = Object.keys(permission);
    expect(permission.commonly_commonly_attach_file).toBe('deny');
    expect(permission.commonly_commonly_catch_up).toBe('deny');
    expect(keys.indexOf('commonly_commonly_attach_file')).toBeGreaterThan(keys.indexOf('commonly_*'));
    // F118: nor self-install or any memory write; the memory read stays.
    for (const tool of ['commonly_self_install_into_pod', 'commonly_write_agent_memory',
      'commonly_save_my_memory', 'commonly_log_cycle', 'commonly_delete_message']) {
      expect(permission[`commonly_${tool}`]).toBe('deny');
      expect(keys.indexOf(`commonly_${tool}`)).toBeGreaterThan(keys.indexOf('commonly_*'));
      expect(permission[`room_grants_${tool}`]).toBe('deny');
    }
    expect(permission.commonly_commonly_read_agent_memory).toBeUndefined();
    expect(permission.edit['*']).toBe('allow');
    expect(permission.edit['**/.npmrc']).toBe('deny');
    expect(permission.edit['**/.yarnrc*']).toBe('deny');
    expect(permission.read['**/.npmrc']).toBeUndefined();
    expect(publicPermissions('bwrap', []).edit['*']).toBe('allow');
    expect(publicPermissions('read-only', [])).toMatchObject({ edit: { '*': 'deny' } });
  });

  // CodeRabbit round 2 (#3487): glob, grep and list carry the spawn-folder deny
  // as pattern rules, the way read and edit do. Measured in the 1.19.4 binary:
  // OpenCode matches these rules against the tool's own argument (the glob
  // string, the grep REGEX), never against the searched path or the result
  // paths, so this stops only a search that names the folder. A search through
  // a workspace link is stopped by the pre-spawn symlink walk, not by this.
  test('glob, grep and list deny the per-spawn commonly-opencode folder as a pattern rule', () => {
    const permission = publicPermissions('workspace', []);
    for (const key of ['glob', 'grep', 'list']) {
      expect(permission[key]).toEqual(expect.objectContaining({
        '*': 'allow',
        '**/commonly-opencode-*/**': 'deny',
      }));
      // The allow first, so the deny is the later, winning rule.
      const order = Object.keys(permission[key]);
      expect(order.indexOf('**/commonly-opencode-*/**')).toBeGreaterThan(order.indexOf('*'));
    }
    // Only the spawn-folder rule: a glob for `.env` files is not a read of one.
    expect(permission.glob['**/.env']).toBeUndefined();
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
// A hold on #2374: matching connection failures let an API 5xx
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
    await expect(runSeat(turn(toolError('commonly_commonly_list_pods', '{"message":"fetch failed"}'))))
      .rejects.toThrow(/^(?!.*nothing was posted).*the CLI posted no reply for it/);
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

  // provider.api "anthropic-messages": OpenCode's own @ai-sdk/anthropic, which
  // posts to `${baseURL}/messages` with the key as x-api-key. The proxy runs the
  // anthropic-messages wire, so that request reaches the host's /v1/messages.
  test('anthropic-messages: @ai-sdk/anthropic at <host>/v1, proxied on the anthropic wire', async () => {
    expect(buildProviderConfig({
      id: 'anthropic-native', baseURL: 'https://api.anthropic.com/', api: 'anthropic-messages',
    }, 'claude-haiku-5-5', '/private/keys/anthropic')).toEqual({
      'anthropic-native': {
        npm: '@ai-sdk/anthropic',
        options: { baseURL: 'https://api.anthropic.com/v1', apiKey: '{file:/private/keys/anthropic}' },
        models: { 'claude-haiku-5-5': { name: 'claude-haiku-5-5' } },
      },
    });
    expect(opencode.providerApis).toEqual(['openai-chat', 'anthropic-messages']);
    expect(validateEnvironmentSpec({ provider: {
      id: 'a', baseURL: 'https://api.anthropic.com', keyFile: '/k', api: 'anthropic-messages',
    }, model: 'claude-haiku-5-5' }).ok).toBe(true);
    expect(validateEnvironmentSpec({ provider: {
      id: 'a', baseURL: 'https://api.anthropic.com', keyFile: '/k', api: 'responses',
    } }).errors).toContain('provider.api must be one of openai-chat, anthropic-messages');

    await withTemp(async (root) => {
      const keyFile = join(root, 'provider-key');
      const proxyTokenFile = join(root, 'proxy-token');
      await writeFile(keyFile, 'upstream-secret');
      await chmod(keyFile, 0o600);
      let observed = null;
      const upstream = createServer((req, res) => {
        observed = { apiKey: req.headers['x-api-key'], authorization: req.headers.authorization, url: req.url };
        req.resume();
        req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
      });
      await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const provider = {
        id: 'anthropic-native', baseURL: `http://127.0.0.1:${upstream.address().port}`, api: 'anthropic-messages',
      };
      const proxy = await startProviderProxy({ provider, keyFile, tokenFile: proxyTokenFile, wire: provider.api });
      try {
        const config = buildProviderConfig({ ...provider, baseURL: proxy.baseURL }, 'claude-haiku-5-5', proxyTokenFile);
        const response = await fetch(`${config['anthropic-native'].options.baseURL}/messages`, {
          method: 'POST',
          headers: { 'x-api-key': readFileSync(proxyTokenFile, 'utf8'), 'content-type': 'application/json' },
          body: '{}',
        });
        expect(response.status).toBe(200);
        expect(observed).toEqual({ apiKey: 'upstream-secret', authorization: undefined, url: '/v1/messages' });
      } finally {
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
        onCall: (_cmd, callArgs, options) => {
          // F118: the public prompt names no save tool the seat is not offered.
          expect(callArgs[callArgs.length - 1]).toContain('(empty');
          expect(callArgs[callArgs.length - 1]).not.toContain('commonly_save_my_memory');
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
          expect(permission.grep).toEqual({ '*': 'allow', '**/commonly-opencode-*/**': 'deny' });
          expect(permission.glob).toEqual({ '*': 'allow', '**/commonly-opencode-*/**': 'deny' });
          expect(permission.list).toEqual({ '*': 'allow', '**/commonly-opencode-*/**': 'deny' });
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
          expect(permission.grep).toEqual({ '*': 'allow', '**/commonly-opencode-*/**': 'deny' });
          expect(permission.glob).toEqual({ '*': 'allow', '**/commonly-opencode-*/**': 'deny' });
          expect(permission.list).toEqual({ '*': 'allow', '**/commonly-opencode-*/**': 'deny' });
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
          expect(argv[4]).toBe('-');
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
        environment: { model: 'test-model', sandbox: { trust: 'public', mode: 'workspace' }, mcp: [] },
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
  test('records every smoke-tested OpenCode version', () => {
    expect(TESTED_OPENCODE_VERSIONS).toEqual(['1.18.35', '1.19.0', '1.19.4']);
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
          environment: { model: 'test-model', mcp: [] },
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

  test.each(['1.18.35', '1.19.0', '1.19.4'])('a public seat accepts smoke-tested OpenCode %s', async (version) => {
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

  test.each(['1.19.5', '1.19.12'])('a public seat warns and runs a later patch %s of the newest tested line', async (version) => {
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
          expect(warning).toHaveBeenCalledWith(
            `[opencode] installed OpenCode ${version} is newer than smoke-tested versions 1.18.35, 1.19.0, 1.19.4; `
            + 'a patch release on the newest smoke-tested line, so the public seat continues',
          );
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
            environment: { model: 'test-model', mcp: [] },
            _binaryPath: '/usr/local/bin/opencode',
            _spawnImpl: spawn.impl,
          });
          expect(spawn.calls).toHaveLength(1);
          expect(warning).toHaveBeenCalledWith(
            '[opencode] installed OpenCode 1.20.0 is newer than smoke-tested versions 1.18.35, 1.19.0, 1.19.4; trusted seat continues',
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
      message: /installed OpenCode 1\.18\.0 is older than smoke-tested versions 1\.18\.35, 1\.19\.0, 1\.19\.4.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
    },
    {
      description: 'between smoke-tested versions',
      result: { status: 0, stdout: 'OpenCode 1.18.40\n' },
      message: /installed OpenCode 1\.18\.40 differs from smoke-tested versions 1\.18\.35, 1\.19\.0, 1\.19\.4.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
    },
    {
      description: 'prerelease of the next patch',
      result: { status: 0, stdout: 'OpenCode 1.19.5-rc.1\n' },
      message: /installed OpenCode 1\.19\.5-rc\.1 .*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
    },
    {
      description: 'next minor',
      result: { status: 0, stdout: 'OpenCode 1.20.1\n' },
      message: /installed OpenCode 1\.20\.1 is newer than smoke-tested versions 1\.18\.35, 1\.19\.0, 1\.19\.4.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
    },
    {
      description: 'newer',
      result: { status: 0, stdout: 'OpenCode 1.20.0\n' },
      message: /installed OpenCode 1\.20\.0 is newer than smoke-tested versions 1\.18\.35, 1\.19\.0, 1\.19\.4.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
    },
    {
      description: 'unavailable',
      result: { status: 1, stdout: '', stderr: 'version command failed' },
      message: /installed OpenCode version is unknown; smoke-tested versions: 1\.18\.35, 1\.19\.0, 1\.19\.4.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
    },
    {
      description: 'update announcement containing multiple versions',
      result: {
        status: 0,
        stdout: 'A new release is available: 1.18.35 -> 1.19.0\n',
      },
      message: /installed OpenCode version is unknown; smoke-tested versions: 1\.18\.35, 1\.19\.0, 1\.19\.4.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
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
        })).rejects.toThrow(/refuse to run.*1\.20\.0.*1\.18\.35, 1\.19\.0, 1\.19\.4.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/);
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
              '[opencode] installed OpenCode 1.20.0 is newer than smoke-tested versions 1.18.35, 1.19.0, 1.19.4; continuing because the host process set COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1',
            );
          } else {
            await expect(opencode.spawn('public turn', spawnOptions)).rejects.toThrow(
              /refuse to run.*1\.20\.0.*1\.18\.35, 1\.19\.0, 1\.19\.4.*COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION=1/,
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
      await expect(opencode.spawn('second turn', { environment: { model: 'test-model' },
        ...baseContext, sessionId: 'ses-created', _spawnImpl: resumed.impl,
      })).resolves.toMatchObject({ newSessionId: 'ses-created' });
    });
  });

  test('a saved session OpenCode does not know starts one fresh turn, and other failures do not retry', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const xdgData = join(root, 'operator-data');
      const appData = join(xdgData, 'opencode');
      await mkdir(workspace, { recursive: true });
      await mkdir(appData, { recursive: true });
      await writeFile(join(appData, 'auth.json'), JSON.stringify({ provider: 'dummy-auth' }));
      const notFound = `${JSON.stringify({
        type: 'error', sessionID: 'claude-uuid', error: { data: { message: 'Session not found' } },
      })}\n`;
      const calls = [];
      const impl = (cmd, args) => {
        calls.push(args);
        const failing = args.includes('-s') && calls.length === 1;
        return fakeChild(failing
          ? { chunks: [notFound], code: 1 }
          : { chunks: sampleEvents('ses-fresh') });
      };
      const baseContext = {
        sessionId: 'claude-uuid',
        cwd: workspace,
        env: { ...process.env, XDG_DATA_HOME: xdgData },
        environment: { model: 'anthropic/claude-sonnet-4-5' },
        agentName: 'kai-seat',
        metadata: { event: { podId: 'pod-1' } },
        _binaryPath: '/usr/local/bin/opencode',
        _spawnImpl: impl,
      };
      await expect(opencode.spawn('resumed turn', baseContext)).resolves.toMatchObject({
        text: 'Hello from OpenCode.', newSessionId: 'ses-fresh',
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(expect.arrayContaining(['-s', 'claude-uuid']));
      expect(calls[1]).not.toContain('-s');

      calls.length = 0;
      const failingImpl = (cmd, args) => {
        calls.push(args);
        return fakeChild({ stderr: 'provider rejected the request', code: 1 });
      };
      await expect(opencode.spawn('resumed turn', { ...baseContext, _spawnImpl: failingImpl }))
        .rejects.toThrow(/provider rejected/);
      expect(calls).toHaveLength(1);
    });
  });

  test('a session-not-found phrase after the model acted is not retried, so the turn cannot post twice', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const xdgData = join(root, 'operator-data');
      const appData = join(xdgData, 'opencode');
      await mkdir(workspace, { recursive: true });
      await mkdir(appData, { recursive: true });
      await writeFile(join(appData, 'auth.json'), JSON.stringify({ provider: 'dummy-auth' }));
      const acted = [
        event('step_start', 'ses-resumed', { type: 'step-start' }),
        event('tool_use', 'ses-resumed', { tool: 'commonly_post_message', state: { status: 'completed' } }),
      ].join('');
      const calls = [];
      const impl = (cmd, args) => {
        calls.push(args);
        return fakeChild({ chunks: [acted], stderr: 'Session not found', code: 1 });
      };
      await expect(opencode.spawn('resumed turn', {
        sessionId: 'ses-resumed',
        cwd: workspace,
        env: { ...process.env, XDG_DATA_HOME: xdgData },
        environment: { model: 'anthropic/claude-sonnet-4-5' },
        agentName: 'kai-seat',
        metadata: { event: { podId: 'pod-1' } },
        _binaryPath: '/usr/local/bin/opencode',
        _spawnImpl: impl,
      })).rejects.toThrow(/Session not found/);
      expect(calls).toHaveLength(1);
    });
  });

  test('a session-not-found failure with no saved session is not retried', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const xdgData = join(root, 'operator-data');
      const appData = join(xdgData, 'opencode');
      await mkdir(workspace, { recursive: true });
      await mkdir(appData, { recursive: true });
      await writeFile(join(appData, 'auth.json'), JSON.stringify({ provider: 'dummy-auth' }));
      const notFound = `${JSON.stringify({
        type: 'error', sessionID: 'ses-fresh', error: { data: { message: 'Session not found' } },
      })}\n`;
      const calls = [];
      const impl = (cmd, args) => {
        calls.push(args);
        return fakeChild({ chunks: [notFound], code: 1 });
      };
      await expect(opencode.spawn('fresh turn', {
        sessionId: null,
        cwd: workspace,
        env: { ...process.env, XDG_DATA_HOME: xdgData },
        environment: { model: 'anthropic/claude-sonnet-4-5' },
        agentName: 'kai-seat',
        metadata: { event: { podId: 'pod-1' } },
        _binaryPath: '/usr/local/bin/opencode',
        _spawnImpl: impl,
      })).rejects.toThrow(/Session not found/);
      expect(calls).toHaveLength(1);
    });
  });

  test('a session-not-found failure after only a step event is not retried', async () => {
    await withTemp(async (root) => {
      const workspace = join(root, 'workspace');
      const xdgData = join(root, 'operator-data');
      const appData = join(xdgData, 'opencode');
      await mkdir(workspace, { recursive: true });
      await mkdir(appData, { recursive: true });
      await writeFile(join(appData, 'auth.json'), JSON.stringify({ provider: 'dummy-auth' }));
      const stepOnly = event('step_start', 'ses-resumed', { type: 'step-start' });
      const calls = [];
      const impl = (cmd, args) => {
        calls.push(args);
        return fakeChild({ chunks: [stepOnly], stderr: 'Session not found', code: 1 });
      };
      await expect(opencode.spawn('resumed turn', {
        sessionId: 'ses-resumed',
        cwd: workspace,
        env: { ...process.env, XDG_DATA_HOME: xdgData },
        environment: { model: 'anthropic/claude-sonnet-4-5' },
        agentName: 'kai-seat',
        metadata: { event: { podId: 'pod-1' } },
        _binaryPath: '/usr/local/bin/opencode',
        _spawnImpl: impl,
      })).rejects.toThrow(/Session not found/);
      expect(calls).toHaveLength(1);
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
        environment: { model: 'test-model', sandbox: { trust: 'public', mode: 'workspace' }, mcp: [] },
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

test('an own key stays in the confined parent proxy, never argv, config, tool env or failure output', async () => {
  await withTemp(async (root) => {
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    const vendorKey = 'sk-OWN-KEY-parent-only';
    let config;
    const spawn = makeSpawnImpl({ onCall: (_cmd, args, options) => {
      expect(JSON.stringify({ args, env: options.env })).not.toContain(vendorKey);
      config = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
      expect(JSON.stringify(config)).not.toContain(vendorKey);
      expect(JSON.stringify(config)).not.toContain('/missing/vendor-key');
    } });
    await opencode.spawn('test', { cwd: workspace, env: { PATH: process.env.PATH },
      environment: { model: 'test-model', provider: { id: 'test-provider', baseURL: 'https://api.example.com/v1', keyFile: '/missing/vendor-key' },
        sandbox: { trust: 'public', mode: 'workspace' }, mcp: [] },
      providerKey: vendorKey, _platform: 'darwin', _binaryPath: '/usr/local/bin/opencode',
      _wrapArgvWithSeatbelt: (argv, options) => {
        const profile = buildSeatbeltProfile(options);
        expect(profile).not.toContain(vendorKey);
        return ['/usr/bin/sandbox-exec', '-p', profile, ...argv];
      },
      _spawnImpl: spawn.impl });
    expect(spawn.calls).toHaveLength(1);
    expect(config.provider['test-provider']).toBeDefined();
    await expect(opencode.spawn('test', { cwd: workspace, environment: { model: 'm',
      provider: { id: 'p', baseURL: 'https://api.example.com/v1', keyFile: '/unused' },
      sandbox: { trust: 'private', mode: 'none' } }, providerKey: vendorKey, _spawnImpl: spawn.impl }))
      .rejects.toThrow('Own provider keys require a confined OpenCode runtime');
    expect(spawn.calls).toHaveLength(1);
  });
});

// F175a: OpenCode joins the grant-broker set. The broker entry rides the same
// http branch as any remote MCP: a file-backed bearer on THIS spawn's
// credential file, never the token in config, env or argv. What keeps the
// credential from the agent's own tools is OpenCode's permission layer, not the
// OS jail (OpenCode itself must read the file to expand {file:}): read, glob,
// grep and lsp each ask `external_directory` for a path outside --dir
// (Tool.assertExternalDirectory, checked in the 1.19.4 binary 2026-11-04), and
// a public seat denies it after OpenCode's own defaults, so its `$TMPDIR/*`
// allow does not survive. That holds only while the credential lives OUTSIDE
// the workspace, which is what the last test pins.
describe('opencode public seat — the grant broker (F175a)', () => {
  const BROKER = {
    name: 'commonly-grant-broker', transport: 'http',
    url: '${COMMONLY_API_URL}/api/mcp/grants/grant_1',
    headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
  };
  const TOKEN = 'cm_agent_broker_seat_token';
  const within = (parent, child) => {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const publicCtx = async (root, over = {}) => {
    const workspace = join(root, 'workspace');
    const keyFile = join(root, 'secrets', 'provider-key');
    await mkdir(workspace, { recursive: true });
    await mkdir(join(root, 'secrets'), { recursive: true });
    await writeFile(keyFile, 'provider-key');
    await chmod(keyFile, 0o600);
    return {
      cwd: workspace,
      env: { PATH: process.env.PATH, COMMONLY_AGENT_TOKEN: TOKEN },
      environment: {
        model: 'gpt-5.4',
        provider: { id: 'litellm', baseURL: 'https://llm.example.test/v1', keyFile },
        sandbox: { trust: 'public', mode: 'workspace' },
        mcp: [BROKER],
      },
      runtimeToken: TOKEN,
      instanceUrl: 'https://api.example.test',
      agentName: 'broker-seat',
      _opencodeHomeRoot: join(root, 'opencode-state'),
      _binaryPath: '/usr/local/bin/opencode',
      _platform: 'darwin',
      ...over,
    };
  };

  test('the broker is a remote entry whose bearer is this spawn\'s credential file, outside every readable root', async () => {
    await withTemp(async (root) => {
      let seen = null;
      const spawn = makeSpawnImpl({
        onCall: (_cmd, args, options) => {
          const config = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
          const entry = config.mcp['commonly-grant-broker'];
          expect(entry).toEqual({
            type: 'remote', enabled: true,
            url: 'https://api.example.test/api/mcp/grants/grant_1',
            headers: { Authorization: `Bearer {file:${options.env.COMMONLY_TOKEN_FILE}}` },
          });
          const credential = options.env.COMMONLY_TOKEN_FILE;
          expect(readFileSync(credential, 'utf8').trim()).toBe(TOKEN);
          // Never the token itself: not in config, env or argv.
          expect(JSON.stringify(config)).not.toContain(TOKEN);
          expect(Object.values(options.env).join('\n')).not.toContain(TOKEN);
          expect(args.join('\n')).not.toContain(TOKEN);
          // The per-spawn 0700 root that holds the config, not the workspace.
          const spawnRoot = dirname(options.env.OPENCODE_CONFIG);
          expect(within(spawnRoot, credential)).toBe(true);
          expect(statSync(spawnRoot).mode & 0o777).toBe(0o700);
          expect(statSync(credential).mode & 0o777).toBe(0o600);
          // Readable set: OpenCode's tools read the workspace (--dir) freely
          // and reach anything else only through external_directory, denied.
          const dirArg = args[args.indexOf('--dir') + 1];
          expect(within(dirArg, credential)).toBe(false);
          expect(within(realpathSync(dirArg), realpathSync(credential))).toBe(false);
          const permission = config.permission;
          expect(permission.external_directory).toBe('deny');
          expect(permission.bash).toBe('deny');
          expect(permission.webfetch).toBe('deny');
          expect(permission.task).toBe('deny');
          // The broker's own tools are allowed, its withheld writes still denied.
          expect(permission['commonly_grant_broker_*']).toBe('allow');
          seen = credential;
        },
      });
      await opencode.spawn('broker turn', await publicCtx(root, {
        _spawnImpl: spawn.impl,
        _wrapArgvWithSeatbelt: (argv, opts) => {
          // Seatbelt admits the spawn root because OpenCode itself expands
          // {file:} from it; the jail is not what hides it from the tools.
          expect(opts.mcpConfigDir).toMatch(/commonly-opencode-/);
          return ['/usr/bin/sandbox-exec', '-p', '(deny default)', ...argv];
        },
      }));
      expect(seen).not.toBeNull();
      // Per spawn: gone once the turn ends.
      expect(existsSync(seen)).toBe(false);
    });
  });

  test('a public bwrap seat carries the broker the same way, through the instance bridge', async () => {
    await withTemp(async (root) => {
      const spawn = makeSpawnImpl({
        onCall: (_cmd, args, options) => {
          const config = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
          expect(config.mcp['commonly-grant-broker']).toEqual({
            type: 'remote', enabled: true,
            url: 'http://127.0.0.1:8766/api/mcp/grants/grant_1',
            headers: { Authorization: `Bearer {file:${options.env.COMMONLY_TOKEN_FILE}}` },
          });
          expect(config.permission.external_directory).toBe('deny');
          expect(JSON.stringify(config)).not.toContain(TOKEN);
          expect(args.join('\n')).not.toContain(TOKEN);
        },
      });
      const ctx = await publicCtx(root, {
        _platform: 'linux',
        _detectBwrap: () => ({ available: true, path: '/usr/bin/bwrap' }),
        _spawnImpl: spawn.impl,
        _wrapArgvWithBwrap: (argv) => ['/usr/bin/bwrap', '--test', ...argv],
      });
      ctx.environment.sandbox = { trust: 'public', mode: 'bwrap' };
      await opencode.spawn('broker turn', ctx);
      expect(spawn.calls).toHaveLength(1);
    });
  });

  test('a public seat whose workspace would contain the credential refuses before the model runs', async () => {
    await withTemp(async (root) => {
      const spawn = makeSpawnImpl();
      // The workspace is the temp root every per-spawn directory is made in:
      // the credential would sit inside --dir, where read needs no
      // external_directory approval.
      // An own key (no key file), since a key file under the temp root would
      // be refused first, by the key-file check.
      const ctx = await publicCtx(root, { cwd: realpathSync(tmpdir()), providerKey: 'sk-own-key', _spawnImpl: spawn.impl,
        _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv] });
      await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/credential.*workspace/i);
      expect(spawn.calls).toHaveLength(0);
    });
  });

  // Review fix (#3487): LSP servers and formatters run workspace code (a planted
  // tsserver.js, a prettier config) inside the jail, where the credential is
  // readable. Off by OpenCode's default today; a public seat turns them off
  // itself, so a default flip in a later patch release changes nothing.
  test('a public seat turns LSP and formatters off in its own config', async () => {
    await withTemp(async (root) => {
      let config = null;
      const spawn = makeSpawnImpl({
        onCall: (_cmd, _args, options) => {
          config = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
        },
      });
      await opencode.spawn('broker turn', await publicCtx(root, { providerKey: 'sk-own-key', _spawnImpl: spawn.impl,
        _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv] }));
      expect(config.lsp).toBe(false);
      expect(config.formatter).toBe(false);
    });
  });

  // Review fix (#3487): OpenCode's older tools compare paths as text and do not
  // follow symlinks, so a workspace link to the temp root would pass
  // external_directory. The read (and edit) rules deny the spawn root by name.
  test('read and edit deny every per-spawn commonly-opencode directory by name', async () => {
    await withTemp(async (root) => {
      let seen = null;
      const spawn = makeSpawnImpl({
        onCall: (_cmd, _args, options) => {
          const config = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
          seen = { permission: config.permission, credential: options.env.COMMONLY_TOKEN_FILE };
        },
      });
      await opencode.spawn('broker turn', await publicCtx(root, { providerKey: 'sk-own-key', _spawnImpl: spawn.impl,
        _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv] }));
      const pattern = '**/commonly-opencode-*/**';
      expect(seen.permission.read[pattern]).toBe('deny');
      expect(seen.permission.edit[pattern]).toBe('deny');
      // OpenCode's Wildcard.match turns `*` into `.*`; the rule must match the
      // credential as reached through a workspace symlink to the temp root.
      const asRegex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      const viaLink = join(root, 'workspace', 'tmp-link', relative(tmpdir(), seen.credential));
      expect(asRegex.test(seen.credential)).toBe(true);
      expect(asRegex.test(viaLink)).toBe(true);
    });
  });

  // F219 item 1: this adapter already refused it. Pinned beside the others.
  test('a public seat in a workspace that holds the temp folder is refused, and nothing is spawned', async () => {
    await withTemp(async (root) => {
      const ctx = await publicCtx(root);
      await mkdir(join(ctx.cwd, 'tmp'));
      const spawn = makeSpawnImpl();
      await expect(opencode.spawn('hello', { ...ctx, _tempRoot: join(ctx.cwd, 'tmp'), _spawnImpl: spawn.impl }))
        .rejects.toThrow(/refuse a workspace .* that contains the per-spawn credential directory/);
      expect(spawn.calls).toHaveLength(0);
    });
  });

  // Review fix (#3487): OpenCode treats the whole git worktree as inside the
  // project, so a workspace below a repo root that also holds the temp root
  // would let the tools reach the credential without external_directory.
  test('a public seat refuses when the workspace\'s git toplevel contains the spawn root', async () => {
    await withTemp(async (root) => {
      const repo = join(root, 'repo');
      await mkdir(join(repo, '.git'), { recursive: true });
      await mkdir(join(repo, 'tmp'), { recursive: true });
      const spawn = makeSpawnImpl();
      const ctx = await publicCtx(root, { cwd: join(repo, 'packages', 'app'), providerKey: 'sk-own-key',
        _tempRoot: join(repo, 'tmp'),
        _spawnImpl: spawn.impl, _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv] });
      await mkdir(ctx.cwd, { recursive: true });
      await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/git worktree.*credential/i);
      expect(spawn.calls).toHaveLength(0);
      // Reverse: the same layout without the .git marker runs.
      await rm(join(repo, '.git'), { recursive: true, force: true });
      await opencode.spawn('broker turn', ctx);
      expect(spawn.calls).toHaveLength(1);
    });
  });

  // CodeRabbit (#3487): a linked git worktree marks its root with a `.git`
  // FILE, not a directory; the same refusal holds. The fixture is a real linked
  // worktree: git answers `--show-toplevel` there, so the refusal is the
  // containment one, not "could not confirm" (a dangling gitdir fails on git
  // 2.56, CI #3487).
  test('a public seat refuses when a git worktree (.git file) root contains the spawn root', async () => {
    await withTemp(async (root) => {
      const main = join(root, 'main');
      const repo = join(root, 'wt');
      await mkdir(main, { recursive: true });
      const git = (cwd, ...args) => {
        const run = realSpawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], {
          cwd, encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
        });
        if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
      };
      git(main, 'init', '-q');
      git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
      git(main, 'worktree', 'add', '-q', repo);
      expect(statSync(join(repo, '.git')).isFile()).toBe(true);
      await mkdir(join(repo, 'tmp'), { recursive: true });
      const spawn = makeSpawnImpl();
      const ctx = await publicCtx(root, { cwd: join(repo, 'app'), providerKey: 'sk-own-key',
        _tempRoot: join(repo, 'tmp'),
        _spawnImpl: spawn.impl, _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv] });
      await mkdir(ctx.cwd, { recursive: true });
      await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/git worktree.*credential/i);
      expect(spawn.calls).toHaveLength(0);
    });
  });

  // CodeRabbit (#3487): a workspace symlink to the temp root (or anything
  // above the spawn root) is refused before the model runs; the read deny on
  // `commonly-opencode-*` is the backstop past the walk's bounds.
  test('a public seat refuses a workspace holding a symlink that reaches the spawn root', async () => {
    await withTemp(async (root) => {
      const tempRoot = join(root, 'temp-root');
      await mkdir(tempRoot, { recursive: true });
      const spawn = makeSpawnImpl();
      const ctx = await publicCtx(root, { providerKey: 'sk-own-key', _tempRoot: tempRoot,
        _spawnImpl: spawn.impl, _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv] });
      await mkdir(join(ctx.cwd, 'src', 'deep'), { recursive: true });
      await symlink(tempRoot, join(ctx.cwd, 'src', 'deep', 'cache'));
      await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/symlink.*credential/i);
      expect(spawn.calls).toHaveLength(0);
      // Reverse: a link elsewhere runs on a seat with no grant (a grant seat
      // refuses any link out of the workspace; see the chain tests below).
      await rm(join(ctx.cwd, 'src', 'deep', 'cache'));
      await mkdir(join(root, 'elsewhere'), { recursive: true });
      await symlink(join(root, 'elsewhere'), join(ctx.cwd, 'src', 'other'));
      ctx.environment = { ...ctx.environment, mcp: [] };
      await opencode.spawn('plain turn', ctx);
      expect(spawn.calls).toHaveLength(1);
    });
  });

  // CodeRabbit round 2 (#3487): the walk does not descend into node_modules
  // (a typical one would exhaust the entry bound on every spawn), but every
  // link AT its top level, or under an @scope there, is checked: one reaching
  // the spawn root, or one leading out of the workspace into a tree the walk
  // never read, is refused.
  test('a public seat checks the links at a node_modules top level', async () => {
    await withTemp(async (root) => {
      const tempRoot = join(root, 'temp-root');
      await mkdir(tempRoot, { recursive: true });
      const spawn = makeSpawnImpl();
      const ctx = await publicCtx(root, { providerKey: 'sk-own-key', _tempRoot: tempRoot,
        _spawnImpl: spawn.impl, _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv] });
      const modules = join(ctx.cwd, 'node_modules');
      await mkdir(join(modules, '@scope'), { recursive: true });

      await symlink(tempRoot, join(modules, 'pkg'));
      await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/symlink.*node_modules.*pkg.*credential/i);
      await rm(join(modules, 'pkg'));

      await mkdir(join(root, 'linked-elsewhere'), { recursive: true });
      await symlink(join(root, 'linked-elsewhere'), join(modules, '@scope', 'linked'));
      await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/symlink.*@scope.*linked.*outside the workspace/i);
      await rm(join(modules, '@scope', 'linked'));
      expect(spawn.calls).toHaveLength(0);

      // Reverse: a workspace package linked from inside the workspace runs, and
      // so does a deep link that stays inside it (round 4 refuses one that
      // leaves; see the dependency-walk tests below).
      await mkdir(join(ctx.cwd, 'packages', 'local'), { recursive: true });
      await symlink(join(ctx.cwd, 'packages', 'local'), join(modules, '@scope', 'local'));
      await mkdir(join(modules, 'real-pkg', 'dist'), { recursive: true });
      await symlink(join(ctx.cwd, 'packages', 'local'), join(modules, 'real-pkg', 'dist', 'deep-link'));
      await opencode.spawn('broker turn', ctx);
      expect(spawn.calls).toHaveLength(1);
    });
  });

  // A pnpm package workspace links its node_modules into the repo root's
  // store, above the package; the git worktree is the boundary, since OpenCode
  // counts the whole worktree as inside the project anyway.
  test('a node_modules link into the same git worktree is not "outside the workspace"', async () => {
    await withTemp(async (root) => {
      const repo = join(root, 'repo');
      await mkdir(join(repo, '.git'), { recursive: true });
      await mkdir(join(repo, 'node_modules', '.pnpm', 'dep@1.0.0'), { recursive: true });
      const spawn = makeSpawnImpl();
      const ctx = await publicCtx(root, { cwd: join(repo, 'packages', 'app'), providerKey: 'sk-own-key',
        _tempRoot: join(root, 'temp-root'),
        _spawnImpl: spawn.impl, _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv] });
      await mkdir(join(root, 'temp-root'), { recursive: true });
      await mkdir(join(ctx.cwd, 'node_modules'), { recursive: true });
      await symlink(join(repo, 'node_modules', '.pnpm', 'dep@1.0.0'), join(ctx.cwd, 'node_modules', 'dep'));
      await opencode.spawn('broker turn', ctx);
      expect(spawn.calls).toHaveLength(1);
    });
  });

  // CodeRabbit round 2 (#3487): a walk that stops at its bound has not proven
  // the workspace clean. A seat carrying the grant broker refuses; a seat with
  // no broker entry has no grant to protect and runs.
  test('a walk that reaches its entry bound refuses a broker seat and lets a seat without one run', async () => {
    await withTemp(async (root) => {
      const spawn = makeSpawnImpl();
      const ctx = await publicCtx(root, { providerKey: 'sk-own-key', _tempRoot: join(root, 'temp-root'),
        _symlinkWalkBounds: { maxDepth: 32, maxEntries: 5 },
        _spawnImpl: spawn.impl, _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv] });
      await mkdir(join(root, 'temp-root'), { recursive: true });
      await Promise.all([1, 2, 3, 4, 5, 6].map((n) => writeFile(join(ctx.cwd, `f${n}.txt`), 'x')));
      await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/could not finish checking.*grant/i);
      expect(spawn.calls).toHaveLength(0);

      // Reverse: the same workspace, no broker entry, runs.
      ctx.environment = { ...ctx.environment, mcp: [] };
      await opencode.spawn('plain turn', ctx);
      expect(spawn.calls).toHaveLength(1);
    });
  });

  test('a walk that reaches its depth bound refuses a broker seat, and one just inside it runs', async () => {
    await withTemp(async (root) => {
      const spawn = makeSpawnImpl();
      const ctx = await publicCtx(root, { providerKey: 'sk-own-key', _tempRoot: join(root, 'temp-root'),
        _symlinkWalkBounds: { maxDepth: 3, maxEntries: 20000 },
        _spawnImpl: spawn.impl, _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv] });
      await mkdir(join(root, 'temp-root'), { recursive: true });
      await mkdir(join(ctx.cwd, 'a', 'b', 'c'), { recursive: true });
      await opencode.spawn('broker turn', ctx);
      expect(spawn.calls).toHaveLength(1);
      await mkdir(join(ctx.cwd, 'a', 'b', 'c', 'd'), { recursive: true });
      await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/could not finish checking.*grant/i);
      expect(spawn.calls).toHaveLength(1);
    });
  });

  test('reverse: the same workspace check lets an ordinary public workspace through', async () => {
    await withTemp(async (root) => {
      const spawn = makeSpawnImpl();
      await opencode.spawn('broker turn', await publicCtx(root, { providerKey: 'sk-own-key', _spawnImpl: spawn.impl,
        _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv] }));
      expect(spawn.calls).toHaveLength(1);
    });
  });

  // CodeRabbit round 3 (#3487): the walk cannot prove a whole node_modules tree
  // clean, so the credential stops existing once OpenCode no longer needs it.
  // OpenCode 1.19.4 expands {file:} once, over the config text at load
  // (ConfigPaths `IT`, called from Config.state); every MCP connect, the first
  // and any later one, takes headers from that cached config; and `run`
  // writes `step_start` only after tools are resolved and every MCP server is
  // connected. So the adapter deletes the file on the first step_start, before
  // the model can call a tool.
  const stagedSpawn = (stages) => {
    const calls = [];
    const impl = (cmd, args, options) => {
      calls.push({ cmd, args, options });
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = jest.fn();
      setTimeout(() => {
        const credential = options.env.COMMONLY_TOKEN_FILE;
        stages.atSpawn = existsSync(credential);
        proc.stdout.emit('data', Buffer.from('a line that is not an event\n'));
        stages.beforeStep = existsSync(credential);
        proc.stdout.emit('data', Buffer.from(event('step_start', 'ses_del', { type: 'step-start' })));
        stages.afterStep = existsSync(credential);
        proc.stdout.emit('data', Buffer.from(event('text', 'ses_del', { type: 'text', text: 'done' })));
        proc.emit('close', 0);
      }, 0);
      return proc;
    };
    return { impl, calls };
  };

  test('a seat that delivers the credential to a remote MCP deletes it at the first step_start', async () => {
    await withTemp(async (root) => {
      const stages = {};
      const spawn = stagedSpawn(stages);
      const result = await opencode.spawn('broker turn', await publicCtx(root, { providerKey: 'sk-own-key',
        _spawnImpl: spawn.impl, _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv] }));
      expect(spawn.calls).toHaveLength(1);
      expect(stages).toEqual({ atSpawn: true, beforeStep: true, afterStep: false });
      // The turn itself is unaffected.
      expect(result.text).toBe('done');
    });
  });

  test('reverse: a public seat with no remote bearer keeps its credential for the whole turn', async () => {
    await withTemp(async (root) => {
      const stages = {};
      const spawn = stagedSpawn(stages);
      const ctx = await publicCtx(root, { providerKey: 'sk-own-key',
        _spawnImpl: spawn.impl, _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv] });
      ctx.environment = { ...ctx.environment, mcp: [] };
      await opencode.spawn('plain turn', ctx);
      expect(stages).toEqual({ atSpawn: true, beforeStep: true, afterStep: true });
    });
  });

  // CodeRabbit round 3 (#3487): buildMcpConfig hands `Bearer {file:...}` to any
  // http entry whose Authorization is exactly `Bearer ${COMMONLY_AGENT_TOKEN}`,
  // whatever its URL, so whether this spawn carries the credential to a remote
  // server is what buildMcpConfig wrote, not what isOurGrantBroker recognises.
  const OFF_ORIGIN_BEARER = {
    name: 'side-mcp', transport: 'http',
    url: 'https://elsewhere.example.test/mcp',
    headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
  };

  test('buildMcpConfig reports each remote entry it gave the credential file', () => {
    const bearerFileServers = [];
    const config = buildMcpConfig([OFF_ORIGIN_BEARER, {
      name: 'no-auth', transport: 'http', url: 'https://elsewhere.example.test/plain',
    }], {
      runtimeToken: TOKEN, instanceUrl: 'https://api.example.test',
      credentialFile: '/spawn/agent/token', bearerFileServers,
    });
    expect(config['side-mcp'].headers.Authorization).toBe('Bearer {file:/spawn/agent/token}');
    expect(bearerFileServers).toEqual(['side-mcp']);
  });

  test('a walk that hits its bound refuses an entry isOurGrantBroker rejects but that still gets the credential', async () => {
    const { isOurGrantBroker } = await import('../src/lib/grant-broker-guard.js');
    expect(isOurGrantBroker(OFF_ORIGIN_BEARER, { instanceUrl: 'https://api.example.test' })).toBe(false);
    await withTemp(async (root) => {
      const spawn = makeSpawnImpl();
      const ctx = await publicCtx(root, { providerKey: 'sk-own-key', _tempRoot: join(root, 'temp-root'),
        _symlinkWalkBounds: { maxDepth: 32, maxEntries: 5 },
        _spawnImpl: spawn.impl, _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv] });
      ctx.environment = { ...ctx.environment, mcp: [OFF_ORIGIN_BEARER] };
      await mkdir(join(root, 'temp-root'), { recursive: true });
      await Promise.all([1, 2, 3, 4, 5, 6].map((n) => writeFile(join(ctx.cwd, `f${n}.txt`), 'x')));
      await expect(opencode.spawn('side turn', ctx)).rejects.toThrow(/could not finish checking.*grant/i);
      expect(spawn.calls).toHaveLength(0);

      // Reverse: the same entry with no credential header gets no file and runs.
      ctx.environment = { ...ctx.environment, mcp: [{ ...OFF_ORIGIN_BEARER, headers: {} }] };
      await opencode.spawn('side turn', ctx);
      expect(spawn.calls).toHaveLength(1);
    });
  });

  // CodeRabbit round 4 (#3487): a parent-side delete on step_start is not a
  // cross-process boundary, so a seat that hands the credential to a remote
  // server first proves no link anywhere inside a node_modules tree reaches the
  // spawn root. Links only: nothing is followed, and a regular file costs no stat.
  describe('the node_modules link walk on a grant-bearing spawn', () => {
    const brokerCtx = async (root, over = {}) => {
      const tempRoot = join(root, 'temp-root');
      await mkdir(tempRoot, { recursive: true });
      const spawn = makeSpawnImpl();
      const ctx = await publicCtx(root, { providerKey: 'sk-own-key', _tempRoot: tempRoot,
        _spawnImpl: spawn.impl, _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv], ...over });
      return { ctx, spawn, tempRoot, modules: join(ctx.cwd, 'node_modules') };
    };

    test('a deep link in an installed package to an ancestor of the spawn root is refused', async () => {
      await withTemp(async (root) => {
        const { ctx, spawn, tempRoot, modules } = await brokerCtx(root);
        await mkdir(join(modules, 'real-pkg', 'dist'), { recursive: true });
        await symlink(tempRoot, join(modules, 'real-pkg', 'dist', 'x'));
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/symlink.*real-pkg.*dist.*x.*credential/i);
        expect(spawn.calls).toHaveLength(0);
        // Reverse: the same link to a directory inside the workspace runs.
        await rm(join(modules, 'real-pkg', 'dist', 'x'));
        await mkdir(join(ctx.cwd, 'src'), { recursive: true });
        await symlink(join(ctx.cwd, 'src'), join(modules, 'real-pkg', 'dist', 'x'));
        await opencode.spawn('broker turn', ctx);
        expect(spawn.calls).toHaveLength(1);
      });
    });

    // A path argument resolves a link chain in the OS: node_modules/x/y ->
    // /outside/dir/y -> /tmp. The walk never reads /outside, so a deep link
    // that leaves the workspace is refused, the same rule as at the top level.
    test('a deep link out of the workspace is refused, so a chain through it cannot reach the spawn root', async () => {
      await withTemp(async (root) => {
        const { ctx, spawn, tempRoot, modules } = await brokerCtx(root);
        const outside = join(root, 'outside', 'dir');
        await mkdir(outside, { recursive: true });
        await symlink(tempRoot, join(outside, 'y'));
        await mkdir(join(modules, 'x'), { recursive: true });
        await symlink(outside, join(modules, 'x', 'y'));
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/symlink.*node_modules.*x.*y.*outside the workspace/i);
        // Without the chain, a deep link to any directory outside is refused too:
        // the walk cannot vouch for a tree it never read.
        await rm(join(outside, 'y'));
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/symlink.*node_modules.*x.*y.*outside the workspace/i);
        expect(spawn.calls).toHaveLength(0);
        // Reverse: a seat with no remote bearer is not held to it.
        ctx.environment = { ...ctx.environment, mcp: [] };
        await opencode.spawn('plain turn', ctx);
        expect(spawn.calls).toHaveLength(1);
      });
    });

    // The same chain through a link outside node_modules, or through a
    // node_modules that is itself a link (a worktree sharing another's install):
    // on a grant seat every workspace link is held to the boundary.
    test('a grant seat refuses any workspace link out, node_modules itself included', async () => {
      await withTemp(async (root) => {
        const { ctx, spawn, tempRoot } = await brokerCtx(root);
        const outside = join(root, 'outside', 'dir');
        await mkdir(join(outside, 'pkg'), { recursive: true });
        await symlink(tempRoot, join(outside, 'y'));
        await mkdir(join(ctx.cwd, 'src'), { recursive: true });
        await symlink(outside, join(ctx.cwd, 'src', 'vendor'));
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(
          /symlink \(.*src\/vendor\).*outside the workspace.*move the seat to a workspace without links that leave it, or remove the link/i,
        );
        await rm(join(ctx.cwd, 'src', 'vendor'));
        await symlink(outside, join(ctx.cwd, 'node_modules'));
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/symlink.*node_modules.*outside the workspace/i);
        expect(spawn.calls).toHaveLength(0);
        // Reverse: a link that stays in the workspace runs.
        await rm(join(ctx.cwd, 'node_modules'));
        await symlink(join(ctx.cwd, 'src'), join(ctx.cwd, 'src-alias'));
        await opencode.spawn('broker turn', ctx);
        expect(spawn.calls).toHaveLength(1);
      });
    });

    test('a pnpm-style layout whose links stay inside the workspace runs', async () => {
      await withTemp(async (root) => {
        const { ctx, spawn, modules } = await brokerCtx(root);
        const store = join(modules, '.pnpm', 'dep@1.0.0', 'node_modules');
        await mkdir(join(store, 'dep', 'dist'), { recursive: true });
        await mkdir(join(store, 'peer'), { recursive: true });
        await symlink(join(store, 'dep'), join(modules, 'dep'));
        await symlink(join(store, 'peer'), join(store, 'dep', 'node_modules-peer'));
        await mkdir(join(modules, '.bin'), { recursive: true });
        await symlink(join(store, 'dep', 'dist'), join(modules, '.bin', 'dep'));
        await mkdir(join(ctx.cwd, 'packages', 'app'), { recursive: true });
        await symlink(join(ctx.cwd, 'packages', 'app'), join(store, 'app'));
        await opencode.spawn('broker turn', ctx);
        expect(spawn.calls).toHaveLength(1);
        // Reverse: one store link pointed out of the workspace is refused.
        await mkdir(join(root, 'global-store', 'peer'), { recursive: true });
        await rm(join(store, 'dep', 'node_modules-peer'));
        await symlink(join(root, 'global-store', 'peer'), join(store, 'dep', 'node_modules-peer'));
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/symlink.*\.pnpm.*node_modules-peer.*outside the workspace/i);
        expect(spawn.calls).toHaveLength(1);
      });
    });

    test('a nested link under a scoped package, and one in a nested node_modules, are refused', async () => {
      await withTemp(async (root) => {
        const { ctx, spawn, tempRoot, modules } = await brokerCtx(root);
        const scoped = join(modules, '@scope', 'pkg', 'lib', 'deep');
        await mkdir(scoped, { recursive: true });
        await symlink(root, join(scoped, 'up'));
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/symlink.*@scope.*pkg.*lib.*deep.*up/i);
        await rm(join(scoped, 'up'));
        const nested = join(modules, 'a', 'node_modules', 'b', 'build');
        await mkdir(nested, { recursive: true });
        await symlink(tempRoot, join(nested, 'cache'));
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/symlink.*node_modules.*b.*build.*cache/i);
        expect(spawn.calls).toHaveLength(0);
        // Reverse: a dangling link is no route anywhere and runs.
        await rm(join(nested, 'cache'));
        await symlink(join(root, 'gone'), join(nested, 'cache'));
        await opencode.spawn('broker turn', ctx);
        expect(spawn.calls).toHaveLength(1);
      });
    });

    test('a deep node_modules link INTO a spawn root is found by the walk', async () => {
      await withTemp(async (root) => {
        const workspace = join(root, 'workspace');
        const spawnRoot = join(root, 'temp-root', 'commonly-opencode-abc');
        await mkdir(join(spawnRoot, 'agent-1'), { recursive: true });
        await mkdir(join(workspace, 'node_modules', 'real-pkg', 'dist'), { recursive: true });
        await symlink(join(spawnRoot, 'agent-1'), join(workspace, 'node_modules', 'real-pkg', 'dist', 'x'));
        expect(scanWorkspaceLinks(workspace, spawnRoot, { deepDependencies: true })).toEqual({
          link: join(workspace, 'node_modules', 'real-pkg', 'dist', 'x'), reason: 'reaches_spawn_root',
        });
        // Reverse: without the deep walk (a no-grant spawn) it is not looked at.
        expect(scanWorkspaceLinks(workspace, spawnRoot, { deepDependencies: false })).toBeNull();
      });
    });

    test('a dependency walk that runs out of entries or depth refuses the grant seat', async () => {
      await withTemp(async (root) => {
        const { ctx, spawn, modules } = await brokerCtx(root, {
          _dependencyWalkBounds: { maxDepth: 64, maxEntries: 5 },
        });
        await mkdir(join(modules, 'pkg', 'dist'), { recursive: true });
        await Promise.all([1, 2, 3, 4, 5, 6].map((n) => writeFile(join(modules, 'pkg', 'dist', `f${n}.js`), 'x')));
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/could not finish checking.*node_modules.*entry bound \(5/i);
        ctx._dependencyWalkBounds = { maxDepth: 2, maxEntries: 200000 };
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/could not finish checking.*node_modules.*depth bound \(2/i);
        expect(spawn.calls).toHaveLength(0);
        // Reverse: the same tree inside both bounds runs.
        ctx._dependencyWalkBounds = { maxDepth: 3, maxEntries: 200000 };
        await opencode.spawn('broker turn', ctx);
        expect(spawn.calls).toHaveLength(1);
      });
    });

    test('a spawn with no remote bearer skips the dependency walk, bad link and all', async () => {
      await withTemp(async (root) => {
        const { ctx, spawn, tempRoot, modules } = await brokerCtx(root, {
          _dependencyWalkBounds: { maxDepth: 1, maxEntries: 1 },
        });
        ctx.environment = { ...ctx.environment, mcp: [] };
        await mkdir(join(modules, 'real-pkg', 'dist'), { recursive: true });
        await symlink(tempRoot, join(modules, 'real-pkg', 'dist', 'x'));
        await opencode.spawn('plain turn', ctx);
        expect(spawn.calls).toHaveLength(1);
      });
    });
  });

  // CodeRabbit round 4 (#3487): a credential that could not be deleted is still
  // readable, so the turn ends instead of running on with it.
  test('a failed credential delete kills the child and fails the turn', async () => {
    await withTemp(async (root) => {
      const stages = {};
      const spawn = stagedSpawn(stages);
      let child = null;
      const ctx = await publicCtx(root, { providerKey: 'sk-own-key',
        _spawnImpl: (...a) => { child = spawn.impl(...a); return child; },
        _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv],
        _rmSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } });
      await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/could not delete.*credential.*EACCES/i);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      // Reverse: a delete that succeeds lets the turn finish.
      ctx._rmSync = () => {};
      const result = await opencode.spawn('broker turn', ctx);
      expect(result.text).toBe('done');
      expect(child.kill).not.toHaveBeenCalled();
    });
  });

  // Opus delta review, round 6 (#3487).
  describe('the grant walk: unreadable directories, the whole worktree, case, unresolvable links', () => {
    const grantCtx = async (root, over = {}) => {
      const tempRoot = join(root, 'temp-root');
      await mkdir(tempRoot, { recursive: true });
      const spawn = makeSpawnImpl();
      const ctx = await publicCtx(root, { providerKey: 'sk-own-key', _tempRoot: tempRoot,
        _spawnImpl: spawn.impl, _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv], ...over });
      return { ctx, spawn, tempRoot };
    };
    const noGrant = (ctx) => { ctx.environment = { ...ctx.environment, mcp: [] }; };

    // HIGH 1: a directory the walk cannot list (0111) is still traversable by
    // the OS, so a link inside it is invisible to the walk but not to grep.
    test('an unlistable directory refuses a grant seat, in node_modules and in the workspace', async () => {
      await withTemp(async (root) => {
        const { ctx, spawn, tempRoot } = await grantCtx(root);
        const hidden = join(ctx.cwd, 'node_modules', 'bad', 'h');
        const locked = join(ctx.cwd, 'src', 'locked');
        await mkdir(hidden, { recursive: true });
        await mkdir(locked, { recursive: true });
        await symlink(tempRoot, join(hidden, 'y'));
        try {
          await chmod(hidden, 0o111);
          await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/could not list.*node_modules.*bad.*h.*EACCES/i);
          await chmod(hidden, 0o755);
          await rm(join(hidden, 'y'));
          await symlink(tempRoot, join(locked, 'y'));
          await chmod(locked, 0o111);
          await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/could not list.*src.*locked.*EACCES/i);
          expect(spawn.calls).toHaveLength(0);
          // Reverse: a seat with no grant is not held to it.
          noGrant(ctx);
          await opencode.spawn('plain turn', ctx);
          expect(spawn.calls).toHaveLength(1);
        } finally {
          await chmod(hidden, 0o755).catch(() => {});
          await chmod(locked, 0o755).catch(() => {});
        }
      });
    });

    // HIGH 2: OpenCode's tools reach the whole git worktree, so a grant walk
    // starts at the worktree root: a sibling package's node_modules counts.
    test('a monorepo subfolder workspace refuses a link in a sibling package\'s node_modules', async () => {
      await withTemp(async (root) => {
        const repo = join(root, 'repo');
        await mkdir(join(repo, '.git'), { recursive: true });
        const { ctx, spawn, tempRoot } = await grantCtx(root, { cwd: join(repo, 'packages', 'app') });
        await mkdir(ctx.cwd, { recursive: true });
        await mkdir(join(repo, 'other', 'node_modules', 'evil', 'dist'), { recursive: true });
        await symlink(tempRoot, join(repo, 'other', 'node_modules', 'evil', 'dist', 'x'));
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/symlink.*other.*node_modules.*evil.*dist.*x.*credential/i);
        expect(spawn.calls).toHaveLength(0);
        // Reverse: a seat with no grant walks only its workspace.
        noGrant(ctx);
        await opencode.spawn('plain turn', ctx);
        expect(spawn.calls).toHaveLength(1);
      });
    });

    // CodeRabbit 4479743278: a link inside the worktree but outside cwd, into a
    // pnpm store whose tree holds an escaping link.
    test('a workspace dep linked into the repo-root pnpm store, whose tree reaches the spawn parent, is refused', async () => {
      await withTemp(async (root) => {
        const repo = join(root, 'repo');
        await mkdir(join(repo, '.git'), { recursive: true });
        const { ctx, spawn, tempRoot } = await grantCtx(root, { cwd: join(repo, 'packages', 'app') });
        const store = join(repo, 'node_modules', '.pnpm', 'dep');
        await mkdir(join(store, 'dist'), { recursive: true });
        await mkdir(join(ctx.cwd, 'node_modules'), { recursive: true });
        await symlink(store, join(ctx.cwd, 'node_modules', 'dep'));
        await symlink(tempRoot, join(store, 'dist', 'cache'));
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/symlink.*node_modules.*\.pnpm.*dep.*dist.*cache.*credential/i);
        expect(spawn.calls).toHaveLength(0);
        // Reverse: the same layout with the store's link removed runs.
        await rm(join(store, 'dist', 'cache'));
        await opencode.spawn('broker turn', ctx);
        expect(spawn.calls).toHaveLength(1);
      });
    });

    test('a link under .git is refused on a grant seat', async () => {
      await withTemp(async (root) => {
        const repo = join(root, 'repo');
        await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
        const { ctx, spawn, tempRoot } = await grantCtx(root, { cwd: join(repo, 'app') });
        await mkdir(ctx.cwd, { recursive: true });
        await symlink(tempRoot, join(repo, '.git', 'x'));
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/symlink.*\.git.*x.*credential/i);
        await rm(join(repo, '.git', 'x'));
        await symlink(tempRoot, join(repo, '.git', 'hooks', 'pre-commit'));
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/symlink.*\.git.*hooks.*pre-commit.*credential/i);
        expect(spawn.calls).toHaveLength(0);
        // Reverse: a plain .git with no links runs.
        await rm(join(repo, '.git', 'hooks', 'pre-commit'));
        await opencode.spawn('broker turn', ctx);
        expect(spawn.calls).toHaveLength(1);
      });
    });

    // MEDIUM: realpath must canonicalise case on a case-insensitive volume, or
    // a link spelled /PRIVATE/... passes reaches_spawn_root.
    test('a link spelled in another case still reaches the spawn root, deep walk off', async () => {
      await withTemp(async (root) => {
        const tempRoot = realpathSync(await mkdir(join(root, 'temp-root'), { recursive: true }) || join(root, 'temp-root'));
        const upper = tempRoot.toUpperCase();
        if (!existsSync(upper)) return; // a case-sensitive volume: nothing to canonicalise
        const workspace = join(root, 'workspace');
        const spawnRoot = join(tempRoot, 'commonly-opencode-abc');
        await mkdir(spawnRoot, { recursive: true });
        await mkdir(join(workspace, 'src'), { recursive: true });
        await symlink(upper, join(workspace, 'src', 'up'));
        expect(scanWorkspaceLinks(workspace, spawnRoot, { deepDependencies: false })).toEqual({
          link: join(workspace, 'src', 'up'), reason: 'reaches_spawn_root',
        });
        // Reverse: an unrelated directory in another case is not a hit.
        await rm(join(workspace, 'src', 'up'));
        await mkdir(join(root, 'elsewhere'), { recursive: true });
        await symlink(realpathSync(join(root, 'elsewhere')).toUpperCase(), join(workspace, 'src', 'up'));
        expect(scanWorkspaceLinks(workspace, spawnRoot, { deepDependencies: false })).toBeNull();
      });
    });

    // LOW: a link realpath cannot resolve for a reason other than a missing
    // target (a loop) is not proof of no route; a grant seat refuses.
    test('an unresolvable link (a loop) refuses a grant seat; a dangling one does not', async () => {
      await withTemp(async (root) => {
        const { ctx, spawn } = await grantCtx(root);
        await mkdir(join(ctx.cwd, 'src'), { recursive: true });
        await symlink(join(ctx.cwd, 'src', 'b'), join(ctx.cwd, 'src', 'a'));
        await symlink(join(ctx.cwd, 'src', 'a'), join(ctx.cwd, 'src', 'b'));
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/could not resolve.*src.*(a|b).*ELOOP/i);
        expect(spawn.calls).toHaveLength(0);
        // Reverse: a dangling link still runs.
        await rm(join(ctx.cwd, 'src', 'a'));
        await rm(join(ctx.cwd, 'src', 'b'));
        await symlink(join(root, 'gone'), join(ctx.cwd, 'src', 'a'));
        await opencode.spawn('broker turn', ctx);
        expect(spawn.calls).toHaveLength(1);
      });
    });
  });

  // Opus delta review, round 7 (#3487): OpenCode 1.19.4 takes its project
  // worktree from `git rev-parse --show-toplevel`, run in the folder holding
  // .git (GitV2 `Git.repo.discover`), and its tools reach everything under it.
  // `core.worktree` widens that past the folder the walk starts from.
  describe('the worktree git reports, and edits to .git', () => {
    const FORCED_GIT_ENV = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
    };
    const git = (cwd, ...args) => {
      const run = realSpawnSync('git', args, {
        cwd, encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' },
      });
      if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
      return run.stdout.trim();
    };
    const repoCtx = async (root, cwd, over = {}) => {
      const tempRoot = join(root, 'temp-root');
      await mkdir(tempRoot, { recursive: true });
      await mkdir(cwd, { recursive: true });
      const spawn = makeSpawnImpl();
      const ctx = await publicCtx(root, { cwd, providerKey: 'sk-own-key', _tempRoot: tempRoot,
        _spawnImpl: spawn.impl, _wrapArgvWithSeatbelt: (argv) => ['/usr/bin/sandbox-exec', ...argv], ...over });
      return { ctx, spawn, tempRoot };
    };

    test('a repo whose core.worktree is the spawn root\'s parent is refused, grant or not', async () => {
      await withTemp(async (root) => {
        const repo = join(root, 'repo');
        await mkdir(repo, { recursive: true });
        git(repo, 'init', '-q');
        const { ctx, spawn, tempRoot } = await repoCtx(root, join(repo, 'app'));
        git(repo, 'config', 'core.worktree', tempRoot);
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/git reports the worktree.*temp-root.*not.*repo.*core\.worktree/i);
        ctx.environment = { ...ctx.environment, mcp: [] };
        await expect(opencode.spawn('plain turn', ctx)).rejects.toThrow(/git reports the worktree.*temp-root/i);
        expect(spawn.calls).toHaveLength(0);
        // Reverse: the same repo without the setting runs.
        git(repo, 'config', '--unset', 'core.worktree');
        await opencode.spawn('plain turn', ctx);
        expect(spawn.calls).toHaveLength(1);
      });
    });

    test('a normal repo and a linked worktree (git worktree add) run on a grant seat', async () => {
      await withTemp(async (root) => {
        const repo = join(root, 'main');
        await mkdir(repo, { recursive: true });
        git(repo, 'init', '-q');
        await writeFile(join(repo, 'README'), 'x');
        git(repo, 'add', 'README');
        git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'init');
        const { ctx, spawn } = await repoCtx(root, join(repo, 'app'));
        await opencode.spawn('broker turn', ctx);
        git(repo, 'worktree', 'add', '-q', join(root, 'linked'));
        await mkdir(join(root, 'linked', 'app'), { recursive: true });
        ctx.cwd = join(root, 'linked', 'app');
        await opencode.spawn('broker turn', ctx);
        expect(spawn.calls).toHaveLength(2);
      });
    });

    // Round 8 (#3487): a git that cannot answer refuses every public seat,
    // grant or not; only "not a git repository" means no worktree.
    test('a public seat refuses when git is missing or fails in a repo, with or without a grant', async () => {
      await withTemp(async (root) => {
        const repo = join(root, 'repo');
        await mkdir(repo, { recursive: true });
        git(repo, 'init', '-q');
        await mkdir(join(root, 'empty-bin'), { recursive: true });
        await mkdir(join(root, 'failing-bin'), { recursive: true });
        await writeFile(join(root, 'failing-bin', 'git'), '#!/bin/sh\necho "fatal: boom" >&2\nexit 2\n');
        await chmod(join(root, 'failing-bin', 'git'), 0o755);
        const { ctx, spawn } = await repoCtx(root, join(repo, 'app'));
        const pathEnv = ctx.env.PATH;
        ctx.env = { ...ctx.env, PATH: join(root, 'empty-bin') };
        await expect(opencode.spawn('broker turn', ctx)).rejects.toThrow(/could not confirm the git worktree.*ENOENT/i);
        ctx.environment = { ...ctx.environment, mcp: [] };
        await expect(opencode.spawn('plain turn', ctx)).rejects.toThrow(/could not confirm the git worktree.*ENOENT/i);
        ctx.env = { ...ctx.env, PATH: `${join(root, 'failing-bin')}:${pathEnv}` };
        await expect(opencode.spawn('plain turn', ctx)).rejects.toThrow(/could not confirm the git worktree.*exit 2: fatal: boom/i);
        expect(spawn.calls).toHaveLength(0);
        // Reverse: a folder git says is no repository (an empty .git) runs.
        const bare = join(root, 'not-a-repo');
        await mkdir(join(bare, '.git'), { recursive: true });
        await mkdir(join(bare, 'app'), { recursive: true });
        ctx.env = { ...ctx.env, PATH: pathEnv };
        ctx.cwd = join(bare, 'app');
        await opencode.spawn('plain turn', ctx);
        expect(spawn.calls).toHaveLength(1);
      });
    });

    test('git config redirects in the launcher env never reach a public seat or its git check', async () => {
      await withTemp(async (root) => {
        const repo = join(root, 'repo');
        await mkdir(repo, { recursive: true });
        git(repo, 'init', '-q');
        const { ctx, spawn, tempRoot } = await repoCtx(root, join(repo, 'app'));
        const other = join(root, 'other.git');
        await mkdir(other, { recursive: true });
        git(other, 'init', '-q', '--bare');
        // Redirects that, if honoured, would name the spawn root's parent.
        ctx.env = {
          ...ctx.env,
          GIT_DIR: other, GIT_WORK_TREE: tempRoot,
          GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: tempRoot,
          GIT_CONFIG_GLOBAL: join(root, 'nope'),
        };
        await opencode.spawn('broker turn', ctx);
        expect(spawn.calls).toHaveLength(1);
        const childEnv = spawn.calls[0].options.env;
        // Nothing from the launcher; only the adapter's own forced keys.
        expect(Object.fromEntries(Object.entries(childEnv).filter(([key]) => key.startsWith('GIT_')))).toEqual(FORCED_GIT_ENV);
      });
    });

    test('a public seat denies edits to .git, its config and a linked worktree\'s .git file', () => {
      const permission = publicPermissions('workspace', []);
      const denies = Object.entries(permission.edit).filter(([, action]) => action === 'deny').map(([pattern]) => pattern);
      expect(denies).toEqual(expect.arrayContaining(['.git', '.git/**', '**/.git', '**/.git/**']));
      // OpenCode's Wildcard.match turns `*` into `.*`; the last matching rule wins.
      const matches = (pattern, path) => new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
      ).test(path);
      const action = (path) => Object.entries(permission.edit)
        .filter(([pattern]) => matches(pattern, path)).pop()?.[1];
      for (const path of ['.git/config', '/ws/.git/config', '/ws/pkg/.git/hooks/pre-commit', '.git', '/ws/.git']) {
        expect(action(path)).toBe('deny');
      }
      // Reverse: an ordinary source file, and names that merely start with .git, stay editable.
      expect(action('/ws/src/index.js')).toBe('allow');
      expect(action('/ws/.github/workflows/ci.yml')).toBe('allow');
      expect(action('/ws/.gitignore')).toBe('allow');
    });

    // Round 8 (#3487): OpenCode's permission match is case-sensitive and APFS
    // is not, so `.GIT/config` passes the `.git` edit deny. Env config outranks
    // repo config however the path is spelled, so a public seat's git runs no
    // fsmonitor and no hook.
    test('a public seat\'s git env forces fsmonitor off and hooks away, whatever the repo config says', async () => {
      await withTemp(async (root) => {
        const repo = join(root, 'repo');
        await mkdir(repo, { recursive: true });
        git(repo, 'init', '-q');
        const marker = join(root, 'fsmonitor-ran');
        const hookMarker = join(root, 'hook-ran');
        await writeFile(join(root, 'fsmon.sh'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
        await chmod(join(root, 'fsmon.sh'), 0o755);
        await writeFile(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch '${hookMarker}'\n`);
        await chmod(join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
        // Written through the case-folded spelling the deny misses, where the
        // volume folds case (APFS); a case-sensitive one (Linux CI) has no
        // `.GIT`, so the write goes through `.git` and the env still has to win.
        const probe = join(root, 'case-probe');
        await writeFile(probe, '');
        const foldsCase = existsSync(join(root, 'CASE-PROBE'));
        const config = join(repo, foldsCase ? '.GIT' : '.git', 'config');
        await writeFile(config, `${readFileSync(config, 'utf8')}[core]\n\tfsmonitor = ${join(root, 'fsmon.sh')}\n`);
        expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).toContain(join(root, 'fsmon.sh'));
        const { ctx, spawn } = await repoCtx(root, join(repo, 'app'));
        ctx.environment = { ...ctx.environment, mcp: [] };
        await opencode.spawn('plain turn', ctx);
        const childEnv = spawn.calls[0].options.env;
        expect(Object.fromEntries(Object.entries(childEnv).filter(([key]) => key.startsWith('GIT_')))).toEqual(FORCED_GIT_ENV);
        const run = (env, ...args) => realSpawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], {
          cwd: repo, encoding: 'utf8', env: { ...env, HOME: root },
        });
        run(childEnv, 'status');
        run(childEnv, 'commit', '-q', '--allow-empty', '-m', 'x');
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(hookMarker)).toBe(false);
        // Reverse: the same env without the forced keys runs both.
        const unforced = Object.fromEntries(Object.entries(childEnv).filter(([key]) => !key.startsWith('GIT_')));
        run(unforced, 'status');
        run(unforced, 'commit', '-q', '--allow-empty', '-m', 'y');
        expect(existsSync(marker)).toBe(true);
        expect(existsSync(hookMarker)).toBe(true);
      });
    });
  });
});

// F197: a public seat's writable workspace is the scratch folder the CLI made,
// so the profile pins it. A link at that path refuses the turn before spawn.
test('a public seat whose writable workspace is a link is refused, and nothing is spawned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-f197-'));
  try {
    const workspace = join(root, 'workspace');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, workspace);
    const keyFile = join(root, 'provider-key');
    await writeFile(keyFile, 'provider-secret', { mode: 0o600 });
    const spawn = makeSpawnImpl();
    const error = await opencode.spawn('turn', {
      cwd: workspace,
      env: { PATH: process.env.PATH },
      environment: {
        model: 'gpt-5.4',
        sandbox: { trust: 'public', mode: 'workspace' },
        provider: { id: 'local', baseURL: 'https://llm.example.test/v1', keyFile },
      },
      agentName: 'public-agent',
      _opencodeHomeRoot: join(root, 'opencode-state'),
      _binaryPath: '/usr/local/bin/opencode',
      _platform: 'darwin',
      _spawnImpl: spawn.impl,
      _wrapArgvWithSeatbelt: (argv, options) => { buildSeatbeltProfile(options); return argv; },
    }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/its writable workspace/);
    expect(error.message).toContain(workspace);
    expect(spawn.calls).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

