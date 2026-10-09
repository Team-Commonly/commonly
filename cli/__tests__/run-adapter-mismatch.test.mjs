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

await jest.unstable_mockModule('os', () => {
  const actual = os;
  return {
    ...actual,
    default: { ...actual, homedir: () => homeTmpDir },
    homedir: () => homeTmpDir,
  };
});

const { checkRunAdapterRequest, saveAgentToken, registerAgent } = await import('../src/commands/agent.js');

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

  test('the option help tells the truth about an existing token file', () => {
    const program = new Command();
    registerAgent(program);
    const runCommand = program.commands.find((c) => c.name() === 'agent').commands.find((c) => c.name() === 'run');
    const option = runCommand.options.find((o) => o.long === '--adapter');
    expect(option.description).toContain('bound to a different adapter stops the run');
    expect(option.description).not.toContain('ignored');
  });
});
