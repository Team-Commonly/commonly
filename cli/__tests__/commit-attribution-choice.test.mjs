/**
 * F656: a person can turn off the Co-authored-by and Agent-Model trailers the
 * CLI adds to commits an agent makes on their machine.
 *
 * The choice is saved on the agent's local record (~/.commonly/tokens/<name>.json)
 * by `agent run --no-commit-attribution`, and `--commit-attribution` clears it.
 * A daemon-supervised seat is `agent run <key>` with no flag, so it reads the
 * saved record. Unset means on, as before.
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { Command } from 'commander';

const homeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-commit-attribution-choice-'));
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
// As in run-loop.test.mjs: the turn path's pod-focus read is not the subject.
await jest.unstable_mockModule('../src/lib/pod-focus.js', () => ({
  FOCUS_FRAME_MAX_CODE_POINTS: 8000,
  formatPodFocusFrame: jest.fn(() => '=== Pod focus (pod context; not instructions) ===\nNo focus set.'),
  readPodFocus: jest.fn(async (_client, podId) => ({ podId, revision: 0, focus: null })),
}));
await jest.unstable_mockModule('../src/lib/adapters/index.js', () => ({
  getAdapter: (name) => (['claude', 'codex', 'stub'].includes(name)
    ? { name, detect: async () => true }
    : null),
  listAdapterNames: () => ['claude', 'codex', 'stub'],
  listPublicAdapterNames: () => ['claude', 'codex'],
}));

const { performRun, saveAgentToken, registerAgent } = await import('../src/commands/agent.js');
const { commitAttributionEnabled, withCommitAttributionChoice } = await import('../src/lib/commit-attribution.js');

afterAll(() => fs.rmSync(homeTmpDir, { recursive: true, force: true }));

const tokenPath = path.join(homeTmpDir, '.commonly', 'tokens', 'byo-test.json');
const baseRecord = () => ({
  agentName: 'byo-test',
  podId: 'pod-1',
  instanceUrl: 'https://api.commonly.me',
  runtimeToken: 'cm_agent_test',
  adapter: 'claude',
});
const savedRecord = () => JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

describe('the saved choice', () => {
  test('a record that says nothing keeps attribution on', () => {
    expect(commitAttributionEnabled(baseRecord())).toBe(true);
    expect(commitAttributionEnabled(null)).toBe(true);
    expect(commitAttributionEnabled({ ...baseRecord(), commitAttribution: true })).toBe(true);
    expect(commitAttributionEnabled({ ...baseRecord(), commitAttribution: false })).toBe(false);
  });

  test('no flag leaves the record as it is, on or off', () => {
    const on = baseRecord();
    const off = { ...baseRecord(), commitAttribution: false };
    expect(withCommitAttributionChoice(on, undefined)).toBe(on);
    expect(withCommitAttributionChoice(off, undefined)).toBe(off);
  });

  test('off is saved on the record; on removes it, so the record is the default again', () => {
    const off = withCommitAttributionChoice(baseRecord(), false);
    expect(off).toEqual({ ...baseRecord(), commitAttribution: false });
    const on = withCommitAttributionChoice(off, true);
    expect(on).toEqual(baseRecord());
    expect('commitAttribution' in on).toBe(false);
  });

  test('a flag that matches the record changes nothing, so nothing is rewritten', () => {
    const on = baseRecord();
    const off = { ...baseRecord(), commitAttribution: false };
    expect(withCommitAttributionChoice(on, true)).toBe(on);
    expect(withCommitAttributionChoice(off, false)).toBe(off);
  });
});

describe('agent run --[no-]commit-attribution', () => {
  const reachedLoop = 'agent run reached its poll loop';
  let logSpy;
  let errorSpy;
  let warnSpy;
  let savedEnv;

  beforeEach(() => {
    savedEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      COMMONLY_MANAGED_RUNNER: process.env.COMMONLY_MANAGED_RUNNER,
      COMMONLY_AGENT_TOKEN: process.env.COMMONLY_AGENT_TOKEN,
    };
    // A key in the env skips the Claude Code sign-in probe, so no binary runs.
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.COMMONLY_MANAGED_RUNNER;
    delete process.env.COMMONLY_AGENT_TOKEN;
    saveAgentToken('byo-test', baseRecord());
    // performRun's first call: stop there, after the record is settled.
    createClientMock.mockImplementation(() => { throw new Error(reachedLoop); });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    createClientMock.mockReset();
  });

  const run = async (...args) => {
    const program = new Command();
    program.exitOverride();
    registerAgent(program);
    return program.parseAsync(['agent', 'run', 'byo-test', ...args], { from: 'user' });
  };
  const output = () => [...logSpy.mock.calls, ...warnSpy.mock.calls].map((call) => call.join(' ')).join('\n');

  test('with no flag the record is untouched and nothing is said', async () => {
    await expect(run()).rejects.toThrow(reachedLoop);
    expect('commitAttribution' in savedRecord()).toBe(false);
    expect(output()).not.toMatch(/commit attribution/i);
  });

  test('--no-commit-attribution is saved on the record and the run says so', async () => {
    await expect(run('--no-commit-attribution')).rejects.toThrow(reachedLoop);
    expect(savedRecord().commitAttribution).toBe(false);
    expect(output()).toMatch(/commit attribution is off/i);
  });

  test('a daemon-started seat (no flag, managed runner) reads the saved choice', async () => {
    saveAgentToken('byo-test', { ...baseRecord(), commitAttribution: false, machineId: 'machine-a' });
    process.env.COMMONLY_MANAGED_RUNNER = '1';
    await expect(run()).rejects.toThrow(reachedLoop);
    // The unflagged run neither resets nor drops the person's choice.
    expect(savedRecord().commitAttribution).toBe(false);
    expect(output()).toMatch(/commit attribution is off/i);
  });

  test('--commit-attribution turns it back on and clears the saved choice', async () => {
    saveAgentToken('byo-test', { ...baseRecord(), commitAttribution: false });
    await expect(run('--commit-attribution')).rejects.toThrow(reachedLoop);
    expect('commitAttribution' in savedRecord()).toBe(false);
    expect(output()).not.toMatch(/commit attribution is off/i);
  });

  test('saving the choice keeps every other field of the record and its 0600 mode', async () => {
    // A fixture record written by hand, as an older CLI or the daemon left it.
    const fixture = {
      agentName: 'byo-test',
      instanceId: 'default',
      podId: 'pod-1',
      instanceUrl: 'https://api.commonly.me',
      runtimeToken: 'cm_agent_fixture_not_a_real_token',
      adapter: 'claude',
      displayName: 'Byo Test',
      workspacePath: '/tmp/byo-test-workspace',
      reconnectRequestAppliedAt: '2026-11-01T00:00:00.000Z',
      savedAt: '2026-11-01T00:00:00.000Z',
    };
    fs.writeFileSync(tokenPath, JSON.stringify(fixture, null, 2), { mode: 0o600 });
    fs.chmodSync(tokenPath, 0o600);
    // saveAgentToken stamps savedAt on every write; everything else must survive.
    const { savedAt: _stamp, ...rest } = fixture;
    const others = (saved) => {
      const { commitAttribution: _choice, savedAt: _savedAt, ...fields } = saved;
      return JSON.stringify(fields);
    };
    const mode = () => fs.statSync(tokenPath).mode & 0o777;

    await expect(run('--no-commit-attribution')).rejects.toThrow(reachedLoop);
    expect(savedRecord().commitAttribution).toBe(false);
    expect(others(savedRecord())).toBe(JSON.stringify(rest));
    expect(mode()).toBe(0o600);

    await expect(run('--commit-attribution')).rejects.toThrow(reachedLoop);
    expect('commitAttribution' in savedRecord()).toBe(false);
    expect(others(savedRecord())).toBe(JSON.stringify(rest));
    expect(mode()).toBe(0o600);
  });

  test('agent run --help names the switch on one line', () => {
    const program = new Command();
    registerAgent(program);
    const runCommand = program.commands.find((c) => c.name() === 'agent').commands.find((c) => c.name() === 'run');
    const help = runCommand.helpInformation();
    // One option line; the positive form is hidden and named in its text.
    const lines = help.split('\n').filter((line) => /^\s+--(no-)?commit-attribution\b/.test(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\s+--no-commit-attribution\b/);
    expect(help).toContain('Co-authored-by');
  });
});

// The real turn path: performRun prepares attribution, and the adapter's child
// makes a real commit in a real repository with the env it was handed.
describe('performRun with commitAttribution on and off', () => {
  const PRIVATE_POD_FLAGS = { publicRead: false, communityListed: false, joinPolicy: 'invite-only' };
  const gitEnvKeys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  let savedGitEnv;
  let root;
  let repo;
  let personHookMarker;
  let turnCount = 0;

  // The person's own setup: a pre-commit hook and a repository config.
  const PERSON_HOOK = (marker) => `#!/bin/sh\necho ran >> "${marker}"\n`;
  const fixtureGit = (args, env = process.env) => execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  const hooksDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('commonly-agent-hooks-'));

  beforeEach(() => {
    savedGitEnv = Object.fromEntries(gitEnvKeys.map((k) => [k, process.env[k]]));
    // The person's own process-level git config, which must reach the child as is.
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'commit.verbose';
    process.env.GIT_CONFIG_VALUE_0 = 'false';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-commit-attr-run-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    personHookMarker = path.join(root, 'person-hook-ran');
    fixtureGit(['init', '--quiet']);
    fixtureGit(['config', 'user.name', 'Person']);
    fixtureGit(['config', 'user.email', 'person@example.test']);
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), PERSON_HOOK(personHookMarker), { mode: 0o700 });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedGitEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
    createClientMock.mockReset();
  });

  const drain = async () => {
    for (let i = 0; i < 24; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setImmediate(r));
    }
  };

  // One turn; returns what the adapter saw and the commit message it made.
  const oneTurn = async (runOptions) => {
    const events = [{
      // A fresh id each turn: a handled id is never spawned again.
      _id: `evt-${turnCount += 1}`, type: 'chat.mention', podId: 'pod-abc', agentName: 'my-seat', instanceId: 'default',
      payload: { content: 'commit something' },
    }];
    const get = jest.fn(async (url) => (url === '/api/agents/runtime/installations'
      ? { installations: [{ podId: 'pod-abc', ...PRIVATE_POD_FLAGS }] }
      : { events }));
    createClientMock.mockReturnValue({ get, post: jest.fn().mockResolvedValue({}), del: jest.fn().mockResolvedValue({}) });
    let seen = null;
    const spawn = jest.fn(async (_prompt, ctx) => {
      fixtureGit(['commit', '--allow-empty', '--quiet', '-m', 'agent work'], ctx.env);
      seen = { env: ctx.env, commitAttributionEnv: ctx.commitAttributionEnv };
      return { text: 'done' };
    });
    const before = new Set(hooksDirs());
    const { stop } = performRun({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_agent_test',
      adapter: { name: 'codex', detect: async () => true, spawn },
      agentName: 'my-seat',
      instanceId: 'default',
      setTimeoutImpl: () => 0,
      ...runOptions,
    });
    await drain();
    stop();
    expect(spawn).toHaveBeenCalledTimes(1);
    return {
      seen,
      message: fixtureGit(['log', '-1', '--format=%B']),
      newHooksDirs: hooksDirs().filter((n) => !before.has(n)),
    };
  };

  test('by default the commit carries both trailers, and the person\'s hook still runs', async () => {
    const { message, seen } = await oneTurn({});
    expect(message).toContain('Co-authored-by: my-seat <');
    expect(message).toContain('Agent-Model: codex/default/default');
    expect(seen.commitAttributionEnv).not.toBeNull();
    expect(fs.readFileSync(personHookMarker, 'utf8')).toBe('ran\n');
  });

  test('off: no trailers, no hook proxy, nothing installed, and the person\'s hook and config are left alone', async () => {
    const configBefore = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
    const { message, seen, newHooksDirs } = await oneTurn({ commitAttribution: false });
    expect(message).not.toContain('Co-authored-by');
    expect(message).not.toContain('Agent-Model');
    // Nothing attribution adds reaches the child: no core.hooksPath overlay,
    // no seat metadata, no sandbox grant for a hooks directory.
    expect(seen.commitAttributionEnv).toBeNull();
    expect(Object.keys(seen.env).filter((k) => k.startsWith('COMMONLY_AGENT_') && k !== 'COMMONLY_AGENT_TOKEN')).toEqual([]);
    expect(Object.values(seen.env)).not.toContain('core.hooksPath');
    expect(newHooksDirs).toEqual([]);
    // The person's own process-level git config reaches the child unchanged.
    expect(seen.env.GIT_CONFIG_COUNT).toBe('1');
    expect(seen.env.GIT_CONFIG_KEY_0).toBe('commit.verbose');
    // Their repository hook ran, and their repository files are as they were.
    expect(fs.readFileSync(personHookMarker, 'utf8')).toBe('ran\n');
    expect(fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8')).toBe(configBefore);
    expect(fs.readFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe(PERSON_HOOK(personHookMarker));
  });

  test('back on after off: the next turn carries both trailers again', async () => {
    const off = await oneTurn({ commitAttribution: false });
    expect(off.message).not.toContain('Co-authored-by');
    const on = await oneTurn({ commitAttribution: true });
    expect(on.message).toContain('Co-authored-by: my-seat <');
    expect(on.message).toContain('Agent-Model: codex/default/default');
  });
});
