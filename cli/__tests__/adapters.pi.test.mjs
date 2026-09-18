/**
 * adapters.pi.test.mjs — the pi adapter (ADR-005 contract, 2026-09-18).
 *
 * The real `pi` binary is never invoked: spawnSync is mocked for detect(),
 * and `ctx._spawnImpl` replaces the child spawn for spawn(). `ctx._piHome`
 * points the per-seat home at a temp dir so models.json can be read back.
 *
 * Argv shape under test (pi 0.84):
 *   new turn: pi -p --mode json … --session-dir <dir> --session-id <uuid> [-e bridge] "<prompt>"
 *   resume:   pi -p --mode json … --session-dir <dir> --session <uuid>     [-e bridge] "<prompt>"
 */
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const spawnSyncMock = jest.fn();
await jest.unstable_mockModule('child_process', () => ({ spawnSync: spawnSyncMock, spawn: jest.fn() }));
const mod = await import('../src/lib/adapters/pi.js');
const pi = mod.default;
const { extractReply, thinkingFor, resolveMcpServers, buildModelsJson, resolveProvider } = mod;

const event = (obj) => `${JSON.stringify(obj)}\n`;
const assistant = (text) => event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });

const fakeChild = ({ stdout = '', stderr = '', code = 0 } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', code);
  }, 5);
  return proc;
};
const makeSpawnImpl = (out) => {
  const calls = [];
  const impl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return fakeChild(out); };
  return { impl, calls };
};

let home;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'pi-home-')); spawnSyncMock.mockReset(); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const baseCtx = (over = {}) => ({
  cwd: '/tmp/seat', agentName: 'kai', env: { PATH: '/usr/bin', COMMONLY_LITELLM_KEY: 'sk-test' },
  environment: { model: 'deepseek-v4-flash', effort: 'xhigh' }, _piHome: home, ...over,
});

describe('detect', () => {
  test('reports the pi version when the binary answers', async () => {
    spawnSyncMock.mockImplementation((cmd) => (cmd === 'pi' ? { status: 0, stdout: '0.84.1\n' } : { status: 0, stdout: '/opt/homebrew/bin/pi\n' }));
    expect(await pi.detect()).toEqual({ path: '/opt/homebrew/bin/pi', version: '0.84.1' });
  });
  test('is null when pi is not on PATH', async () => {
    spawnSyncMock.mockReturnValue({ error: new Error('ENOENT'), status: null });
    expect(await pi.detect()).toBeNull();
  });
});

describe('spawn', () => {
  test('a new turn: -p json, provider/model/thinking from the environment, --session-id, prompt last', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('done') });
    const res = await pi.spawn('hello', baseCtx({ _spawnImpl: impl }));
    expect(res.text).toBe('done');
    expect(res.newSessionId).toMatch(/^[0-9a-f-]{36}$/);
    const { cmd, args, opts } = calls[0];
    expect(cmd).toBe('pi');
    expect(args.slice(0, 3)).toEqual(['-p', '--mode', 'json']);
    expect(args).toEqual(expect.arrayContaining(['--provider', 'litellm', '--model', 'deepseek-v4-flash', '--thinking', 'xhigh']));
    expect(args[args.indexOf('--session-id') + 1]).toBe(res.newSessionId);
    expect(args).not.toContain('--session');
    expect(args[args.length - 1]).toContain('hello');
    expect(args).not.toContain('-e'); // no MCP declared → no bridge
    expect(opts.cwd).toBe('/tmp/seat');
    expect(opts.env.PI_CODING_AGENT_DIR).toBe(join(home, 'agent'));
    // Provider by env reference: the key never lands in models.json.
    const models = JSON.parse(await readFile(join(home, 'agent', 'models.json'), 'utf8'));
    expect(models.providers.litellm.apiKey).toBe('$COMMONLY_LITELLM_KEY');
    expect(models.providers.litellm.baseUrl).toBe('https://litellm.commonly.me/v1');
    expect(models.providers.litellm.models[0].id).toBe('deepseek-v4-flash');
    expect(JSON.stringify(models)).not.toContain('sk-test');
    expect((await stat(join(home, 'sessions'))).isDirectory()).toBe(true);
  });

  test('a resume passes --session <id> and returns the same id — when pi wrote that session', async () => {
    await mkdir(join(home, 'sessions'), { recursive: true });
    await writeFile(join(home, 'sessions', '2026-09-18T05-00-00-000Z_abc-123.jsonl'), '{}\n');
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('again') });
    const res = await pi.spawn('more', baseCtx({ _spawnImpl: impl, sessionId: 'abc-123' }));
    expect(res.newSessionId).toBe('abc-123');
    expect(calls[0].args[calls[0].args.indexOf('--session') + 1]).toBe('abc-123');
    expect(calls[0].args).not.toContain('--session-id');
  });

  test('a persisted id pi never wrote (a codex thread id from before the switch) starts a fresh session under a new id', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('fresh') });
    const res = await pi.spawn('more', baseCtx({ _spawnImpl: impl, sessionId: '01a06c46-8386-7ea2-a34b-codexthread' }));
    expect(res.newSessionId).not.toBe('01a06c46-8386-7ea2-a34b-codexthread');
    expect(res.newSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0].args).not.toContain('--session');
    expect(calls[0].args[calls[0].args.indexOf('--session-id') + 1]).toBe(res.newSessionId);
    // A fresh session gets the fresh-session memory preamble, not the resume one.
    expect(calls[0].args[calls[0].args.length - 1]).toContain('more');
  });

  test('declared MCP servers ride into the bridge env with placeholders filled, and the token stays out of argv', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('ok') });
    const ctx = baseCtx({
      _spawnImpl: impl, _bridgePath: '/x/bridge.mjs', runtimeToken: 'cm_agent_secret', instanceUrl: 'https://api.example',
      environment: { model: 'deepseek-v4-flash', mcp: [{ name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'], env: { COMMONLY_API_URL: '${COMMONLY_API_URL}', COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' } }, { name: 'urlonly', transport: 'http', url: 'https://x' }] },
    });
    await pi.spawn('hi', ctx);
    const { args, opts } = calls[0];
    expect(args[args.indexOf('-e') + 1]).toBe('/x/bridge.mjs');
    const servers = JSON.parse(opts.env.COMMONLY_PI_MCP);
    expect(servers).toEqual([{ name: 'commonly', command: ['npx', '-y', '@commonlyai/mcp@latest'], env: { COMMONLY_API_URL: 'https://api.example', COMMONLY_AGENT_TOKEN: 'cm_agent_secret' } }]);
    expect(args.join(' ')).not.toContain('cm_agent_secret');
  });

  test('the environment can name its own provider and model; effort maps onto pi\'s ladder', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('x') });
    await pi.spawn('p', baseCtx({ _spawnImpl: impl, env: { DS_KEY: 'k' }, environment: { model: 'deepseek-flash', effort: 'none', provider: { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DS_KEY' } } }));
    const models = JSON.parse(await readFile(join(home, 'agent', 'models.json'), 'utf8'));
    expect(models.providers.deepseek.apiKey).toBe('$DS_KEY');
    expect(calls[0].args).toEqual(expect.arrayContaining(['--provider', 'deepseek', '--model', 'deepseek-flash', '--thinking', 'off']));
  });

  test('refuses to spawn without the provider key in the seat env', async () => {
    const { impl } = makeSpawnImpl({ stdout: assistant('x') });
    await expect(pi.spawn('p', baseCtx({ _spawnImpl: impl, env: { PATH: '/usr/bin' } }))).rejects.toThrow(/COMMONLY_LITELLM_KEY/);
  });

  test('the reply is the last assistant text; tool-call messages and tool results are not text', async () => {
    const stdout = event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }] } })
      + event({ type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'hello\n' }] } })
      + assistant('first') + assistant('final answer');
    expect(extractReply(stdout)).toEqual({ text: 'final answer', sawAssistant: true, errors: [] });
    const { impl } = makeSpawnImpl({ stdout });
    expect((await pi.spawn('p', baseCtx({ _spawnImpl: impl }))).text).toBe('final answer');
  });

  test('a non-zero exit with no assistant message surfaces pi\'s error, quota text included', async () => {
    const { impl } = makeSpawnImpl({ stdout: event({ type: 'error', message: 'Rate limit exceeded: You have hit your usage limit' }), code: 1 });
    await expect(pi.spawn('p', baseCtx({ _spawnImpl: impl }))).rejects.toThrow(/usage limit/);
  });

  test('a timeout SIGTERMs pi and rejects', async () => {
    const impl = () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = jest.fn(() => p.emit('close', null)); return p; };
    await expect(pi.spawn('p', baseCtx({ _spawnImpl: impl, timeoutMs: 20 }))).rejects.toThrow(/timed out/);
  });
});

describe('helpers', () => {
  test('thinkingFor maps ADR-008 effort onto pi and ignores unknowns', () => {
    expect(['xhigh', 'high', 'medium', 'low', 'none', 'bogus', undefined].map(thinkingFor)).toEqual(['xhigh', 'high', 'medium', 'low', 'off', null, null]);
  });
  test('resolveProvider defaults to LiteLLM and buildModelsJson keys by env reference', () => {
    expect(resolveProvider({})).toEqual({ name: 'litellm', baseUrl: 'https://litellm.commonly.me/v1', api: 'openai-completions', apiKeyEnv: 'COMMONLY_LITELLM_KEY' });
    expect(buildModelsJson(resolveProvider({}), 'm').providers.litellm.models[0].id).toBe('m');
  });
  test('resolveMcpServers skips url-only entries and leaves unknown placeholders alone', () => {
    expect(resolveMcpServers([{ name: 'a', command: ['x'], env: { K: '${COMMONLY_OTHER}' } }, { name: 'b', url: 'u' }], {})).toEqual([{ name: 'a', command: ['x'], env: { K: '${COMMONLY_OTHER}' } }]);
  });
});
