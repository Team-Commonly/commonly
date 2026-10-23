import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { jest } from '@jest/globals';
import grok from '../src/lib/adapters/grok.js';
import { commonlyMcpServer, defaultMcpServers } from '../src/lib/default-environment.js';

const withSeat = async (run) => {
  const root = await mkdtemp(join(tmpdir(), 'commonly-grok-test-'));
  const home = join(root, 'home');
  const cwd = join(root, 'seat');
  await mkdir(home);
  await mkdir(cwd);
  try { return await run({ root, home, cwd }); } finally { await rm(root, { recursive: true, force: true }); }
};

const context = ({ home, cwd }, extras = {}) => ({
  cwd, agentName: 'grok-test', runtimeToken: 'cm_agent_test_only_secret',
  instanceUrl: 'https://api.example.test',
  env: { HOME: home, PATH: '/bin', XAI_API_KEY: 'must-not-use-api-auth', GROK_HOME: '/wrong-home' },
  _prepareMcpSpawn: (command) => command,
  _spawnSyncImpl: (_binary, _args, options) => ({
    status: 0,
    stdout: JSON.stringify([{
      name: 'commonly', command: 'npx', args: ['-y', '@commonlyai/mcp@latest'], enabled: true,
      env: { COMMONLY_AGENT_TOKEN: options.env.COMMONLY_AGENT_TOKEN,
        COMMONLY_API_URL: options.env.COMMONLY_API_URL },
    }]),
  }),
  ...extras,
});

const recordedSpawn = (onSpawn, response = { text: 'PONG', sessionId: 'seat-session-id' }) => (binary, args, options) => {
  onSpawn(binary, args, options);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();
  queueMicrotask(() => {
    child.stdout.end(JSON.stringify(response));
    child.stderr.end();
    child.emit('close', 0);
  });
  return child;
};

test('first and resumed Grok turns use JSON, the wrapper HOME login, and only Commonly MCP', async () => {
  await withSeat(async (seat) => {
    const calls = [];
    const spawn = recordedSpawn((binary, args, options) => {
      const promptPath = args[args.indexOf('--prompt-file') + 1];
      calls.push({ binary, args, options, promptPath, prompt: readFileSync(promptPath, 'utf8') });
    });
    const first = await grok.spawn('Reply PONG', context(seat, { _spawnImpl: spawn }));
    const second = await grok.spawn('Reply again', context(seat, {
      sessionId: first.newSessionId, _spawnImpl: spawn,
    }));
    expect(first).toEqual({ text: 'PONG', newSessionId: 'seat-session-id' });
    expect(second.newSessionId).toBe(first.newSessionId);
    expect(calls).toHaveLength(2);
    expect(calls[0].prompt).toContain('Reply PONG');
    expect(calls[1].prompt).toContain('Reply again');
    expect(calls[0].args).not.toContain('--resume');
    expect(calls[1].args).toEqual(expect.arrayContaining(['--resume', 'seat-session-id']));
    for (const { binary, args, options } of calls) {
      expect(binary).toBe('grok');
      expect(args).not.toContain('-s');
      expect(args).not.toContain('--always-approve');
      expect(args).toEqual(expect.arrayContaining([
        '--output-format', 'json', '--permission-mode', 'dontAsk',
        '--allow', 'MCPTool(commonly__*)', '--deny', 'Bash',
        '--no-subagents', '--disable-web-search', '--no-auto-update', '--trust',
      ]));
      expect(args.join(' ')).not.toContain('cm_agent_test_only_secret');
      expect(args.join(' ')).not.toContain('Reply');
      expect(existsSync(args[args.indexOf('--prompt-file') + 1])).toBe(false);
      expect(options.env.HOME).toBe(seat.home);
      expect(options.env.GROK_HOME).toBeUndefined();
      expect(options.env.XAI_API_KEY).toBeUndefined();
      expect(options.env.COMMONLY_AGENT_TOKEN).toBe('cm_agent_test_only_secret');
      expect(options.env.GROK_CLAUDE_MCPS_ENABLED).toBe('false');
      expect(options.env.GROK_CURSOR_MCPS_ENABLED).toBe('false');
    }
    const config = await readFile(join(seat.cwd, '.grok', 'config.toml'), 'utf8');
    expect(config).toContain('[mcp_servers.commonly]');
    expect(config).toContain('COMMONLY_AGENT_TOKEN = "${COMMONLY_AGENT_TOKEN}"');
    expect(config).not.toContain('cm_agent_test_only_secret');
    expect(config).not.toContain('must-not-use-api-auth');
    expect(defaultMcpServers('grok')).toEqual([commonlyMcpServer()]);
  });
});

test('a Grok login or JSON failure cannot leak the Commonly runtime token', async () => {
  await withSeat(async (seat) => {
    const spawn = (_binary, _args, _options) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = jest.fn();
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({
          type: 'error', message: 'Login failed for cm_agent_test_only_secret',
        }));
        child.stderr.end();
        child.emit('close', 1);
      });
      return child;
    };
    await expect(grok.spawn('hello', context(seat, { _spawnImpl: spawn })))
      .rejects.toThrow(/Login failed/);
    await expect(grok.spawn('hello', context(seat, { _spawnImpl: spawn })))
      .rejects.not.toThrow(/cm_agent_test_only_secret/);
  });
});

test('refuses public and sandbox-declared seats before a Grok process starts', async () => {
  const spawn = jest.fn();
  await withSeat(async (seat) => {
    for (const sandbox of [{ trust: 'public' }, { trust: 'internal' }, { mode: 'seatbelt' }]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(grok.spawn('hello', context(seat, {
        environment: { sandbox }, _spawnImpl: spawn,
      }))).rejects.toThrow('no enforced confinement adapter exists');
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(seat.cwd, '.grok'))).toBe(false);
  });
});

test('refuses extra or replaced MCP servers rather than inheriting their tools', async () => {
  await expect(grok.validateEnvironment({ mcp: [commonlyMcpServer(), { name: 'sam', command: ['node'] }] }))
    .rejects.toThrow('only the shipped Commonly stdio MCP server');
  await expect(grok.validateEnvironment({ mcp: [{ ...commonlyMcpServer(), command: ['sh', '-c', 'echo bad'] }] }))
    .rejects.toThrow('only the shipped Commonly stdio MCP server');
});

test('merged Grok inventory refuses a compat or plugin server even when TOML is clean', async () => {
  await withSeat(async (seat) => {
    const spawn = jest.fn();
    const inventory = jest.fn(() => ({ status: 0, stdout: JSON.stringify([
      { name: 'commonly', command: 'npx', args: ['-y', '@commonlyai/mcp@latest'], enabled: true },
      { name: 'sam', command: 'node', args: ['/secret/server.js'], enabled: true },
    ]) }));
    await expect(grok.spawn('hello', context(seat, {
      _spawnImpl: spawn, _spawnSyncImpl: inventory,
    }))).rejects.toThrow('loaded MCP servers other than');
    expect(inventory.mock.calls[0][1]).toEqual([
      '--cwd', seat.cwd, '--trust', 'mcp', 'list', '--json',
    ]);
    expect(spawn).not.toHaveBeenCalled();
  });
});

test('refuses an inherited user MCP config and a project .mcp.json', async () => {
  await withSeat(async (seat) => {
    const spawn = jest.fn();
    await writeFile(join(seat.cwd, '.mcp.json'), '{"mcpServers":{"sam":{}}}');
    await expect(grok.spawn('hello', context(seat, { _spawnImpl: spawn })))
      .rejects.toThrow('inherited .mcp.json');
    await rm(join(seat.cwd, '.mcp.json'));
    await mkdir(join(seat.home, '.grok'));
    await writeFile(join(seat.home, '.grok', 'config.toml'), '[mcp_servers.sam]\ncommand="node"\n');
    await expect(grok.spawn('hello', context(seat, { _spawnImpl: spawn })))
      .rejects.toThrow('inherited MCP servers');
    expect(spawn).not.toHaveBeenCalled();
  });
});

test('never replaces a pre-existing project Grok config', async () => {
  await withSeat(async (seat) => {
    await mkdir(join(seat.cwd, '.grok'));
    await writeFile(join(seat.cwd, '.grok', 'config.toml'), '[mcp_servers.sam]\ncommand="node"\n');
    await expect(grok.spawn('hello', context(seat, { _spawnImpl: jest.fn() })))
      .rejects.toThrow('refuses to replace');
    expect(await readFile(join(seat.cwd, '.grok', 'config.toml'), 'utf8'))
      .toContain('[mcp_servers.sam]');
  });
});

test('rejects provider declarations so login cannot silently switch to a key', async () => {
  await expect(grok.validateEnvironment({ provider: { id: 'xai', keyFile: '/tmp/key' } }))
    .rejects.toThrow('operator grok login');
});
