import { EventEmitter } from 'node:events';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';
import goose, {
  PUBLIC_GOOSE_TOOLS, TESTED_GOOSE_VERSIONS, assertSandboxSupported, bridgedGooseExtension, extensionArgs, readGooseStream,
} from '../src/lib/adapters/goose.js';
import {
  PUBLIC_ONLY_WITHHELD_TOOLS, PUBLIC_SEAT_WITHHELD_TOOLS, PUBLIC_WITHHELD_TOOLS,
} from '../src/lib/public-withheld-tools.js';
import { commonlyMcpServer } from '../src/lib/default-environment.js';
import { buildSeatbeltProfile } from '../src/lib/sandbox/seatbelt.js';
import { BRIDGE_HEADERS_VAR, BRIDGE_PATH, BRIDGE_URL_VAR } from '../src/lib/adapters/codex-broker-bridge.mjs';

const childWith = (stdout, code = 0, stderr = '') => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
};

const reply = (text) => [
  '    __( O)> new session',
  JSON.stringify({ type: 'message', message: {
    role: 'assistant', content: [{ type: 'text', text }],
    metadata: { userVisible: true },
  } }),
  JSON.stringify({ type: 'complete', total_tokens: 3 }),
  '',
].join('\n');

const baseCtx = () => ({
  agentName: 'test-goose', cwd: process.cwd(), runtimeToken: 'cm_agent_test_runtime_token',
  instanceUrl: 'https://api.commonly.me', _version: TESTED_GOOSE_VERSIONS[0],
  env: {
    PATH: process.env.PATH, COMMONLY_LITELLM_KEY: 'litellm-private-test-key',
    ANTHROPIC_API_KEY: 'operator-secret-must-not-inherit',
  },
  environment: { model: 'deepseek-v4-flash', mcp: [commonlyMcpServer()] },
});

test('private Goose turn isolates its home, takes Commonly MCP through a token file, and parses reply', async () => {
  let launched;
  const ctx = baseCtx();
  const result = await goose.spawn('hello', { environment: { model: 'test-model' },
    ...ctx,
    _spawnImpl: (cmd, args, options) => {
      launched = { cmd, args, options };
      const ext = args[args.indexOf('--with-extension') + 1];
      const match = ext.match(/COMMONLY_TOKEN_FILE=([^\s"]+)/);
      expect(match).not.toBeNull();
      expect(existsSync(match[1])).toBe(true);
      return childWith(reply('Goose says hi'));
    },
  });
  expect(result).toEqual({ text: 'Goose says hi', newSessionId: null });
  expect(launched.args).toEqual(expect.arrayContaining([
    'run', '--no-session', '--no-profile', '--with-builtin', 'developer',
    '--output-format', 'stream-json', '--provider', 'openai',
  ]));
  expect(launched.args.join(' ')).not.toContain(ctx.runtimeToken);
  expect(launched.args.join(' ')).toContain('commonly:');
  expect(launched.options.env.COMMONLY_AGENT_TOKEN).toBeUndefined();
  expect(launched.options.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(launched.options.env.OPENAI_API_KEY).toBe(ctx.env.COMMONLY_LITELLM_KEY);
  expect(launched.options.env.HOME).not.toBe(process.env.HOME);
  expect(existsSync(launched.options.env.HOME)).toBe(false);
});

test.each(['public', 'internal'])('refuses %s trust without an explicit provider before spawning', async (trust) => {
  const ctx = baseCtx();
  ctx.environment.sandbox = { trust };
  const spawnImpl = jest.fn();
  await expect(goose.spawn('hello', { ...ctx, _spawnImpl: spawnImpl }))
    .rejects.toThrow(/public seats require an explicit provider/);
  expect(spawnImpl).not.toHaveBeenCalled();
});

test.each(['workspace', 'bwrap'])('refuses %s confinement before spawning', async (mode) => {
  const ctx = baseCtx();
  ctx.environment.sandbox = { mode };
  const spawnImpl = jest.fn();
  await expect(goose.spawn('hello', { environment: { model: 'test-model' }, ...ctx, _spawnImpl: spawnImpl }))
    .rejects.toThrow(/cannot be enforced by Goose/);
  expect(spawnImpl).not.toHaveBeenCalled();
});

test.each([
  [],
  [{ name: 'other', transport: 'stdio', command: ['node', '/tmp/other.js'] }],
  [commonlyMcpServer(), { name: 'other', transport: 'stdio', command: ['node', '/tmp/other.js'] }],
  [{ name: 'commonly', transport: 'http', url: 'https://api.commonly.me/mcp' }],
].map((servers) => [servers]))('public Goose rejects a noncanonical extension set before launch', (servers) => {
  expect(() => extensionArgs(servers, { publicSeat: true })).toThrow(/only the Commonly/);
});

test.each(['none', 'container'])('public Goose refuses unsupported mode %s', (mode) => {
  expect(() => assertSandboxSupported({ sandbox: { trust: 'public', mode } })).toThrow(/enforced sandbox/);
});

test('public Goose refuses a recognized source entry instead of granting its ancestor', () => {
  const mcpReadDirectories = [];
  expect(() => extensionArgs([{ name: 'commonly', transport: 'stdio',
    command: [process.execPath, fileURLToPath(new URL('../../commonly-mcp/src/index.js', import.meta.url))],
  }], { publicSeat: true, mcpReadDirectories })).toThrow(/absolute prepared entry/);
  expect(mcpReadDirectories).toEqual([]);
});

test('public Goose refuses a restricted network declaration it cannot enforce', () => {
  expect(() => assertSandboxSupported({ provider: {}, model: 'fixture',
    sandbox: { trust: 'public', network: { policy: 'restricted' } },
  })).toThrow(/restricted networking/);
});

test.each(['public', 'internal'])('Goose %s trust refuses extra host read paths', (trust) => {
  const environment = { provider: {}, model: 'fixture',
    sandbox: { trust, filesystem: { 'read-outside': ['/'] } } };
  expect(() => assertSandboxSupported(environment)).toThrow(/read-outside/);
  expect(() => assertSandboxSupported({ ...environment,
    sandbox: { trust, filesystem: { 'read-outside': [] } },
  })).not.toThrow();
});

test('none mode is allowed, and missing provider key fails before spawning', async () => {
  expect(() => assertSandboxSupported({ sandbox: { trust: 'private', mode: 'none' } })).not.toThrow();
  const ctx = baseCtx();
  delete ctx.env.COMMONLY_LITELLM_KEY;
  const spawnImpl = jest.fn();
  await expect(goose.spawn('hello', { environment: { model: 'test-model' }, ...ctx, _spawnImpl: spawnImpl }))
    .rejects.toThrow(/COMMONLY_LITELLM_KEY is missing/);
  expect(spawnImpl).not.toHaveBeenCalled();
});

test('MCP command flags refuse literal credentials and credential-bearing HTTP', () => {
  const ctx = { instanceUrl: 'https://api.commonly.me', runtimeToken: 'cm_agent_actual_token', credentialFile: '/tmp/token' };
  expect(() => extensionArgs([{ ...commonlyMcpServer(), env: { COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' } }], ctx))
    .not.toThrow();
  expect(() => extensionArgs([{ name: 'other', transport: 'stdio', command: ['node', 'server.js'], env: { API_KEY: 'secret' } }], ctx))
    .toThrow(/cannot safely ride a CLI flag/);
  expect(() => extensionArgs([{ name: 'remote', transport: 'http', url: 'https://other.example/mcp' }], ctx))
    .toThrow(/outside the Commonly instance/);
  expect(() => extensionArgs([{ name: 'remote', transport: 'http', url: 'https://api.commonly.me/mcp?key=secret' }], ctx))
    .toThrow(/credential-bearing URL/);
});

test('structured error at exit zero is a failed turn; incomplete output is not posted', async () => {
  const ctx = baseCtx();
  const error = `${JSON.stringify({ type: 'error', message: 'route refused' })}\n${JSON.stringify({ type: 'complete' })}\n`;
  await expect(goose.spawn('hello', { environment: { model: 'test-model' }, ...ctx, _spawnImpl: () => childWith(error) }))
    .rejects.toThrow(/route refused/);
  await expect(goose.spawn('hello', { environment: { model: 'test-model' }, ...ctx, _spawnImpl: () => childWith(reply('partial').replace(/\{"type":"complete".*\}\n/, '')) }))
    .rejects.toThrow(/incomplete stream/);
  await expect(goose.spawn('hello', { environment: { model: 'test-model' }, ...ctx, _spawnImpl: () => childWith(
    reply('I cannot see the pod'), 0, "Failed to start extension 'commonly' (process quit before initialization)\n",
  ) })).rejects.toThrow(/Failed to start extension/);
});

test('parser keeps final visible assistant text, not tool data or Goose banner', () => {
  const output = [
    'goose is ready',
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hidden' }], metadata: { userVisible: false } } }),
    JSON.stringify({ type: 'message', message: { role: 'tool', content: [{ type: 'text', text: 'secret tool result' }] } }),
    reply('final answer'),
  ].join('\n');
  expect(readGooseStream(output)).toEqual({ text: 'final answer', error: null, complete: true });
});

test('Goose stdout preserves UTF-8 characters split across data chunks', async () => {
  const ctx = baseCtx();
  const output = Buffer.from(reply('你好🙂'));
  const split = output.indexOf(Buffer.from('你')) + 1;
  expect(split).toBeGreaterThan(0);
  const result = await goose.spawn('hello', { environment: { model: 'test-model' },
    ...ctx,
    _spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      queueMicrotask(() => {
        child.stdout.emit('data', output.subarray(0, split));
        child.stdout.emit('data', output.subarray(split));
        child.emit('close', 0);
      });
      return child;
    },
  });
  expect(result).toEqual({ text: '你好🙂', newSessionId: null });
});

test('oversized stream terminates Goose and fails after the child closes', async () => {
  const ctx = baseCtx();
  let child;
  await expect(goose.spawn('hello', { environment: { model: 'test-model' },
    ...ctx,
    _spawnImpl: () => {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.alloc(2 * 1024 * 1024 + 1, 'x'));
        child.emit('close', 0);
      });
      return child;
    },
  })).rejects.toThrow(/stream exceeded 2 MiB/);
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
});

test('the public Goose allowlist names only shipped MCP tools and none that public seats withhold', () => {
  const source = readFileSync(fileURLToPath(new URL('../../commonly-mcp/src/tools.js', import.meta.url)), 'utf8');
  const shipped = new Set([...source.matchAll(/name: '(commonly_[a-z_]+)'/g)].map(([, name]) => name));
  expect(shipped.size).toBeGreaterThan(0);
  expect(PUBLIC_GOOSE_TOOLS.filter((name) => !shipped.has(name))).toEqual([]);
  expect(PUBLIC_GOOSE_TOOLS.filter((name) => PUBLIC_WITHHELD_TOOLS.includes(name))).toEqual([]);
});

// F118: a public seat starts from nothing. It cannot install itself into other
// pods or write its own memory (log_cycle appends to it too); it can read it.
test('the public Goose allowlist withholds self-install and every memory write, and keeps the read', () => {
  expect(PUBLIC_GOOSE_TOOLS.filter((name) => PUBLIC_ONLY_WITHHELD_TOOLS.includes(name))).toEqual([]);
  expect(PUBLIC_ONLY_WITHHELD_TOOLS).toEqual(expect.arrayContaining([
    'commonly_self_install_into_pod', 'commonly_write_agent_memory', 'commonly_save_my_memory', 'commonly_log_cycle',
  ]));
  expect(PUBLIC_GOOSE_TOOLS).toContain('commonly_read_agent_memory');
});

// F141: public seats start from nothing. A stranger-steered seat could delete
// its own replies to an injection, the evidence of what the attack achieved.
test('public seats are not offered commonly_delete_message on any adapter', () => {
  expect(PUBLIC_GOOSE_TOOLS).not.toContain('commonly_delete_message');
  expect(PUBLIC_ONLY_WITHHELD_TOOLS).toContain('commonly_delete_message');
  expect(PUBLIC_SEAT_WITHHELD_TOOLS).toContain('commonly_delete_message');
});

test('a public Goose recipe shows the memory it read and names no save tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goose-public-f118-'));
  const home = join(root, 'mcp-home');
  const versionDir = join(home, '0.3.13');
  const pkgDir = join(versionDir, 'node_modules', '@commonlyai', 'mcp');
  mkdirSync(join(pkgDir, 'src'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': 'src/index.js' },
  }));
  writeFileSync(join(pkgDir, 'src', 'index.js'), '');
  writeFileSync(join(home, 'current'), '0.3.13\n');
  // A held warm lock keeps prepareMcpSpawn from starting a real warm: its
  // detached child writes here and races this test's rmSync (ENOTEMPTY).
  writeFileSync(join(home, '.warm.lock'), 'warming\n');
  const keyFile = join(root, 'provider-key');
  writeFileSync(keyFile, 'upstream-secret', { mode: 0o600 });
  const prior = process.env.COMMONLY_MCP_HOME;
  process.env.COMMONLY_MCP_HOME = home;
  let recipe;
  try {
    const ctx = baseCtx();
    await goose.spawn('hello', {
      ...ctx,
      memoryLongTerm: 'kept notes',
      environment: { ...ctx.environment,
        provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
        sandbox: { trust: 'public', mode: 'workspace' },
      },
      _binaryPath: '/usr/bin/true',
      _platform: 'darwin',
      _wrapArgvWithSeatbelt: (argv) => argv,
      _spawnImpl: (_cmd, args) => {
        recipe = JSON.parse(readFileSync(args[args.indexOf('--recipe') + 1], 'utf8'));
        return childWith(reply('ok'));
      },
    });
  } finally {
    if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
    else process.env.COMMONLY_MCP_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
  expect(recipe.prompt).toContain('kept notes');
  expect(recipe.prompt).not.toContain('commonly_save_my_memory');
  for (const extension of recipe.extensions) {
    for (const tool of PUBLIC_ONLY_WITHHELD_TOOLS) expect(extension.available_tools).not.toContain(tool);
    expect(extension.available_tools).toContain('commonly_read_agent_memory');
  }
});

// F197: a public seat's writable workspace is the scratch folder the CLI made,
// so the profile pins it. A link at that path refuses the turn before spawn.
test('a public seat whose writable workspace is a link is refused, and nothing is spawned', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goose-f197-'));
  const cwd = join(root, 'workspace');
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, cwd);
  const keyFile = join(root, 'provider-key');
  writeFileSync(keyFile, 'upstream-secret', { mode: 0o600 });
  const home = join(root, 'mcp-home');
  const pkgDir = join(home, '0.3.13', 'node_modules', '@commonlyai', 'mcp');
  mkdirSync(join(pkgDir, 'src'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': 'src/index.js' },
  }));
  writeFileSync(join(pkgDir, 'src', 'index.js'), '');
  writeFileSync(join(home, 'current'), '0.3.13\n');
  // A held warm lock keeps prepareMcpSpawn from starting a real warm: its
  // detached child writes here and races this test's rmSync (ENOTEMPTY).
  writeFileSync(join(home, '.warm.lock'), 'warming\n');
  const prior = process.env.COMMONLY_MCP_HOME;
  process.env.COMMONLY_MCP_HOME = home;
  const calls = [];
  try {
    const ctx = baseCtx();
    const error = await goose.spawn('hello', {
      ...ctx,
      cwd,
      environment: { ...ctx.environment,
        provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
        sandbox: { trust: 'public', mode: 'workspace' },
      },
      _binaryPath: '/usr/bin/true',
      _platform: 'darwin',
      _wrapArgvWithSeatbelt: (argv, options) => { buildSeatbeltProfile(options); return argv; },
      _spawnImpl: (...args) => { calls.push(args); return childWith(reply('ok')); },
    }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/its writable workspace/);
    expect(error.message).toContain(cwd);
    expect(calls).toHaveLength(0);
  } finally {
    if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
    else process.env.COMMONLY_MCP_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

// F219: the temp folder holds this turn's credential, so a workspace that holds
// the temp folder hands it to the jail.
test('a public seat in a workspace that holds the temp folder is refused, and nothing is spawned', async () => {
  const keyCheck = jest.spyOn(goose, 'validateEnvironment').mockResolvedValue('/unused/provider-key');
  const spawn = jest.fn();
  try {
    const ctx = baseCtx();
    await expect(goose.spawn('hello', {
      ...ctx,
      cwd: tmpdir(),
      environment: { ...ctx.environment,
        provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile: '/unused/provider-key' },
        sandbox: { trust: 'public', mode: 'workspace' },
      },
      _binaryPath: '/usr/bin/true',
      _platform: 'darwin',
      _spawnImpl: spawn,
    })).rejects.toThrow(/public Goose agents cannot run in .*set TMPDIR outside it/);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    keyCheck.mockRestore();
  }
});

// F219: the jail writes the seat home, so nothing adapter-owned sits in it.
test('a public bwrap seat gets its own files read-only, apart from the home it writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goose-f219-bwrap-'));
  const home = join(root, 'mcp-home');
  const pkgDir = join(home, '0.3.13', 'node_modules', '@commonlyai', 'mcp');
  mkdirSync(join(pkgDir, 'src'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': 'src/index.js' },
  }));
  writeFileSync(join(pkgDir, 'src', 'index.js'), '');
  writeFileSync(join(home, 'current'), '0.3.13\n');
  // A held warm lock keeps prepareMcpSpawn from starting a real warm.
  writeFileSync(join(home, '.warm.lock'), 'warming\n');
  const keyFile = join(root, 'provider-key');
  writeFileSync(keyFile, 'upstream-secret', { mode: 0o600 });
  const prior = process.env.COMMONLY_MCP_HOME;
  process.env.COMMONLY_MCP_HOME = home;
  let seen;
  try {
    const ctx = baseCtx();
    await goose.spawn('hello', {
      ...ctx,
      environment: { ...ctx.environment,
        provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
        sandbox: { trust: 'public', mode: 'bwrap' },
      },
      _binaryPath: '/usr/bin/true',
      _platform: 'linux',
      _detectBwrap: () => ({ available: true }),
      _wrapArgvWithBwrap: (argv, environment, options) => {
        seen = { environment, options, recipe: argv[argv.indexOf('--recipe') + 1] };
        return argv;
      },
      _spawnImpl: () => childWith(reply('ok')),
    });
  } finally {
    if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
    else process.env.COMMONLY_MCP_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
  const seatHome = seen.options.homePath;
  expect(seen.environment.sandbox.filesystem['write-outside']).toEqual([seatHome]);
  const owned = seen.options.readOnlyPaths.find((path) => seen.recipe.startsWith(`${path}/`));
  expect(owned).toBeTruthy();
  expect(seen.recipe.startsWith(`${seatHome}/`)).toBe(false);
  expect(owned.startsWith(`${seatHome}/`)).toBe(false);
});

// F175d: Goose 1.54.0 fills a streamable_http header from its own environment
// or from a literal in the recipe (measured), so neither keeps the token to one
// file. The broker runs behind the stdio bridge, as one more recipe extension.
describe('F175d: the grant broker reaches a public Goose seat through the stdio bridge', () => {
  const broker = (over = {}) => ({
    name: 'commonly-grant-broker',
    transport: 'http',
    url: '${COMMONLY_API_URL}/api/mcp/grants/g1',
    headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
    ...over,
  });
  const publicCtx = () => ({
    credentialFile: '/tmp/seat-token', instanceUrl: 'https://api.commonly.me',
    runtimeToken: 'cm_agent_actual_token', publicSeat: true,
    publicExtensions: [], mcpReadDirectories: [],
  });
  const withPreparedMcp = (fn) => async () => {
    const root = mkdtempSync(join(tmpdir(), 'goose-public-f175d-'));
    const home = join(root, 'mcp-home');
    const pkgDir = join(home, '0.3.13', 'node_modules', '@commonlyai', 'mcp');
    mkdirSync(join(pkgDir, 'src'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': 'src/index.js' },
    }));
    writeFileSync(join(pkgDir, 'src', 'index.js'), '');
    writeFileSync(join(home, 'current'), '0.3.13\n');
    writeFileSync(join(home, '.warm.lock'), 'warming\n');
    const keyFile = join(root, 'provider-key');
    writeFileSync(keyFile, 'upstream-secret', { mode: 0o600 });
    const prior = process.env.COMMONLY_MCP_HOME;
    process.env.COMMONLY_MCP_HOME = home;
    try {
      await fn({ keyFile });
    } finally {
      if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
      else process.env.COMMONLY_MCP_HOME = prior;
      rmSync(root, { recursive: true, force: true });
    }
  };
  const publicSpawn = async ({ keyFile, servers, stdout = reply('ok'), stderr = '', ...over }) => {
    const ctx = baseCtx();
    const seen = {};
    const result = await goose.spawn('hello', {
      ...ctx,
      environment: { ...ctx.environment, mcp: servers,
        provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
        sandbox: { trust: 'public', mode: 'workspace' },
      },
      _binaryPath: '/usr/bin/true',
      _platform: 'darwin',
      _wrapArgvWithSeatbelt: (argv, options) => { seen.wrap = options; return argv; },
      _spawnImpl: (_cmd, args, options) => {
        seen.args = args;
        seen.env = options.env;
        seen.recipeText = readFileSync(args[args.indexOf('--recipe') + 1], 'utf8');
        return childWith(stdout, 0, stderr);
      },
      ...over,
    });
    return { result, seen, ctx };
  };

  test('the entry becomes a recipe extension running our bridge, told a url, a template and a path', () => {
    const ctx = publicCtx();
    const bridged = bridgedGooseExtension(broker(), ctx);
    expect(bridged).toEqual({
      type: 'stdio', name: 'commonly-grant-broker', cmd: process.execPath, args: [BRIDGE_PATH],
      envs: {
        [BRIDGE_URL_VAR]: 'https://api.commonly.me/api/mcp/grants/g1',
        [BRIDGE_HEADERS_VAR]: JSON.stringify({ Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' }),
        COMMONLY_TOKEN_FILE: '/tmp/seat-token',
      },
    });
    expect(JSON.stringify(bridged)).not.toContain('cm_agent_actual_token');
  });

  test('a public seat still refuses any other server, including an HTTP one that is not ours', () => {
    expect(() => extensionArgs([{ name: 'remote', transport: 'http', url: 'https://api.commonly.me/mcp' }], publicCtx()))
      .toThrow(/only the Commonly/);
    expect(() => extensionArgs([broker({ url: 'https://evil.example/api/mcp/grants/g1' })], publicCtx()))
      .toThrow(/only the Commonly/);
    expect(() => extensionArgs([{ name: 'other', transport: 'stdio', command: ['node', 'x.js'] }], publicCtx()))
      .toThrow(/only the Commonly/);
    expect(() => extensionArgs([], publicCtx())).toThrow(/only the Commonly MCP extension/);
  });

  test('a broker never stands in for the Commonly extension', () => {
    expect(() => extensionArgs([broker()], publicCtx())).toThrow(/only the Commonly MCP extension/);
  });

  test('a private seat never gets the bridge: the guard withholds it, and this is the second layer', () => {
    const { publicSeat, publicExtensions, mcpReadDirectories, ...ctx } = publicCtx();
    expect(() => extensionArgs([broker()], ctx)).toThrow(/cannot deliver without exposing credentials/);
  });

  test('the recipe holds the bridge beside Commonly, the jail reads the bridge file alone, and no token rides', withPreparedMcp(async ({ keyFile }) => {
    const { seen, ctx } = await publicSpawn({ keyFile, servers: [commonlyMcpServer(), broker()] });
    const recipe = JSON.parse(seen.recipeText);
    expect(recipe.extensions.map((extension) => extension.name)).toEqual(['commonly', 'commonly-grant-broker']);
    const bridge = recipe.extensions[1];
    expect(bridge.cmd).toBe(process.execPath);
    expect(bridge.args).toEqual([BRIDGE_PATH]);
    expect(bridge.envs.OPENSSL_CONF).toBeTruthy();
    expect(recipe.extensions[0].available_tools).toEqual(PUBLIC_GOOSE_TOOLS);
    expect(seen.wrap.readOnlyDirectories).toContain(BRIDGE_PATH);
    expect(seen.wrap.readOnlyDirectories).not.toContain(dirname(BRIDGE_PATH));
    for (const text of [seen.args.join('\n'), seen.recipeText, JSON.stringify(seen.env)]) {
      expect(text).not.toContain(ctx.runtimeToken);
    }
    expect(seen.env.COMMONLY_AGENT_TOKEN).toBeUndefined();
  }));

  test('a bwrap seat binds the bridge file read-only', withPreparedMcp(async ({ keyFile }) => {
    let wrapOptions;
    const ctx = baseCtx();
    await goose.spawn('hello', {
      ...ctx,
      environment: { ...ctx.environment, mcp: [commonlyMcpServer(), broker()],
        provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
        sandbox: { trust: 'public', mode: 'bwrap' },
      },
      _binaryPath: '/usr/bin/true',
      _detectBwrap: () => ({ available: true }),
      _wrapArgvWithBwrap: (argv, _environment, options) => { wrapOptions = options; return argv; },
      _spawnImpl: () => childWith(reply('ok')),
    });
    expect(wrapOptions.readOnlyPaths).toContain(BRIDGE_PATH);
  }));

  test('a broker that fails to start costs the grant and not the turn', withPreparedMcp(async ({ keyFile }) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result } = await publicSpawn({
        keyFile,
        servers: [commonlyMcpServer(), broker()],
        stderr: "Failed to start extension 'commonly-grant-broker': HTTP 403\n",
      });
      expect(result.text).toBe('ok');
    } finally {
      warn.mockRestore();
    }
  }));

  test('the Commonly extension failing to start still fails the turn', withPreparedMcp(async ({ keyFile }) => {
    await expect(publicSpawn({
      keyFile,
      servers: [commonlyMcpServer(), broker()],
      stderr: "Failed to start extension 'commonly': nope\n",
    })).rejects.toThrow(/Failed to start extension 'commonly'/);
  }));
});
