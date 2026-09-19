/**
 * adapters.claude.credential-channel.test.mjs — TASK-083
 *
 * The claude seat's MCP servers are spawned inside claude's own process tree, so
 * the credential cannot ride an inherited pipe the way the pi bridge delivers
 * it. What claude hands over instead is the PATH of a per-spawn 0600 file, and
 * these tests assert the two halves of that: the config claude actually reads
 * names the file, and claude's environment never carries the value.
 *
 * The file's LOCATION is part of the contract, not an implementation detail.
 * sandbox/seatbelt.js admits exactly one path outside the workspace to a
 * confined seat — the per-spawn --mcp-config directory — so a credential file
 * written anywhere else is unreadable by the child it was written for, and the
 * seat would lose its tools instead of its token.
 *
 * Uses ctx._spawnImpl (the sanctioned test seam) so no real claude runs, and
 * inspects the config at spawn time, before the adapter's finally removes it.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import fs from 'fs';

await jest.unstable_mockModule('child_process', () => ({
  spawnSync: jest.fn(),
  spawn: jest.fn(),
}));

const claude = (await import('../src/lib/adapters/claude.js')).default;

const TOKEN = 'cm_agent_'.padEnd(73, 'x');

const fakeChild = ({ stdout = '', code = 0 } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', code);
  }, 0);
  return proc;
};

const captureImpl = () => {
  const calls = [];
  const impl = (cmd, args, opts) => {
    const i = args.indexOf('--mcp-config');
    const configPath = i === -1 ? null : args[i + 1];
    const config = configPath ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null;
    const declared = config?.mcpServers?.commonly?.env || {};
    const fileVar = declared.COMMONLY_TOKEN_FILE;
    const resolved = fileVar && opts.env?.['COMMONLY_TOKEN_FILE'];
    calls.push({
      cmd,
      args,
      env: opts.env,
      configPath,
      config,
      declared,
      resolvedFile: typeof resolved === 'string' && !resolved.startsWith('${') ? resolved : null,
      tokenInEnv: opts.env?.['COMMONLY_AGENT_TOKEN'],
      fileText: resolved && fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : null,
      fileMode: resolved && fs.existsSync(resolved) ? fs.statSync(resolved).mode & 0o777 : null,
    });
    return fakeChild({ stdout: 'ok', code: 0 });
  };
  return { calls, impl };
};

const declaration = (env) => ([{
  name: 'commonly',
  transport: 'stdio',
  command: ['npx', '-y', '@commonlyai/mcp@latest'],
  env,
}]);

const spawnWith = async (mcp, extra = {}) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-claude-cred-cwd-'));
  const { calls, impl } = captureImpl();
  await claude.spawn('hi', {
    sessionId: null,
    cwd,
    runtimeToken: TOKEN,
    instanceUrl: 'https://api.commonly.me',
    agentName: 'kai-test',
    environment: { mcp },
    _spawnImpl: impl,
    ...extra,
  });
  return calls[0];
};

describe('claude: the seat credential arrives as a path, never as a value (TASK-083)', () => {
  test('a declaration naming the token variable is rewritten to the file variable', async () => {
    const call = await spawnWith(declaration({
      COMMONLY_API_URL: '${COMMONLY_API_URL}',
      COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}',
    }));
    expect(call.declared.COMMONLY_AGENT_TOKEN).toBeUndefined();
    expect(call.declared.COMMONLY_TOKEN_FILE).toBe('${COMMONLY_TOKEN_FILE}');
    expect(call.declared.COMMONLY_API_URL).toBe('${COMMONLY_API_URL}');
  });

  test("claude's own environment never carries the value, and does carry the path", async () => {
    const call = await spawnWith(declaration({ COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' }));
    expect(call.tokenInEnv).toBeUndefined();
    expect(typeof call.env.COMMONLY_TOKEN_FILE).toBe('string');
    expect(call.env.COMMONLY_TOKEN_FILE).toMatch(/^\//);
  });

  test('the file holds this spawn credential, at 0600, inside the config directory', async () => {
    const call = await spawnWith(declaration({ COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' }));
    expect(call.fileText).toBe(TOKEN);
    expect(call.fileMode).toBe(0o600);
    // The location rule, asserted rather than assumed: the config directory is
    // the one non-workspace path a confined seat may read.
    expect(call.resolvedFile.startsWith(path.dirname(call.configPath))).toBe(true);
  });

  test('the file is gone once the turn is over', async () => {
    const call = await spawnWith(declaration({ COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' }));
    expect(call.resolvedFile).not.toContain('${');
    expect(fs.existsSync(call.resolvedFile)).toBe(false);
    expect(fs.existsSync(path.dirname(call.configPath))).toBe(false);
  });

  test('each spawn mints its own file, so one seat cannot name another turn credential', async () => {
    const first = await spawnWith(declaration({ COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' }));
    const second = await spawnWith(declaration({ COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' }));
    expect(first.resolvedFile).not.toBe(second.resolvedFile);
  });

  test('a declaration that asks for no credential is untouched', async () => {
    const call = await spawnWith(declaration({ COMMONLY_API_URL: '${COMMONLY_API_URL}' }));
    expect(call.declared).toEqual({ COMMONLY_API_URL: '${COMMONLY_API_URL}' });
    expect(call.env.COMMONLY_TOKEN_FILE).toBeUndefined();
  });

  test("another vendor's server keeps its declaration when no credential is declared", async () => {
    const call = await spawnWith([
      { name: 'playwright', transport: 'stdio', command: ['npx', '-y', '@playwright/mcp@latest'], env: { KEEP: 'me' } },
      { name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'], env: { COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' } },
    ]);
    const playwright = call.config.mcpServers.playwright;
    expect(playwright.env).toEqual({ KEEP: 'me' });
    expect(call.config.mcpServers.commonly.env.COMMONLY_TOKEN_FILE).toBe('${COMMONLY_TOKEN_FILE}');
  });

  test('no runtime token means no file, and the declaration is left as it was', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-claude-nocred-'));
    const { calls, impl } = captureImpl();
    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      runtimeToken: undefined,
      environment: { mcp: declaration({ COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' }) },
      _spawnImpl: impl,
    });
    // Nothing to point at ⇒ rewritten to nothing would be a path to nowhere, so
    // the value placeholder stays and is simply unresolvable — the pre-existing
    // behaviour for a seat with no minted token.
    expect(calls[0].declared.COMMONLY_AGENT_TOKEN).toBe('${COMMONLY_AGENT_TOKEN}');
    expect(calls[0].env.COMMONLY_TOKEN_FILE).toBeUndefined();
  });
});

describe('claude: the carve-out for a reference the rewrite cannot move (TASK-082/TASK-083)', () => {
  const spawnWithImpl = async (mcp) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-claude-carve-'));
    const { calls, impl } = captureImpl();
    let warned = [];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await claude.spawn('hi', {
        sessionId: null,
        cwd,
        runtimeToken: TOKEN,
        instanceUrl: 'https://api.commonly.me',
        environment: { mcp },
        _spawnImpl: impl,
      });
    } finally {
      // Read the calls BEFORE restoring: mockRestore resets the mock's recorded
      // calls, so a warning asserted after it reads as an empty list.
      warned = warn.mock.calls.map((c) => c.join(' '));
      warn.mockRestore();
    }
    return { call: calls[0], warned };
  };

  test('a header reference keeps the value in the environment, and the seat is told', async () => {
    // Measured shape, and the reason this carve-out exists at all: an HTTP entry
    // hands claude a header string to substitute. There is no file channel for a
    // bearer header, so refusing would take the broker away from every seat that
    // has one. The value is supplied, and the warning names the trade.
    const { call, warned } = await spawnWithImpl([{
      name: 'github-grant',
      transport: 'http',
      url: 'https://api.commonly.me/api/mcp/grants/grant-live',
      headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
    }]);
    expect(call.tokenInEnv).toBe(TOKEN);
    expect(call.config.mcpServers['github-grant'].headers.Authorization).toBe('Bearer ${COMMONLY_AGENT_TOKEN}');
    expect(warned.join('\n')).toMatch(/Put the credential on the entry's env to get the file channel/);
  });

  test('an embedded reference in an env value also keeps the value', async () => {
    const { call } = await spawnWithImpl([{
      name: 'commonly',
      transport: 'stdio',
      command: ['npx', '-y', '@commonlyai/mcp@latest'],
      env: { NOTE: 'prefix-${COMMONLY_AGENT_TOKEN}' },
    }]);
    expect(call.tokenInEnv).toBe(TOKEN);
    expect(call.declared.NOTE).toBe('prefix-${COMMONLY_AGENT_TOKEN}');
  });

  test('both channels at once: the env entry moves to the file, the header still needs the value', async () => {
    const { call } = await spawnWithImpl([
      {
        name: 'commonly',
        transport: 'stdio',
        command: ['npx', '-y', '@commonlyai/mcp@latest'],
        env: { COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' },
      },
      {
        name: 'github-grant',
        transport: 'http',
        url: 'https://api.commonly.me/api/mcp/grants/grant-live',
        headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
      },
    ]);
    // Our own server stops depending on the value even in the spawn that still
    // needs it for the header — the two decisions are per declaration.
    expect(call.declared.COMMONLY_TOKEN_FILE).toBe('${COMMONLY_TOKEN_FILE}');
    expect(call.declared.COMMONLY_AGENT_TOKEN).toBeUndefined();
    expect(call.tokenInEnv).toBe(TOKEN);
  });
});
