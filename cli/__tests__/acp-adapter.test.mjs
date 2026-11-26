/**
 * acp-adapter.test.mjs — the `acp` adapter for private seats, driven through a
 * real child: the scripted fake agent in fixtures/fake-acp-turn-agent.cjs.
 */

import { jest } from '@jest/globals';
import { spawn as childSpawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import acp from '../src/lib/adapters/acp.js';
import { getAdapter, listAdapterNames, listPublicAdapterNames } from '../src/lib/adapters/index.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-turn-agent.cjs');
const TOKEN = 'cm_agent_SECRET_runtime_token_0123456789abcdef';
const INSTANCE = 'https://commonly.example.test';

let root;
let mcpHome;
let priorMcpHome;
let warn;
let error;
let info;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acp-adapter-test-'));
  // A prepared MCP home, so the Commonly server resolves to `node <bin>` with
  // no npx and no network. The held warm lock keeps a real warm from starting.
  mcpHome = join(root, 'mcp-home');
  const pkgDir = join(mcpHome, '0.3.13', 'node_modules', '@commonlyai', 'mcp');
  mkdirSync(join(pkgDir, 'src'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': 'src/index.js' },
  }));
  writeFileSync(join(pkgDir, 'src', 'index.js'), '');
  writeFileSync(join(mcpHome, 'current'), '0.3.13\n');
  writeFileSync(join(mcpHome, '.warm.lock'), 'warming\n');
  priorMcpHome = process.env.COMMONLY_MCP_HOME;
  process.env.COMMONLY_MCP_HOME = mcpHome;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  error = jest.spyOn(console, 'error').mockImplementation(() => {});
  info = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  info.mockRestore();
  if (priorMcpHome === undefined) delete process.env.COMMONLY_MCP_HOME;
  else process.env.COMMONLY_MCP_HOME = priorMcpHome;
  rmSync(root, { recursive: true, force: true });
});

const commonlyServer = () => ({
  name: 'commonly',
  transport: 'stdio',
  command: ['npx', '-y', '@commonlyai/mcp@latest'],
  env: { COMMONLY_API_URL: '${COMMONLY_API_URL}', COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' },
});

// One turn against the fake agent. Returns the outcome, what the agent saw,
// every child spawned, and every log line the adapter wrote anywhere.
const runTurn = async (scenario, overrides = {}) => {
  const scriptPath = join(root, 'scenario.json');
  const recordPath = join(root, 'record.jsonl');
  writeFileSync(scriptPath, JSON.stringify(scenario));
  writeFileSync(recordPath, '');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const children = [];
  const spawnCalls = [];
  const logs = [];
  const ctx = {
    cwd: workspace,
    runtimeToken: TOKEN,
    instanceUrl: INSTANCE,
    agentName: 'tester',
    memoryLongTerm: 'remember the blue door',
    timeoutMs: 20000,
    env: { PATH: process.env.PATH, HOME: root, COMMONLY_AGENT_TOKEN: TOKEN, SOME_PROVIDER_KEY: 'pk-should-not-pass' },
    environment: {
      acp: { command: [process.execPath, FAKE, scriptPath, recordPath] },
      mcp: [commonlyServer()],
    },
    _log: (line) => logs.push(line),
    _spawnImpl: (cmd, args, options) => {
      spawnCalls.push({ cmd, args, options });
      const child = childSpawn(cmd, args, options);
      children.push(child);
      return child;
    },
    ...overrides,
  };
  let result;
  let failure;
  try {
    result = await acp.spawn(overrides.prompt || 'hello there', ctx);
  } catch (err) {
    failure = err;
  }
  const records = readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const inbound = records.filter((r) => r.inbound).map((r) => r.inbound);
  const sent = (method) => inbound.find((m) => m.method === method);
  const allLogs = [
    ...logs,
    ...[warn, error, info].flatMap((spy) => spy.mock.calls.map((call) => call.join(' '))),
  ];
  return { result, failure, records, inbound, sent, children, spawnCalls, allLogs, workspace };
};

const credentialPathOf = (sessionNew) => sessionNew.params.mcpServers[0].env
  .find((entry) => entry.name === 'COMMONLY_TOKEN_FILE')?.value;

const expectChildGone = (children) => {
  expect(children.length).toBeGreaterThan(0);
  for (const child of children) {
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }
};

const expectNoLeftovers = (turn) => {
  expectChildGone(turn.children);
  const sessionNew = turn.sent('session/new');
  if (sessionNew) {
    const credential = credentialPathOf(sessionNew);
    expect(credential).toBeTruthy();
    expect(existsSync(credential)).toBe(false);
    expect(existsSync(path.dirname(path.dirname(credential)))).toBe(false);
  }
};

describe('acp adapter: registry and environment', () => {
  test('is registered', () => {
    expect(listAdapterNames()).toContain('acp');
    expect(getAdapter('acp')).toBe(acp);
    expect(acp.name).toBe('acp');
    // The adapter can't pass a model to an ACP agent yet, so it must not
    // refuse a turn for lacking one.
    expect(acp.requiresModel).toBe(false);
  });

  test('stays out of the public adapter list until attach can configure it', () => {
    expect(listAdapterNames()).toContain('acp');
    expect(listPublicAdapterNames()).not.toContain('acp');
    expect(getAdapter('acp')).toBe(acp);
  });

  test('detect is null without a configured command', async () => {
    expect(await acp.detect()).toBeNull();
    expect(await acp.detect({})).toBeNull();
    expect(await acp.detect({ acp: { command: [] } })).toBeNull();
  });

  test('detect finds a configured absolute command', async () => {
    const found = await acp.detect({ acp: { command: [process.execPath, FAKE] } });
    expect(found.path).toBe(process.execPath);
  });

  test.each([
    [{ acp: { command: [] } }, /non-empty array/],
    [{ acp: { command: 'gemini --acp' } }, /non-empty array/],
    [{ acp: { command: ['gemini', 3] } }, /strings/],
    [{ acp: { command: ['', '--acp'] } }, /strings/],
    [{ acp: { command: ['gemini', 'a\0b'] } }, /strings/],
    [{ acp: { command: ['./bin/gemini'] } }, /absolute path or a bare name/],
    [{ acp: {} }, /non-empty array/],
    [{ acp: { command: ['gemini'], passEnv: ['COMMONLY_AGENT_TOKEN'] } }, /passEnv/],
    [{ acp: { command: ['gemini'], extra: 1 } }, /unknown acp key/],
  ])('validateEnvironment refuses %p', async (environment, message) => {
    await expect(acp.validateEnvironment(environment, root)).rejects.toThrow(message);
  });

  test('validateEnvironment accepts a bare name and an absolute path', async () => {
    await expect(acp.validateEnvironment({ acp: { command: ['gemini', '--experimental-acp'] } }, root)).resolves.toBeTruthy();
    await expect(acp.validateEnvironment({ acp: { command: [process.execPath, FAKE] } }, root)).resolves.toBeTruthy();
  });

  test('a public seat is refused before anything spawns', async () => {
    const spawnImpl = jest.fn();
    for (const trust of ['public', 'internal']) {
      await expect(acp.spawn('hi', {
        cwd: root,
        runtimeToken: TOKEN,
        environment: { acp: { command: [process.execPath, FAKE] }, sandbox: { trust } },
        _spawnImpl: spawnImpl,
      })).rejects.toThrow('acp adapter: public seats are not supported yet');
    }
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe('acp adapter: a turn', () => {
  test('a full turn: initialize, session/new, prompt, reply from message chunks only', async () => {
    const turn = await runTurn({
      steps: [
        { thought: 'THINKING-NOT-FOR-THE-ROOM ' },
        { chunk: 'Hello, ' },
        { update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'TOOL-NOT-FOR-THE-ROOM', status: 'pending' } },
        { update: { sessionUpdate: 'plan', entries: [{ content: 'PLAN-NOT-FOR-THE-ROOM', priority: 'high', status: 'pending' }] } },
        { chunk: 'world.' },
        { stop: 'end_turn' },
      ],
    });
    expect(turn.failure).toBeUndefined();
    expect(turn.result).toEqual({ text: 'Hello, world.', newSessionId: null });

    const init = turn.sent('initialize');
    expect(init.params.protocolVersion).toBe(1);
    expect(init.params.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false },
    });
    expect(init.params.clientInfo.name).toBeTruthy();

    const sessionNew = turn.sent('session/new');
    expect(sessionNew.params.cwd).toBe(turn.workspace);
    expect(sessionNew.params.mcpServers).toHaveLength(1);

    const prompt = turn.sent('session/prompt');
    expect(prompt.params.sessionId).toBe('sess-1');
    expect(prompt.params.prompt).toHaveLength(1);
    expect(prompt.params.prompt[0].type).toBe('text');
    expect(prompt.params.prompt[0].text).toContain('hello there');
    expect(prompt.params.prompt[0].text).toContain('remember the blue door');

    const start = turn.records.find((r) => r.start).start;
    expect(start.cwd).toBe(realpathSync(turn.workspace));
    expectNoLeftovers(turn);
  });

  test('the Commonly MCP entry carries the credential path, never the token', async () => {
    const turn = await runTurn({ steps: [{ chunk: 'ok' }, { stop: 'end_turn' }] });
    expect(turn.failure).toBeUndefined();
    const sessionNew = turn.sent('session/new');
    const [entry] = sessionNew.params.mcpServers;
    expect(entry.name).toBe('commonly');
    expect(path.isAbsolute(entry.command)).toBe(true);
    expect(Array.isArray(entry.args)).toBe(true);
    expect(Array.isArray(entry.env)).toBe(true);
    for (const variable of entry.env) expect(Object.keys(variable).sort()).toEqual(['name', 'value']);
    const names = entry.env.map((variable) => variable.name);
    expect(names).toContain('COMMONLY_TOKEN_FILE');
    expect(names).not.toContain('COMMONLY_AGENT_TOKEN');
    expect(entry.env.find((variable) => variable.name === 'COMMONLY_API_URL').value).toBe(INSTANCE);
    // The credential file held the token while the turn ran; it is gone now.
    expect(credentialPathOf(sessionNew)).toMatch(/token$/);

    // The token is absent from argv, from every message the agent received,
    // from the agent's own environment, and from every log line.
    const [call] = turn.spawnCalls;
    expect(JSON.stringify([call.cmd, call.args])).not.toContain(TOKEN);
    expect(JSON.stringify(turn.inbound)).not.toContain(TOKEN);
    const start = turn.records.find((r) => r.start).start;
    expect(JSON.stringify(start.env)).not.toContain(TOKEN);
    expect(start.envNames).not.toContain('COMMONLY_AGENT_TOKEN');
    expect(start.envNames).not.toContain('SOME_PROVIDER_KEY');
    expect(start.env.COMMONLY_TOKEN_FILE).toBe(credentialPathOf(sessionNew));
    expect(turn.allLogs.length).toBeGreaterThan(0);
    expect(turn.allLogs.join('\n')).not.toContain(TOKEN);
    expectNoLeftovers(turn);
  });

  test.each([
    ['max_tokens'],
    ['max_turn_requests'],
  ])('%s returns the reply so far with a warning', async (stopReason) => {
    const turn = await runTurn({ steps: [{ chunk: 'partial answer' }, { stop: stopReason }] });
    expect(turn.failure).toBeUndefined();
    expect(turn.result).toEqual({ text: 'partial answer', newSessionId: null });
    expect(warn.mock.calls.flat().join(' ')).toContain(stopReason);
    expectNoLeftovers(turn);
  });

  test('refusal is an error naming it', async () => {
    const turn = await runTurn({ steps: [{ chunk: 'no' }, { stop: 'refusal' }] });
    expect(turn.failure?.message).toMatch(/refus/);
    expect(turn.failure.message).toContain('refusal');
    expectNoLeftovers(turn);
  });

  test('cancelled that the adapter did not ask for is an error', async () => {
    const turn = await runTurn({ steps: [{ stop: 'cancelled' }] });
    expect(turn.failure?.message).toContain('cancelled');
    expectNoLeftovers(turn);
  });

  test('an unknown stop reason is an error', async () => {
    const turn = await runTurn({ steps: [{ chunk: 'x' }, { stop: 'gave_up' }] });
    expect(turn.failure?.message).toContain('gave_up');
    expectNoLeftovers(turn);
  });

  test('a timeout sends session/cancel, answers a late permission request with cancelled, then fails as a timeout', async () => {
    const turn = await runTurn({
      steps: [{ chunk: 'working…' }, { hang: true }],
      onCancel: { permission: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }], stop: 'cancelled' },
    }, { timeoutMs: 2500, _cancelGraceMs: 500 });
    expect(turn.failure?.message).toMatch(/timed out after 2500ms/);
    const cancel = turn.sent('session/cancel');
    expect(cancel).toBeTruthy();
    expect(cancel.params).toEqual({ sessionId: 'sess-1' });
    expect(Object.prototype.hasOwnProperty.call(cancel, 'id')).toBe(false);
    const late = turn.records.find((r) => r.permissionReplyAfterCancel).permissionReplyAfterCancel;
    expect(late).toEqual({ result: { outcome: { outcome: 'cancelled' } } });
    expectNoLeftovers(turn);
  });

  test('a timeout answers a permission request still open with cancelled', async () => {
    let decide;
    const turn = await runTurn({
      steps: [{ permission: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }] }, { hang: true }],
    }, {
      timeoutMs: 2500,
      _cancelGraceMs: 500,
      // A decision that never comes, so the request is open when time runs out.
      _permissionPolicy: () => new Promise((resolve) => { decide = resolve; }),
    });
    expect(decide).toBeDefined();
    expect(turn.failure?.message).toMatch(/timed out/);
    expect(turn.sent('session/cancel')).toBeTruthy();
    const reply = turn.records.find((r) => r.permissionReply).permissionReply;
    expect(reply).toEqual({ result: { outcome: { outcome: 'cancelled' } } });
    expectNoLeftovers(turn);
  });

  test('an agent that ignores the cancel is killed after the grace period', async () => {
    const turn = await runTurn({
      steps: [{ hang: true }], onCancel: { ignore: true }, ignoreSigterm: true,
    }, { timeoutMs: 2500, _cancelGraceMs: 200, _killGraceMs: 200 });
    expect(turn.failure?.message).toMatch(/timed out after 2500ms/);
    expect(turn.sent('session/cancel')).toBeTruthy();
    expectNoLeftovers(turn);
  });

  test('permission requests are rejected with a reject option, or cancelled without one', async () => {
    const turn = await runTurn({
      steps: [
        { permission: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'always', name: 'Always', kind: 'allow_always' },
          { optionId: 'never', name: 'Never', kind: 'reject_always' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ] },
        { permission: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] },
        { chunk: 'done' },
        { stop: 'end_turn' },
      ],
    });
    expect(turn.failure).toBeUndefined();
    const replies = turn.records.filter((r) => r.permissionReply).map((r) => r.permissionReply);
    expect(replies).toEqual([
      { result: { outcome: { outcome: 'selected', optionId: 'no' } } },
      { result: { outcome: { outcome: 'cancelled' } } },
    ]);
    expectNoLeftovers(turn);
  });

  test('fs and terminal requests are answered with method not found', async () => {
    const turn = await runTurn({
      steps: [{ ask: 'fs/read_text_file' }, { ask: 'terminal/create' }, { chunk: 'fine' }, { stop: 'end_turn' }],
    });
    expect(turn.failure).toBeUndefined();
    expect(turn.result.text).toBe('fine');
    const replies = turn.records.filter((r) => r.askReply).map((r) => r.askReply);
    expect(replies.map((r) => r.method)).toEqual(['fs/read_text_file', 'terminal/create']);
    for (const { reply } of replies) expect(reply.error.code).toBe(-32601);
    expectNoLeftovers(turn);
  });

  test('an agent that exits mid-turn fails the turn with its exit code', async () => {
    const turn = await runTurn({ steps: [{ chunk: 'half' }, { exit: 4 }] });
    expect(turn.failure?.message).toMatch(/exited with code 4/);
    expectNoLeftovers(turn);
  });

  test('an agent that exits at initialize fails the turn', async () => {
    const turn = await runTurn({ exitOn: 'initialize' });
    expect(turn.failure?.message).toMatch(/exited with code 3/);
    expect(turn.sent('session/new')).toBeUndefined();
    expectChildGone(turn.children);
  });

  test('an agent command that does not exist fails clearly', async () => {
    const turn = await runTurn({}, {
      environment: { acp: { command: [join(root, 'no-such-agent')] }, mcp: [commonlyServer()] },
      _spawnImpl: undefined,
    });
    expect(turn.failure?.message).toMatch(/acp adapter/);
  });

  test('a protocol version other than 1 fails the turn before a session', async () => {
    const turn = await runTurn({ protocolVersion: 2 });
    expect(turn.failure?.message).toMatch(/protocol version 2/);
    expect(turn.sent('session/new')).toBeUndefined();
    expectChildGone(turn.children);
  });

  test('an agent that requires authentication fails the turn without authenticating', async () => {
    const turn = await runTurn({
      authOnNew: true,
      authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
    });
    expect(turn.failure?.message).toMatch(/requires authentication/);
    expect(turn.failure.message).toContain('oauth-personal');
    expect(turn.sent('authenticate')).toBeUndefined();
    expect(turn.sent('session/prompt')).toBeUndefined();
    expectNoLeftovers(turn);
  });

  test('an agent error that echoes a passed-through key never reaches the error or a log', async () => {
    const secret = 'pk-live-SECRET-provider-value-0123456789';
    const turn = await runTurn({
      promptError: { code: -32603, message: `provider said 401 for key ${secret}`, data: { key: secret } },
    }, {
      env: { PATH: process.env.PATH, HOME: root, FAKE_PROVIDER_KEY: secret },
      environment: {
        acp: { command: [process.execPath, FAKE, join(root, 'scenario.json'), join(root, 'record.jsonl')], passEnv: ['FAKE_PROVIDER_KEY'] },
        mcp: [commonlyServer()],
      },
    });
    expect(turn.failure).toBeDefined();
    expect(turn.failure.message).toMatch(/^acp/);
    expect(turn.failure.message).not.toContain(secret);
    expect(JSON.stringify({ ...turn.failure, message: turn.failure.message })).not.toContain(secret);
    expect(turn.allLogs.join('\n')).not.toContain(secret);
    // The key did reach the agent, so the scrub is what kept it out.
    expect(turn.records.find((r) => r.start).start.env.FAKE_PROVIDER_KEY).toBe(secret);
    expectNoLeftovers(turn);
  });

  test('a model setting is not required and warns once that it is not passed', async () => {
    const turn = await runTurn({ steps: [{ chunk: 'ok' }, { stop: 'end_turn' }] }, {
      environment: {
        model: 'some-model',
        acp: { command: [process.execPath, FAKE, join(root, 'scenario.json'), join(root, 'record.jsonl')] },
        mcp: [commonlyServer()],
      },
    });
    expect(turn.failure).toBeUndefined();
    const modelWarnings = warn.mock.calls.flat().filter((line) => /model/.test(String(line)));
    expect(modelWarnings).toHaveLength(1);
    expect(modelWarnings[0]).toMatch(/does not pass/);
  });

  test('a seat with no acp command is refused before anything spawns', async () => {
    const turn = await runTurn({}, { environment: { mcp: [commonlyServer()] } });
    expect(turn.failure?.message).toMatch(/acp\.command/);
    expect(turn.spawnCalls).toHaveLength(0);
  });
});
