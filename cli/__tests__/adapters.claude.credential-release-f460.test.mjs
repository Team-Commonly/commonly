/**
 * F460 on Claude. A public Claude seat's runtime credential file is deleted
 * once our Commonly server has written its ready file (in the seat's state
 * folder, which the jail writes), or at the deadline. A delete that fails ends
 * the turn. The fresh-session retry gets the credential back at the path its
 * config names, and loses it again once its servers are ready. F461: a turn
 * with a headersHelper (an HTTP broker) loses the file too, because its helper
 * asks the adapter over a socket in the spawn's folder; Windows, where that
 * would be a named pipe, keeps the file.
 */
import { jest } from '@jest/globals';
import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

await jest.unstable_mockModule('child_process', () => ({
  spawnSync: jest.fn(),
  spawn: jest.fn(),
}));
const { default: claude } = await import('../src/lib/adapters/claude.js');
const { spawnSync } = await import('child_process');

const COMMONLY_MCP = {
  name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'],
  env: { COMMONLY_API_URL: '${COMMONLY_API_URL}', COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' },
};
const BROKER = {
  name: 'commonly-grant-broker', transport: 'http',
  url: 'https://api.example.test/api/mcp/grants/g1',
  headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
};
const stdoutFor = (text) => [
  { type: 'system', subtype: 'init', mcp_servers: [{ name: 'commonly', status: 'connected' }] },
  { type: 'result', subtype: 'success', is_error: false, result: text },
].map((event) => JSON.stringify(event)).join('\n');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// Runs a headersHelper as Claude does, through a shell with Claude's env. Async:
// the channel it asks is served from this same process.
const runHelper = async (command, env) => {
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', command], { env, encoding: 'utf8' });
  return JSON.parse(stdout);
};
const channelOf = (command) => command.match(/'([^']*headers\.sock)'/)?.[1];

// A Claude whose Commonly server writes its ready file (or not), then answers
// after `turnMs`. Each spawn records whether the credential existed at its
// start and at its end. `fail` makes a spawn exit 1 with that stderr.
const fakeClaude = ({ writeReady = true, turnMs = 300, fail = () => null } = {}) => {
  const runs = [];
  const impl = (_cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn(() => { setTimeout(() => proc.emit('close', null, 'SIGKILL'), 5); });
    const config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
    const env = config.mcpServers.commonly?.env || {};
    const run = {
      tokenFile: String(env.COMMONLY_TOKEN_FILE || '').replace(/^\$\{COMMONLY_TOKEN_FILE\}$/, opts.env?.COMMONLY_TOKEN_FILE || '') || undefined,
      readyFile: env.COMMONLY_MCP_READY_FILE,
      headersHelper: Boolean(config.mcpServers['commonly-grant-broker']?.headersHelper),
    };
    const helper = config.mcpServers['commonly-grant-broker']?.headersHelper;
    run.atStart = Boolean(run.tokenFile && fs.existsSync(run.tokenFile));
    runs.push(run);
    const failure = fail(runs.length);
    setTimeout(async () => {
      if (writeReady && run.readyFile) fs.writeFileSync(run.readyFile, 'ready\n', { flag: 'wx' });
      await sleep(turnMs);
      run.atEnd = Boolean(run.tokenFile && fs.existsSync(run.tokenFile));
      // A reconnect late in the turn, after the file is gone.
      if (helper) {
        run.helperCommand = helper;
        run.headers = await runHelper(helper, opts.env).catch((err) => ({ error: String(err.message) }));
      }
      if (proc.kill.mock.calls.length) return;
      if (failure) {
        proc.stderr.emit('data', Buffer.from(failure));
        proc.emit('close', 1);
        return;
      }
      proc.stdout.emit('data', Buffer.from(stdoutFor('Here you go.')));
      proc.emit('close', 0);
    }, 10);
    return proc;
  };
  return { impl, runs };
};

let cwd;
let mcpHome;
let publicState;
let prior;
const originalPlatform = process.platform;
const warmBuild = ({ readyFile }) => {
  const pkgDir = path.join(mcpHome, '0.3.20', 'node_modules', '@commonlyai', 'mcp');
  fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: '@commonlyai/mcp', version: '0.3.20', bin: { 'commonly-mcp': 'src/index.js' },
    ...(readyFile ? { commonly: { readyFile: true } } : {}),
  }));
  fs.writeFileSync(path.join(pkgDir, 'src', 'index.js'), '');
  fs.writeFileSync(path.join(mcpHome, 'current'), '0.3.20\n');
  fs.writeFileSync(path.join(mcpHome, '.registry.json'), JSON.stringify({ version: '0.3.20', checkedAt: Date.now() }));
  fs.writeFileSync(path.join(mcpHome, '.warm.lock'), 'warming\n');
};

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f460-ws-'));
  publicState = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f460-state-'));
  mcpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f460-mcp-'));
  prior = process.env.COMMONLY_MCP_HOME;
  process.env.COMMONLY_MCP_HOME = mcpHome;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  spawnSync.mockImplementation((cmd) => (cmd === 'which'
    ? { status: 0, stdout: '/usr/bin/true\n' } : { status: 0, stdout: '' }));
});
afterEach(() => {
  if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
  else process.env.COMMONLY_MCP_HOME = prior;
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  spawnSync.mockReset();
  for (const dir of [cwd, publicState, mcpHome]) fs.rmSync(dir, { recursive: true, force: true });
});

const turn = (fake, {
  trust = 'public', mcp = [COMMONLY_MCP], sessionId, extra = {},
} = {}) => claude.spawn('hi', {
  agentName: 'public-test', cwd, ...(sessionId ? { sessionId } : {}),
  runtimeToken: 'cm_agent_f460_claude_token',
  instanceUrl: 'https://api.example.test',
  env: { PATH: process.env.PATH, USER: 'safe-user', LOGNAME: 'safe-user' },
  environment: { model: 'test-model', ...(trust ? { sandbox: { mode: 'workspace', trust } } : {}), mcp },
  _publicClaudeState: publicState,
  _spawnImpl: fake.impl,
  ...extra,
});

describe('a public Claude seat', () => {
  test('the credential is gone once the Commonly server has written its ready file', async () => {
    warmBuild({ readyFile: true });
    const fake = fakeClaude();
    await expect(turn(fake)).resolves.toMatchObject({ text: 'Here you go.' });
    const [run] = fake.runs;
    expect(run.readyFile.startsWith(path.join(publicState, 'mcp-ready', ''))).toBe(true);
    expect(run).toMatchObject({ atStart: true, atEnd: false });
    // The ready file is this spawn's, and goes with it.
    expect(fs.existsSync(run.readyFile)).toBe(false);
  });

  test('a server that never gets ready: the credential still goes, at the deadline', async () => {
    warmBuild({ readyFile: true });
    const fake = fakeClaude({ writeReady: false, turnMs: 400 });
    const warn = jest.fn();
    await turn(fake, { extra: { _credentialRelease: { deadlineMs: 100, warn } } });
    expect(fake.runs[0]).toMatchObject({ atStart: true, atEnd: false });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/public Claude seat: MCP servers not ready .*deleted anyway/));
  });

  test('a delete that fails ends the turn, with no fresh-session retry', async () => {
    warmBuild({ readyFile: true });
    const fake = fakeClaude();
    await expect(turn(fake, {
      sessionId: 'abc-123',
      extra: {
        _credentialRelease: {
          fs: { rmSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }, existsSync: fs.existsSync },
        },
      },
    })).rejects.toThrow(/could not delete its runtime credential.*EPERM/);
    expect(fake.runs).toHaveLength(1);
  });

  test('the fresh-session retry gets the credential back, and loses it again once ready', async () => {
    warmBuild({ readyFile: true });
    const fake = fakeClaude({ fail: (n) => (n === 1 ? 'Error: Session ID abc-123 is already in use.' : null) });
    await expect(turn(fake, { sessionId: 'abc-123' })).resolves.toMatchObject({ text: 'Here you go.' });
    expect(fake.runs).toHaveLength(2);
    // Same config, same paths: the retry's server reads the credential again.
    expect(fake.runs[1].tokenFile).toBe(fake.runs[0].tokenFile);
    expect(fake.runs[0]).toMatchObject({ atStart: true, atEnd: false });
    expect(fake.runs[1]).toMatchObject({ atStart: true, atEnd: false });
  });

  // F461.
  test('a turn with an HTTP broker loses the file too; its helper still gets the token after', async () => {
    warmBuild({ readyFile: true });
    const fake = fakeClaude();
    await expect(turn(fake, { mcp: [COMMONLY_MCP, BROKER] })).resolves.toMatchObject({ text: 'Here you go.' });
    const [run] = fake.runs;
    expect(run.headersHelper).toBe(true);
    expect(run).toMatchObject({ atStart: true, atEnd: false });
    expect(run.headers).toEqual({ Authorization: 'Bearer cm_agent_f460_claude_token' });
    // The token rides no argument, and the channel ends with the turn.
    expect(run.helperCommand).not.toContain('cm_agent_f460_claude_token');
    const socket = channelOf(run.helperCommand);
    expect(socket).toEqual(expect.any(String));
    expect(fs.existsSync(socket)).toBe(false);
    await expect(runHelper(run.helperCommand, {})).rejects.toThrow();
  });

  test('the channel is a 0600 socket in the spawn\'s 0700 folder, which a file read cannot open', async () => {
    warmBuild({ readyFile: true });
    let seen = null;
    const fake = fakeClaude();
    const impl = (cmd, args, opts) => {
      const config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
      const socket = channelOf(config.mcpServers['commonly-grant-broker'].headersHelper);
      const stat = fs.statSync(socket);
      let readError = null;
      try { fs.readFileSync(socket); } catch (err) { readError = err.code; }
      seen = {
        socket: stat.isSocket(),
        mode: stat.mode & 0o777,
        dirMode: fs.statSync(path.dirname(socket)).mode & 0o777,
        readError,
      };
      return fake.impl(cmd, args, opts);
    };
    await turn({ impl, runs: fake.runs }, { mcp: [COMMONLY_MCP, BROKER] });
    expect(seen).toMatchObject({ socket: true, mode: 0o600, dirMode: 0o700 });
    expect(seen.readError).toEqual(expect.any(String));
  });

  test('a broker-only turn has no stdio reader, so the file goes before Claude starts', async () => {
    warmBuild({ readyFile: true });
    const fake = fakeClaude();
    const seen = [];
    const impl = (cmd, args, opts) => {
      const config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
      const helper = config.mcpServers['commonly-grant-broker'].headersHelper;
      const credentialDirs = fs.readdirSync(path.dirname(channelOf(helper)))
        .filter((name) => name.startsWith('public-test-'));
      seen.push(credentialDirs.length);
      return fake.impl(cmd, args, opts);
    };
    await turn({ impl, runs: fake.runs }, { mcp: [BROKER] });
    expect(seen).toEqual([0]);
    expect(fake.runs[0].headers).toEqual({ Authorization: 'Bearer cm_agent_f460_claude_token' });
  });

  test('the fresh-session retry\'s helper still gets the token from the same channel', async () => {
    warmBuild({ readyFile: true });
    const fake = fakeClaude({ fail: (n) => (n === 1 ? 'Error: Session ID abc-123 is already in use.' : null) });
    await turn(fake, { sessionId: 'abc-123', mcp: [COMMONLY_MCP, BROKER] });
    expect(fake.runs).toHaveLength(2);
    for (const run of fake.runs) {
      expect(run).toMatchObject({ atStart: true, atEnd: false });
      expect(run.headers).toEqual({ Authorization: 'Bearer cm_agent_f460_claude_token' });
    }
  });

  test('reverse: on Windows the broker keeps reading the file, which stays for the turn', async () => {
    warmBuild({ readyFile: true });
    const fake = fakeClaude();
    await turn(fake, { mcp: [COMMONLY_MCP, BROKER], extra: { hostUnconfined: true, _platform: 'win32' } });
    const [run] = fake.runs;
    expect(channelOf(run.helperCommand)).toBeUndefined();
    expect(run).toMatchObject({ atStart: true, atEnd: true });
    expect(run.headers).toEqual({ Authorization: 'Bearer cm_agent_f460_claude_token' });
  });

  // Opus review HOLD 1: a policy-only Windows host prepares no state folder and
  // runs MCP children unjailed; the ready files go in a folder of the turn's own.
  test('on a policy-only host the credential still goes once ready, from a folder of the turn\'s own', async () => {
    warmBuild({ readyFile: true });
    const fake = fakeClaude();
    await turn(fake, { extra: { hostUnconfined: true, _platform: 'win32' } });
    const [run] = fake.runs;
    expect(run.readyFile).toEqual(expect.stringContaining('commonly-claude-ready-'));
    expect(run).toMatchObject({ atStart: true, atEnd: false });
    expect(fs.existsSync(path.dirname(run.readyFile))).toBe(false);
  });

  test('a warm build from before ready files is refused before Claude runs', async () => {
    warmBuild({ readyFile: false });
    const fake = fakeClaude();
    await expect(turn(fake)).rejects.toThrow(/update @commonlyai\/mcp/);
    expect(fake.runs).toHaveLength(0);
  });
});

test('reverse: a private seat names no ready file and keeps its credential for the turn', async () => {
  warmBuild({ readyFile: true });
  const fake = fakeClaude();
  await turn(fake, { trust: null });
  expect(fake.runs[0].readyFile).toBeUndefined();
  expect(fake.runs[0]).toMatchObject({ atStart: true, atEnd: true });
});

test('reverse: a private seat\'s broker helper reads the file, with no channel', async () => {
  warmBuild({ readyFile: true });
  const fake = fakeClaude();
  await turn(fake, { trust: null, mcp: [COMMONLY_MCP, BROKER] });
  const [run] = fake.runs;
  expect(channelOf(run.helperCommand)).toBeUndefined();
  expect(run).toMatchObject({ atStart: true, atEnd: true });
  expect(run.headers).toEqual({ Authorization: 'Bearer cm_agent_f460_claude_token' });
});
