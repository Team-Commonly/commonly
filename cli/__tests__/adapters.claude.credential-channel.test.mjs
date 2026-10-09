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
import { execFileSync } from 'node:child_process';
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

/**
 * The value the LAUNCHER exported for bootstrap — a different token from the one
 * this spawn mints, so an assertion can tell which of the two it found.
 *
 * It is planted in the spawn environment rather than inherited from the runner:
 * these tests passed in a runner without `COMMONLY_AGENT_TOKEN` and failed in one
 * with it, which means the leak they were written to prevent was decided by the
 * runner (Vera, 70455). An explicit value makes the assertion the same one
 * everywhere, and makes it stronger — the value has to be absent, not merely
 * coincidentally unset.
 */
const LAUNCHER_TOKEN = 'cm_agent_'.padEnd(73, 'L');
// A path this launcher did not mint stands in for the runner's own, which is what
// a seat process actually carries. Without it these assertions would be decided
// by whatever the runner happened to export — the no-minted-token case below is
// the one that failed in a seat-run suite and passed in CI. Planted for the same
// reason as the token above (Vera, 70455): the assertion has to be the same one
// in every runner, and its stronger form is that the foreign path is REMOVED.
const FOREIGN_FILE = path.join(os.tmpdir(), 'another-spawn', 'token');
const spawnEnv = () => ({
  ...process.env,
  COMMONLY_AGENT_TOKEN: LAUNCHER_TOKEN,
  COMMONLY_TOKEN_FILE: FOREIGN_FILE,
});

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

const captureImpl = ({ onSpawn } = {}) => {
  const calls = [];
  const impl = (cmd, args, opts) => {
    const i = args.indexOf('--mcp-config');
    const configPath = i === -1 ? null : args[i + 1];
    const config = configPath ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null;
    const declared = config?.mcpServers?.commonly?.env || {};
    const fileVar = declared.COMMONLY_TOKEN_FILE;
    const hasHeadersHelper = Object.values(config?.mcpServers || {})
      .some((entry) => typeof entry.headersHelper === 'string');
    const resolved = (fileVar || hasHeadersHelper) && opts.env?.['COMMONLY_TOKEN_FILE'];
    const call = {
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
    };
    calls.push(call);
    if (onSpawn) onSpawn(call);
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
    env: spawnEnv(),
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
    // The launcher's bootstrap export is in the spawn environment (spawnEnv) and
    // must still be gone from the runtime's — the declaration rewrite alone never
    // removed it.
    expect(call.tokenInEnv).toBeUndefined();
    expect(call.env.COMMONLY_TOKEN_FILE).toBe(call.resolvedFile);
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

  test('a declaration that asks for no credential is untouched, and the path is still there for a hook', async () => {
    const call = await spawnWith(declaration({ COMMONLY_API_URL: '${COMMONLY_API_URL}' }));
    // The DECLARATION is what must stay untouched: no entry asked for the
    // credential, so none was rewritten.
    expect(call.declared).toEqual({ COMMONLY_API_URL: '${COMMONLY_API_URL}' });
    // The runtime environment is a different surface with a different rule: the
    // PATH goes in for every spawn that minted a file, because a hook child
    // resolves its credential from it, and the VALUE never does. The location
    // rule is the same one the credential file itself obeys — the per-spawn
    // --mcp-config directory — because that is the one path a confined seat may
    // read (sandbox/seatbelt.js).
    expect(call.env.COMMONLY_TOKEN_FILE).toMatch(/\/token$/);
    expect(call.env.COMMONLY_TOKEN_FILE.startsWith(path.dirname(call.configPath))).toBe(true);
    expect(call.env.COMMONLY_AGENT_TOKEN).toBeUndefined();
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

  test('no runtime token means no file var, even one this spawn inherited', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-claude-nocred-'));
    const { calls, impl } = captureImpl();
    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      runtimeToken: undefined,
      environment: { mcp: declaration({ COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' }) },
      env: spawnEnv(),
      _spawnImpl: impl,
    });
    // Nothing to point at ⇒ rewritten to nothing would be a path to nowhere, so
    // the value placeholder stays and is simply unresolvable — the pre-existing
    // behaviour for a seat with no minted token.
    expect(calls[0].declared.COMMONLY_AGENT_TOKEN).toBe('${COMMONLY_AGENT_TOKEN}');
    expect(calls[0].env.COMMONLY_TOKEN_FILE).toBeUndefined();
    // FOREIGN_FILE is the runner's own credential file, so this is not "the
    // runner was clean" but "a path this spawn did not mint is removed".
  });
});

describe('claude: HTTP token headers use the per-spawn credential file (TASK-228)', () => {
  const spawnWithImpl = async (mcp, onSpawn) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-claude-carve-'));
    const { calls, impl } = captureImpl({ onSpawn });
    let warned = [];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await claude.spawn('hi', {
        sessionId: null,
        cwd,
        runtimeToken: TOKEN,
        instanceUrl: 'https://api.commonly.me',
        environment: { mcp },
        env: spawnEnv(),
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

  const runHeadersHelper = (call, serverName = 'github-grant') => {
    const command = call.config.mcpServers[serverName].headersHelper;
    return JSON.parse(execFileSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      env: call.env,
    }));
  };

  test('a broker header uses a helper and keeps the token out of Claude env and MCP config', async () => {
    let headers;
    const { call, warned } = await spawnWithImpl([{
      name: 'github-grant',
      transport: 'http',
      url: 'https://api.commonly.me/api/mcp/grants/grant-live',
      headers: {
        Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}',
        'X-Commonly-Instance': 'prod',
      },
    }], (spawnCall) => { headers = runHeadersHelper(spawnCall); });
    const entry = call.config.mcpServers['github-grant'];
    expect(call.tokenInEnv).toBeUndefined();
    expect(Object.keys(call.env)).not.toContain('COMMONLY_AGENT_TOKEN');
    expect(call.env.COMMONLY_TOKEN_FILE).toBe(call.resolvedFile);
    expect(entry.headers).toEqual({ 'X-Commonly-Instance': 'prod' });
    expect(entry.headersHelper).toContain(path.dirname(call.configPath));
    expect(JSON.stringify(call.config)).not.toContain('${COMMONLY_AGENT_TOKEN}');
    expect(JSON.stringify(call.config)).not.toContain(TOKEN);
    expect(warned.join('\n')).not.toMatch(/COMMONLY_AGENT_TOKEN/);
    expect(headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  test('a 401 retry reruns the helper and reads a rotated token during one spawn', async () => {
    const rotated = 'cm_agent_'.padEnd(73, 'R');
    const headers = [];
    const statuses = [];
    await spawnWithImpl([{
      name: 'github-grant',
      transport: 'http',
      url: 'https://api.commonly.me/api/mcp/grants/grant-live',
      headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
    }], (call) => {
      const fakeBroker = (requestHeaders) => {
        if (requestHeaders.Authorization === `Bearer ${rotated}`) return 200;
        if (requestHeaders.Authorization === `Bearer ${TOKEN}`) return 401;
        return 500;
      };
      headers.push(runHeadersHelper(call));
      // Model Claude's documented auth retry: the connection's existing
      // headers get one stale-token response, then the helper runs again.
      statuses.push(fakeBroker(headers[0]));
      fs.writeFileSync(call.resolvedFile, rotated, { mode: 0o600 });
      fs.chmodSync(call.resolvedFile, 0o600);
      headers.push(runHeadersHelper(call));
      statuses.push(fakeBroker(headers[1]));
    });
    expect(headers).toEqual([
      { Authorization: `Bearer ${TOKEN}` },
      { Authorization: `Bearer ${rotated}` },
    ]);
    expect(statuses).toEqual([401, 200]);
  });

  test('streamable HTTP headers use the helper while unrelated HTTP headers stay static', async () => {
    let headers;
    const { call } = await spawnWithImpl([{
      name: 'github-grant',
      transport: 'streamable-http',
      url: 'https://api.commonly.me/api/mcp/grants/grant-live',
      headers: {
        Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}',
        'X-Commonly-Instance': 'prod',
      },
    }], (spawnCall) => { headers = runHeadersHelper(spawnCall); });
    expect(call.config.mcpServers['github-grant'].headers).toEqual({ 'X-Commonly-Instance': 'prod' });
    expect(headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  test('an embedded reference in an env value remains on the literal expansion path', async () => {
    const { call } = await spawnWithImpl([{
      name: 'commonly',
      transport: 'stdio',
      command: ['npx', '-y', '@commonlyai/mcp@latest'],
      env: { NOTE: 'prefix-${COMMONLY_AGENT_TOKEN}' },
    }]);
    expect(call.tokenInEnv).toBe(TOKEN);
    expect(call.declared.NOTE).toBe('prefix-${COMMONLY_AGENT_TOKEN}');
  });

  test('stdio and HTTP credential declarations both use the file, never the Claude env', async () => {
    let headers;
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
    ], (spawnCall) => { headers = runHeadersHelper(spawnCall); });
    // The stdio child reads the file through its env declaration; the HTTP
    // connection's helper reads that same per-spawn file when Claude invokes it.
    expect(call.declared.COMMONLY_TOKEN_FILE).toBe('${COMMONLY_TOKEN_FILE}');
    expect(call.declared.COMMONLY_AGENT_TOKEN).toBeUndefined();
    expect(call.tokenInEnv).toBeUndefined();
    expect(call.env.COMMONLY_TOKEN_FILE).toBe(call.resolvedFile);
    expect(headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });
});
