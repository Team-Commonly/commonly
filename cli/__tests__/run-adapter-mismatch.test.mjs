/**
 * run-adapter-mismatch.test.mjs — #2098
 *
 * `commonly agent run <name> --adapter X` only ever chose the CLI at first-run
 * bootstrap. Once ~/.commonly/tokens/<name>.json exists, the record's adapter
 * runs, and a different `--adapter` was dropped silently: switching an agent
 * from Claude to Codex kept running Claude. The run now refuses the mismatch
 * and names the remedy.
 *
 * Covers the pure check and the command wiring: the real `agent run` action,
 * built by registerAgent, against a token file in a throwaway home directory.
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { Command } from 'commander';

const homeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-adapter-test-'));
const createClientMock = jest.fn();

await jest.unstable_mockModule('os', () => {
  const actual = os;
  return {
    ...actual,
    default: { ...actual, homedir: () => homeTmpDir },
    homedir: () => homeTmpDir,
  };
});
await jest.unstable_mockModule('../src/lib/api.js', () => ({ createClient: createClientMock }));
await jest.unstable_mockModule('../src/lib/adapters/index.js', () => ({
  getAdapter: (name) => (['claude', 'codex', 'pi', 'opencode', 'stub'].includes(name)
    ? { name, detect: async () => true }
    : null),
  listAdapterNames: () => ['claude', 'codex', 'pi', 'opencode', 'stub'],
}));

const {
  checkRunAdapterRequest,
  saveAgentToken,
  registerAgent,
} = await import('../src/commands/agent.js');

afterAll(() => fs.rmSync(homeTmpDir, { recursive: true, force: true }));

const record = (adapter) => ({
  agentName: 'byo-test',
  podId: 'pod-1',
  instanceUrl: 'https://api.commonly.me',
  runtimeToken: 'cm_agent_test',
  adapter,
});
const tokenPath = path.join(homeTmpDir, '.commonly', 'tokens', 'byo-test.json');

describe('checkRunAdapterRequest', () => {
  test('no --adapter runs the bound adapter', () => {
    expect(checkRunAdapterRequest({ record: record('claude'), requestedAdapter: undefined, tokenPath })).toEqual({ ok: true });
    expect(checkRunAdapterRequest({ record: record('claude'), requestedAdapter: null, tokenPath })).toEqual({ ok: true });
  });

  test('a matching --adapter runs, whatever its case', () => {
    expect(checkRunAdapterRequest({ record: record('codex'), requestedAdapter: 'codex', tokenPath })).toEqual({ ok: true });
    expect(checkRunAdapterRequest({ record: record('codex'), requestedAdapter: ' Codex ', tokenPath })).toEqual({ ok: true });
  });

  test('a mismatched --adapter refuses and names the binding and both remedies', () => {
    const result = checkRunAdapterRequest({ record: record('claude'), requestedAdapter: 'codex', tokenPath });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("'byo-test' is bound to the claude adapter");
    expect(result.message).toContain(tokenPath);
    expect(result.message).toContain('--adapter codex was not applied');
    expect(result.message).toContain('commonly agent detach byo-test --force');
    expect(result.message).toContain('commonly agent config byo-test --adapter codex');
    // Plain detach also uninstalls the agent from its pod; the remedy must not suggest it.
    expect(result.message).not.toMatch(/detach byo-test(?! --force)/);
  });

  test('a record with no adapter is left to the existing unknown-adapter error', () => {
    expect(checkRunAdapterRequest({ record: record(undefined), requestedAdapter: 'codex', tokenPath })).toEqual({ ok: true });
  });
});

describe('agent run --adapter against an existing token file', () => {
  const exitSentinel = new Error('process.exit called');
  let exitSpy;
  let errorSpy;

  beforeEach(() => {
    saveAgentToken('byo-test', record('claude'));
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      exitSentinel.code = code;
      throw exitSentinel;
    });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    createClientMock.mockReset();
  });

  const run = async (...args) => {
    const program = new Command();
    program.exitOverride();
    registerAgent(program);
    return program.parseAsync(['agent', 'run', 'byo-test', ...args], { from: 'user' });
  };

  test('a mismatched --adapter exits 1 with the remedy before anything runs', async () => {
    await expect(run('--adapter', 'codex')).rejects.toBe(exitSentinel);
    expect(exitSentinel.code).toBe(1);
    const stderr = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(stderr).toContain("[byo-test] 'byo-test' is bound to the claude adapter");
    expect(stderr).toContain(`(${tokenPath})`);
    expect(stderr).toContain('commonly agent detach byo-test --force');
    // The token file is untouched: refusing must not edit the record.
    expect(JSON.parse(fs.readFileSync(tokenPath, 'utf8')).adapter).toBe('claude');
  });

  test('OpenCode refuses a connect-page installation that has no server adapter binding', async () => {
    saveAgentToken('byo-test', { ...record('opencode'), instanceId: 'connect-page' });
    const get = jest.fn().mockResolvedValue({
      installations: [{
        type: 'installation',
        podId: 'pod-1',
        instanceId: 'connect-page',
        runtimeAdapter: null,
      }],
    });
    createClientMock
      .mockReturnValueOnce({ get })
      // If the command drops its server-side binding check, fail before a poll
      // loop can start. The test's expected exit then becomes a real failure.
      .mockImplementationOnce(() => { throw new Error('agent run reached its poll loop'); });

    await expect(run()).rejects.toBe(exitSentinel);
    expect(exitSentinel.code).toBe(1);
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/api/agents/runtime/installations');
    const stderr = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(stderr).toContain("Adapter 'opencode' is not declared for this Commonly installation");
    expect(stderr).toContain('commonly login, then run commonly agent attach opencode --pod pod-1 --name byo-test [--env <environment.yaml>]');
  });

  test('a failed installations read reports the read failure separately from a binding refusal', async () => {
    saveAgentToken('byo-test', { ...record('pi'), instanceId: 'connect-page' });
    createClientMock.mockReturnValueOnce({
      get: jest.fn().mockRejectedValue(new Error('network unavailable')),
    });

    await expect(run()).rejects.toBe(exitSentinel);
    expect(exitSentinel.code).toBe(1);
    expect(createClientMock).toHaveBeenCalledTimes(1);
    const stderr = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(stderr).toContain('could not read the server-declared adapter: network unavailable');
    expect(stderr).not.toContain("Adapter 'pi' is not declared");
  });

  test('a saved pi seat rechecks the server binding on every run', async () => {
    saveAgentToken('byo-test', { ...record('pi'), instanceId: 'connect-page' });
    const get = jest.fn().mockResolvedValue({
      installations: [{
        type: 'installation',
        podId: 'pod-1',
        instanceId: 'connect-page',
        runtimeAdapter: null,
      }],
    });
    createClientMock
      .mockReturnValueOnce({ get })
      // If the run-time check is removed, fail before a poll loop can start.
      .mockImplementationOnce(() => { throw new Error('agent run reached its poll loop'); });

    await expect(run()).rejects.toBe(exitSentinel);
    expect(exitSentinel.code).toBe(1);
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/api/agents/runtime/installations');
    const stderr = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(stderr).toContain("Adapter 'pi' is not declared for this Commonly installation");
    expect(stderr).toContain('commonly agent attach pi --pod pod-1 --name byo-test [--env <environment.yaml>]');
  });

  test('the env-token first run refuses pi before saving its token or spawning', async () => {
    fs.rmSync(tokenPath, { force: true });
    const oldToken = process.env.COMMONLY_AGENT_TOKEN;
    const oldApiUrl = process.env.COMMONLY_API_URL;
    process.env.COMMONLY_AGENT_TOKEN = 'cm_agent_test';
    process.env.COMMONLY_API_URL = 'https://api.commonly.me';
    const get = jest.fn().mockResolvedValue({
      agentName: 'byo-test',
      instanceId: 'connect-page',
      installations: [{
        type: 'installation',
        podId: 'pod-1',
        instanceId: 'connect-page',
        status: 'active',
        runtimeAdapter: null,
      }],
    });
    createClientMock
      .mockReturnValueOnce({ get })
      // If bootstrap does not enforce the server binding, fail on the poll path.
      .mockImplementationOnce(() => { throw new Error('agent run reached its poll loop'); });

    try {
      await expect(run('--adapter', 'pi')).rejects.toBe(exitSentinel);
      expect(exitSentinel.code).toBe(1);
      expect(get).toHaveBeenCalledWith('/api/agents/runtime/installations');
      expect(createClientMock).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(tokenPath)).toBe(false);
      const stderr = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(stderr).toContain("Adapter 'pi' is not declared for this Commonly installation");
      expect(stderr).toContain('commonly agent attach pi --pod pod-1 --name byo-test [--env <environment.yaml>]');
    } finally {
      if (oldToken === undefined) delete process.env.COMMONLY_AGENT_TOKEN;
      else process.env.COMMONLY_AGENT_TOKEN = oldToken;
      if (oldApiUrl === undefined) delete process.env.COMMONLY_API_URL;
      else process.env.COMMONLY_API_URL = oldApiUrl;
      saveAgentToken('byo-test', record('claude'));
    }
  });

  test('the option help tells the truth about an existing token file', () => {
    const program = new Command();
    registerAgent(program);
    const runCommand = program.commands.find((c) => c.name() === 'agent').commands.find((c) => c.name() === 'run');
    const option = runCommand.options.find((o) => o.long === '--adapter');
    expect(option.description).toContain('bound to a different adapter stops the run');
    expect(option.description).not.toContain('ignored');
  });
});
