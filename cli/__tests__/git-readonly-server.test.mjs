/**
 * The workspace_git MCP server (TASK-294): the handler in isolation, and the
 * whole server driven over a real stdio pipe via connectStdioMcp — the same
 * client the pi bridge uses — so the transport the claude adapter will spawn is
 * exercised end to end.
 */
import {
  afterAll, beforeAll, describe, expect, test,
} from '@jest/globals';
import { execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { connectStdioMcp, toPiResult } from '../src/lib/adapters/pi-mcp-client.mjs';
import {
  GIT_TOOL, SERVER_NAME, TOOL_NAME, createGitServerHandler, parseServerArgs,
} from '../src/lib/git-readonly-server.js';

const execFileAsync = promisify(execFile);
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'git-readonly-server.js');

let repo;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'git-ro-srv-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, env });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo, env });
  writeFileSync(join(repo, 'tracked.txt'), 'hello\n');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repo, env });
  await execFileAsync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo, env });
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('the JSON-RPC handler', () => {
  const handler = () => createGitServerHandler({ root: repo, git: 'git' });

  test('initialize echoes a supported protocol and advertises tools', async () => {
    const res = await handler()({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' },
    });
    expect(res.result.protocolVersion).toBe('2024-11-05');
    expect(res.result.capabilities.tools).toBeDefined();
    expect(res.result.serverInfo.name).toBe(SERVER_NAME);
  });

  test('an unknown requested protocol falls back to a supported one', async () => {
    const res = await handler()({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' },
    });
    expect(res.result.protocolVersion).toBe('2024-11-05');
  });

  test('tools/list returns the single git tool', async () => {
    const res = await handler()({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.result.tools).toHaveLength(1);
    expect(res.result.tools[0].name).toBe(TOOL_NAME);
    expect(res.result.tools[0].inputSchema.properties.subcommand.enum).toContain('status');
  });

  test('a notification (no id) gets no response', async () => {
    expect(await handler()({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  test('ping is answered; an unknown method is a JSON-RPC error', async () => {
    expect((await handler()({ jsonrpc: '2.0', id: 3, method: 'ping' })).result).toEqual({});
    const err = await handler()({ jsonrpc: '2.0', id: 4, method: 'nope' });
    expect(err.error.code).toBe(-32601);
  });

  test('tools/call runs a read-only subcommand and returns its text', async () => {
    const res = await handler()({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: TOOL_NAME, arguments: { subcommand: 'log', args: ['--oneline'] } },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toMatch(/seed/);
  });

  test('tools/call surfaces a refusal as an error result, not a throw', async () => {
    const res = await handler()({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: TOOL_NAME, arguments: { subcommand: 'diff', args: ['--output=/tmp/x'] } },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/--output/);
  });

  test('an unknown tool name is rejected', async () => {
    const res = await handler()({
      jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'rm', arguments: {} },
    });
    expect(res.error.code).toBe(-32602);
  });
});

describe('parseServerArgs', () => {
  test('resolves --root to a real directory and defaults --git', () => {
    const parsed = parseServerArgs(['--root', repo]);
    expect(parsed.git).toBe('git');
    expect(parsed.root.length).toBeGreaterThan(0);
  });

  test('refuses a missing or relative root', () => {
    expect(() => parseServerArgs([])).toThrow(/--root/);
    expect(() => parseServerArgs(['--root', 'relative'])).toThrow(/--root/);
  });
});

describe('over a real stdio pipe (connectStdioMcp)', () => {
  test('initialize, list the tool, call it, and refuse a write — end to end', async () => {
    const client = connectStdioMcp({
      name: SERVER_NAME,
      command: ['node', SERVER, '--root', repo, '--git', 'git'],
      env: {},
    });
    try {
      const init = await client.initialize();
      expect(init.serverInfo.name).toBe(SERVER_NAME);

      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([TOOL_NAME]);
      expect(tools[0].description).toContain(GIT_TOOL.name);

      const ok = await client.callTool(TOOL_NAME, { subcommand: 'status', args: ['--short'] });
      expect(toPiResult(ok).details.isError).toBeFalsy();

      const denied = await client.callTool(TOOL_NAME, { subcommand: 'diff', args: ['--output=/tmp/x'] });
      const piDenied = toPiResult(denied);
      expect(piDenied.details.isError).toBe(true);
      expect(piDenied.content[0].text).toMatch(/--output/);
    } finally {
      client.close();
    }
  });
});
