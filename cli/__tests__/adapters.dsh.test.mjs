import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { existsSync, readFileSync, statSync } from 'fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const spawnSyncMock = jest.fn();
await jest.unstable_mockModule('child_process', () => ({ spawnSync: spawnSyncMock, spawn: jest.fn() }));
const {
  default: dsh, TESTED_DSH_VERSIONS, assertPrivateDsh, buildPatch,
  childEnvironment, resolveCommonlyMcp, runDsh, sessionExists,
} = await import('../src/lib/adapters/dsh.js');

const event = (value) => `${JSON.stringify(value)}\n`;
const fakeChild = ({ stdout = event({ type: 'session', sessionId: 'session-11111111-1111-1111-1111-111111111111' })
  + event({ type: 'final', text: 'reply' }), stderr = '', code = 0 } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', code);
  }, 0);
  return proc;
};

const withSeat = async (fn) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-unit-'));
  const cwd = join(root, 'workspace');
  const keyFile = join(root, 'provider-key');
  const home = join(root, 'dsh-home');
  await mkdir(cwd);
  await writeFile(keyFile, 'upstream-secret-123', { mode: 0o600 });
  await chmod(keyFile, 0o600);
  const ctx = {
    cwd, _dshHome: home, _dshBinary: 'dsh', agentName: 'dsh-test',
    runtimeToken: 'cm_agent_secret-123', instanceUrl: 'https://api.commonly.me',
    env: { PATH: '/usr/bin', DEEPSEEK_API_KEY: 'shadow-key', DSH_HOME: '/tmp/shadow', COMMONLY_AGENT_TOKEN: 'shadow-token' },
    environment: {
      model: 'deepseek-chat', effort: 'high',
      provider: { id: 'deepseek', baseURL: 'http://127.0.0.1:9/v1', keyFile },
    },
  };
  try { await fn(ctx, root); } finally { await rm(root, { recursive: true, force: true }); }
};

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, stdout: `dsh ${TESTED_DSH_VERSIONS[0]}\n` });
});

test('public and any declared sandbox mode refuse before a child starts', async () => {
  expect(() => assertPrivateDsh({ sandbox: { trust: 'internal' } })).toThrow(/public-trust/);
  expect(() => assertPrivateDsh({ sandbox: { trust: 'public' } })).toThrow(/public-trust/);
  expect(() => assertPrivateDsh({ sandbox: { mode: 'none' } })).toThrow(/sandbox.mode/);
  await withSeat(async (ctx) => {
    const spawn = jest.fn();
    await expect(dsh.spawn('hi', { ...ctx, environment: { ...ctx.environment, sandbox: { trust: 'public' } }, _spawnImpl: spawn }))
      .rejects.toThrow(/public-trust/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

test('unprobed release refuses even for private seats', async () => {
  await withSeat(async (ctx) => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'dsh 0.2.1-rc.3\n' });
    const spawn = jest.fn();
    await expect(dsh.validateEnvironment(ctx.environment, ctx.cwd)).rejects.toThrow(/not smoke-tested/);
    await expect(dsh.spawn('hi', { ...ctx, _spawnImpl: spawn })).rejects.toThrow(/not smoke-tested/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

test('one patch selects proxy pi-ai, disables native routes and upload, and mounts only Commonly MCP', async () => {
  await withSeat(async (ctx) => {
    await writeFile(join(ctx.cwd, '.env'), 'DEEPSEEK_API_KEY=project-shadow\nDSH_HOME=/tmp/project-shadow\n');
    const calls = [];
    const result = await dsh.spawn('hello', { ...ctx, _spawnImpl: (binary, args, options) => {
      const patchPath = args[args.indexOf('--patch') + 1];
      const patchText = readFileSync(patchPath, 'utf8');
      const credentialFile = JSON.parse(patchText).at(-1).insert[0].config.env.COMMONLY_TOKEN_FILE;
      calls.push({ binary, args, options, patchPath, patchText, credentialFile,
        token: readFileSync(credentialFile, 'utf8'),
        patchMode: statSync(patchPath).mode & 0o777,
        credentialMode: statSync(credentialFile).mode & 0o777,
      });
      return fakeChild();
    } });
    expect(result).toEqual({ text: 'reply', newSessionId: 'session-11111111-1111-1111-1111-111111111111' });
    const call = calls[0];
    const rows = JSON.parse(call.patchText);
    expect(call.args.filter((arg) => arg === '--patch')).toHaveLength(1);
    expect(rows.find((row) => row.id === 'agent-default-model').config).toEqual({ provider: 'commonly', model: 'deepseek-chat' });
    expect(rows.find((row) => row.id === 'llm-pi-ai').config.providers.commonly).toMatchObject({
      api: 'openai-completions', apiKeyEnv: 'COMMONLY_DSH_PROXY_KEY', reasoning: 'high',
      baseURL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1\/?$/),
      compat: { supportsDeveloperRole: false, supportsStore: false },
    });
    expect(rows.find((row) => row.id === 'llm-pi-ai').config.providers.commonly.models[0].reasoningEfforts.high).toBe('high');
    expect(rows.find((row) => row.id === 'llm-deepseek').disabled).toBe(true);
    expect(rows.find((row) => row.id === 'llm-deepseek-account').disabled).toBe(true);
    expect(rows.find((row) => row.id === 'session-log-deepseek').config.enabled).toBe(false);
    expect(rows.find((row) => row.id === 'sandbox-policy').config).toEqual({ mode: 'workspace-write', workspaceRoot: ctx.cwd });
    expect(rows.at(-1).insert[0].name).toBe('@deepseek-ai/dsh-mcp-client');
    expect(call.token).toBe(ctx.runtimeToken);
    expect(call.options.env.DSH_HOME).toBe(ctx._dshHome);
    expect(call.options.env.DSH_PERMISSION_MODE).toBe('workspace-write');
    expect(call.options.env.DSH_TELEMETRY_MODE).toBe('DISABLED');
    expect(call.options.env.DSH_TELEMETRY_DISABLED).toBe('1');
    expect(call.options.env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(call.options.env.COMMONLY_AGENT_TOKEN).toBeUndefined();
    expect(call.options.env.COMMONLY_DSH_PROXY_KEY).toBeTruthy();
    expect(call.patchText).not.toContain(ctx.runtimeToken);
    expect(call.patchText).not.toContain(call.options.env.COMMONLY_DSH_PROXY_KEY);
    expect(call.patchText).not.toContain('upstream-secret-123');
    expect(call.patchText).not.toContain('${COMMONLY_AGENT_TOKEN}');
    expect(call.patchMode).toBe(0o600);
    expect(call.credentialMode).toBe(0o600);
    expect(existsSync(call.patchPath)).toBe(false);
    expect(existsSync(call.credentialFile)).toBe(false);
    expect(statSync(ctx._dshHome).mode & 0o777).toBe(0o700);
  });
});

test('an MCP declaration without file delivery or with extra tools refuses', async () => {
  await withSeat(async (ctx) => {
    const extra = { name: 'other', transport: 'stdio', command: ['node', 'other.js'] };
    await expect(dsh.spawn('hi', { ...ctx, environment: { ...ctx.environment, mcp: [extra] } }))
      .rejects.toThrow(/only the Commonly MCP/);
    const old = { name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@0.3.7'], env: {
      COMMONLY_API_URL: '${COMMONLY_API_URL}', COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}',
    } };
    await expect(dsh.spawn('hi', { ...ctx, environment: { ...ctx.environment, mcp: [old] } }))
      .rejects.toThrow(/file-backed credentials/);
    const base = { name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'],
      env: { COMMONLY_API_URL: '${COMMONLY_API_URL}', COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' } };
    await expect(dsh.spawn('hi', { ...ctx, environment: { ...ctx.environment,
      mcp: [{ ...base, env: { ...base.env, COMMONLY_API_URL: 'https://wrong.example' } }] } }))
      .rejects.toThrow(/this spawn's credential file/);
    await expect(dsh.spawn('hi', { ...ctx, environment: { ...ctx.environment,
      mcp: [{ ...base, command: ['sh', '-c', 'echo attacker', '@commonlyai/mcp@latest'] }] } }))
      .rejects.toThrow(/recognized stdio/);
  });
});

test('foreign session starts fresh; this seat session resumes', async () => {
  await withSeat(async (ctx) => {
    const id = 'session-11111111-1111-1111-1111-111111111111';
    const calls = [];
    const impl = (_cmd, args) => { calls.push(args); return fakeChild(); };
    await dsh.spawn('first', { ...ctx, sessionId: 'session-22222222-2222-2222-2222-222222222222', _spawnImpl: impl });
    expect(calls[0]).not.toContain('--session-id');
    const dir = join(ctx._dshHome, 'sessions', 'workspace', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'mock');
    expect(await sessionExists(ctx._dshHome, id)).toBe(true);
    await dsh.spawn('again', { ...ctx, sessionId: id, _spawnImpl: impl });
    expect(calls[1]).toEqual(expect.arrayContaining(['--session-id', id]));
  });
});

test('exit zero without final, an error event, and a sandbox runner failure all refuse', async () => {
  const env = {}, credentials = ['hidden-secret-123'];
  const base = { binary: 'dsh', args: [], cwd: '/tmp', env, timeoutMs: 1000, credentials };
  await expect(runDsh({ ...base, spawnImpl: () => fakeChild({ stdout: event({ type: 'text', text: 'thinking' }) }) }))
    .rejects.toThrow(/no final event/);
  await expect(runDsh({ ...base, spawnImpl: () => fakeChild({ stdout: event({ type: 'error', message: 'bad route' })
    + event({ type: 'final', text: 'looks fine' }) }) })).rejects.toThrow(/bad route/);
  await expect(runDsh({ ...base, spawnImpl: () => fakeChild({ stdout: event({ type: 'tool_result', status: 'error', result: 'SANDBOX_UNAVAILABLE' })
    + event({ type: 'final', text: 'looks fine' }) }) })).rejects.toThrow(/sandbox runner unavailable/);
  await expect(runDsh({ ...base, spawnImpl: () => fakeChild({ stdout: event({ type: 'error', message: 'hidden-secret-123 refused' }) }) }))
    .rejects.toThrow(/\[redacted\] refused/);
});

test('helpers keep the native route disabled and child env closed', () => {
  const env = childEnvironment({ PATH: '/bin', DEEPSEEK_API_KEY: 'shadow', DSH_HOME: '/tmp/shadow' }, '/tmp/seat', 'bearer');
  expect(env.DEEPSEEK_API_KEY).toBeUndefined();
  expect(env.DSH_HOME).toBe('/tmp/seat');
  const mcp = resolveCommonlyMcp([], { credentialFile: '/tmp/seat-token', instanceUrl: 'https://api.commonly.me' });
  const rows = buildPatch({ proxyBaseURL: 'http://127.0.0.1:10/v1', model: 'm', cwd: '/tmp/work', mcp });
  expect(rows.find((row) => row.id === 'llm-deepseek').disabled).toBe(true);
  const official = buildPatch({ proxyBaseURL: 'http://127.0.0.1:10/v1', model: 'deepseek-flash', cwd: '/tmp/work', mcp,
    effort: 'high', deepseekOfficial: true });
  expect(official[0].config.providers.commonly.compat).toEqual({
    thinkingFormat: 'deepseek', supportsDeveloperRole: false, supportsStore: false,
  });
  expect(rows[0].config.providers.commonly.compat).toEqual({
    supportsDeveloperRole: false, supportsStore: false,
  });
});
