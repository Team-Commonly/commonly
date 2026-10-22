import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { jest } from '@jest/globals';
import goose, {
  TESTED_GOOSE_VERSIONS, assertNoSandboxDeclared, extensionArgs, readGooseStream,
} from '../src/lib/adapters/goose.js';
import { commonlyMcpServer } from '../src/lib/default-environment.js';

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
  const result = await goose.spawn('hello', {
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

test.each(['public', 'internal'])('refuses %s trust at the adapter gate before spawning', async (trust) => {
  const ctx = baseCtx();
  ctx.environment.sandbox = { trust };
  const spawnImpl = jest.fn();
  await expect(goose.spawn('hello', { ...ctx, _spawnImpl: spawnImpl }))
    .rejects.toThrow(/public-trust seats are not supported/);
  expect(spawnImpl).not.toHaveBeenCalled();
});

test.each(['workspace', 'bwrap'])('refuses %s confinement before spawning', async (mode) => {
  const ctx = baseCtx();
  ctx.environment.sandbox = { mode };
  const spawnImpl = jest.fn();
  await expect(goose.spawn('hello', { ...ctx, _spawnImpl: spawnImpl }))
    .rejects.toThrow(/cannot be enforced by Goose/);
  expect(spawnImpl).not.toHaveBeenCalled();
});

test('none mode is allowed, and missing provider key fails before spawning', async () => {
  expect(() => assertNoSandboxDeclared({ sandbox: { trust: 'private', mode: 'none' } })).not.toThrow();
  const ctx = baseCtx();
  delete ctx.env.COMMONLY_LITELLM_KEY;
  const spawnImpl = jest.fn();
  await expect(goose.spawn('hello', { ...ctx, _spawnImpl: spawnImpl }))
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
  await expect(goose.spawn('hello', { ...ctx, _spawnImpl: () => childWith(error) }))
    .rejects.toThrow(/route refused/);
  await expect(goose.spawn('hello', { ...ctx, _spawnImpl: () => childWith(reply('partial').replace(/\{"type":"complete".*\}\n/, '')) }))
    .rejects.toThrow(/incomplete stream/);
  await expect(goose.spawn('hello', { ...ctx, _spawnImpl: () => childWith(
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
  const result = await goose.spawn('hello', {
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
  await expect(goose.spawn('hello', {
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
