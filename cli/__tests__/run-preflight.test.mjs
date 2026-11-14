/**
 * F515: what `agent run` checks before it starts waiting, and what it tells
 * the instance. Each failure is one plain line, and only a reason code leaves
 * this computer.
 */

import { jest } from '@jest/globals';

import { EventEmitter } from 'events';
import { homedir } from 'os';
import { join } from 'path';

import {
  harnessFindings, LISTEN_BLOCKED_REASONS, nodeFinding, preflightOutcome, reportListenBlocked, runHarnessLoginStatus,
} from '../src/lib/run-preflight.js';

const installed = { detect: async () => true };
const absent = { detect: async () => false };
// `claude auth status --json` and `codex login status` both exit 1 signed out.
const status = (code) => async () => code;

describe('nodeFinding', () => {
  test('Node 20 against >=22 is one line naming both versions and the fix', () => {
    const finding = nodeFinding({ nodeVersion: '20.11.1', enginesRange: '>=22.0.0' });
    expect(finding.reason).toBe('node-too-old');
    expect(finding.line).toBe('This computer has Node 20.11.1, and Commonly needs Node 22 or later. '
      + 'Install Node 22 from nodejs.org, then run this line again.');
  });

  test.each([['22.0.0'], ['24.3.0']])('Node %s passes', (nodeVersion) => {
    expect(nodeFinding({ nodeVersion, enginesRange: '>=22.0.0' })).toBeNull();
  });

  test('an engines range that is not a floor gives no finding', () => {
    expect(nodeFinding({ nodeVersion: '18.0.0', enginesRange: '^22' })).toBeNull();
  });
});

describe('harnessFindings', () => {
  test('a harness that is not installed says so, with the install line', async () => {
    const [finding] = await harnessFindings({ adapterName: 'codex', adapter: absent, env: {} });
    expect(finding.reason).toBe('harness-missing');
    expect(finding.harness).toBe('codex');
    expect(finding.line).toMatch(/^Codex isn't installed on this computer\. Install Codex \(npm(\.cmd)? i -g @openai\/codex\)/);
  });

  test.each([
    ['claude', 'Claude Code is installed but not signed in on this computer. Run claude once to sign in, then run this line again.'],
    ['codex', 'Codex is installed but not signed in on this computer. Run codex login once to sign in, then run this line again.'],
  ])('a signed-out %s gets one line naming the sign-in', async (adapterName, line) => {
    const findings = await harnessFindings({ adapterName, adapter: installed, env: {}, runStatus: status(1) });
    expect(findings).toEqual([{ reason: 'harness-signed-out', harness: adapterName, line }]);
  });

  test('a signed-in harness passes', async () => {
    expect(await harnessFindings({ adapterName: 'claude', adapter: installed, env: {}, runStatus: status(0) })).toEqual([]);
  });

  // Exit 2 (an old CLI without the subcommand) or a probe that could not run is
  // no verdict, so it never stops a run.
  test.each([[2], [null]])('a status exit of %s is no verdict', async (code) => {
    expect(await harnessFindings({ adapterName: 'claude', adapter: installed, env: {}, runStatus: status(code) })).toEqual([]);
  });

  test('a key in the environment skips the login probe', async () => {
    const runStatus = jest.fn(status(1));
    expect(await harnessFindings({
      adapterName: 'claude', adapter: installed, env: { ANTHROPIC_API_KEY: 'sk-fake' }, runStatus,
    })).toEqual([]);
    expect(runStatus).not.toHaveBeenCalled();
  });

  test('a seat on its own provider block needs no harness login', async () => {
    const runStatus = jest.fn(status(1));
    expect(await harnessFindings({
      adapterName: 'codex', adapter: installed, env: {}, runStatus, environment: { provider: { id: 'x' } },
    })).toEqual([]);
    expect(runStatus).not.toHaveBeenCalled();
  });

  test('checkInstalled false skips detect, for a first run that already looked', async () => {
    const adapter = { detect: jest.fn(async () => false) };
    expect(await harnessFindings({
      adapterName: 'claude', adapter, env: {}, checkInstalled: false, runStatus: status(0),
    })).toEqual([]);
    expect(adapter.detect).not.toHaveBeenCalled();
  });

  test('an adapter with no checked login probe is not asked', async () => {
    const runStatus = jest.fn(status(1));
    expect(await harnessFindings({ adapterName: 'pi', adapter: installed, env: {}, runStatus })).toEqual([]);
    expect(runStatus).not.toHaveBeenCalled();
  });
});

describe('reportListenBlocked', () => {
  test('sends only the reason code and the harness id', async () => {
    const post = jest.fn(async () => ({}));
    await reportListenBlocked({ post }, { reason: 'harness-signed-out', harness: 'claude', line: 'not sent' });
    expect(post).toHaveBeenCalledWith('/api/agents/runtime/listen-blocked', { reason: 'harness-signed-out', harness: 'claude' });
  });

  test('a missing harness is not sent here: bootstrap posts it on its own route', async () => {
    const post = jest.fn(async () => ({}));
    await reportListenBlocked({ post }, { reason: 'harness-missing', harness: 'codex', line: 'x' });
    expect(post).not.toHaveBeenCalled();
  });

  test('a failed report is swallowed', async () => {
    const post = jest.fn(async () => { throw new Error('404'); });
    await expect(reportListenBlocked({ post }, { reason: 'node-too-old', harness: null })).resolves.toBeUndefined();
  });

  test('only the known codes are sent', async () => {
    const post = jest.fn(async () => ({}));
    await reportListenBlocked({ post }, { reason: 'something-else', harness: null });
    expect(post).not.toHaveBeenCalled();
    expect(LISTEN_BLOCKED_REASONS).toEqual(['node-too-old', 'harness-signed-out']);
  });
});

describe('preflightOutcome', () => {
  const finding = { reason: 'harness-signed-out', harness: 'claude', line: 'Claude Code is installed but not signed in.' };

  test('a first run stops, prints the line and reports the first finding', () => {
    expect(preflightOutcome([finding], { firstRun: true })).toEqual({
      stop: true, lines: ['Claude Code is installed but not signed in.'], report: finding,
    });
  });

  // The branch that protects a seat that has worked here: a probe that
  // misreads it must not take it down.
  test('a run from a saved record only warns, and reports nothing', () => {
    expect(preflightOutcome([finding], { firstRun: false })).toEqual({
      stop: false, lines: ['warning: Claude Code is installed but not signed in.'], report: null,
    });
  });

  test('no findings, nothing to do', () => {
    expect(preflightOutcome([], { firstRun: true })).toEqual({ stop: false, lines: [], report: null });
  });
});

// The probe runs the command the adapter would spawn, never a bare name
// through a shell: on Windows, cmd exits 1 for a name it can't find, which is
// the signed-out code.
describe('runHarnessLoginStatus', () => {
  const fakeChild = (code) => {
    const child = new EventEmitter();
    child.kill = jest.fn();
    setImmediate(() => child.emit('exit', code));
    return child;
  };

  test('spawns the resolved command without a shell, Claude Code with ~/.local/bin on PATH', async () => {
    const resolve = jest.fn(() => ({ command: 'C:\\Users\\x\\.local\\bin\\claude.exe', args: [] }));
    const spawnFn = jest.fn(() => fakeChild(0));
    const code = await runHarnessLoginStatus('claude', ['auth', 'status', '--json'], {
      env: { PATH: '/usr/bin' }, platform: 'win32', resolve, spawnFn,
    });
    expect(code).toBe(0);
    expect(resolve.mock.calls[0][1].env.PATH).toContain(join(homedir(), '.local', 'bin'));
    const [command, args, opts] = spawnFn.mock.calls[0];
    expect(command).toBe('C:\\Users\\x\\.local\\bin\\claude.exe');
    expect(args).toEqual(['auth', 'status', '--json']);
    expect(opts.shell).toBe(false);
    expect(opts.env.PATH).toContain(join(homedir(), '.local', 'bin'));
  });

  test('an npm shim spawns through node with its prefix ahead of the status args', async () => {
    const resolve = jest.fn(() => ({ command: 'node.exe', args: ['C:\\npm\\codex.js'] }));
    const spawnFn = jest.fn(() => fakeChild(1));
    expect(await runHarnessLoginStatus('codex', ['login', 'status'], { env: {}, platform: 'win32', resolve, spawnFn })).toBe(1);
    expect(spawnFn.mock.calls[0].slice(0, 2)).toEqual(['node.exe', ['C:\\npm\\codex.js', 'login', 'status']]);
  });

  test('a command it cannot resolve is no verdict, and nothing is spawned', async () => {
    const spawnFn = jest.fn();
    const code = await runHarnessLoginStatus('codex', ['login', 'status'], {
      env: {}, platform: 'win32', resolve: () => ({ command: null, reason: 'not found' }), spawnFn,
    });
    expect(code).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test('a probe that cannot start is no verdict', async () => {
    const child = new EventEmitter();
    child.kill = jest.fn();
    setImmediate(() => child.emit('error', new Error('ENOENT')));
    expect(await runHarnessLoginStatus('codex', ['login', 'status'], {
      env: {}, platform: 'darwin', spawnFn: () => child,
    })).toBeNull();
  });
});
