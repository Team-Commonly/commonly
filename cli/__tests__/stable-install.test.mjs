// F370: the stable under-$HOME install and the daemon-first setup sequence,
// with every side effect injected — no npm, no network, no child process.
import { jest } from '@jest/globals';

import {
  CLI_PACKAGE,
  MIN_NODE_MAJOR,
  stableCliDir,
  stableCliEntry,
  stableInstalledVersion,
  nodeTooOld,
  ensureStableCliInstall,
  orchestrateDaemonSetup,
} from '../src/lib/stable-install.js';

const HOME = '/home/tester';

describe('nodeTooOld', () => {
  it('names a Node older than the minimum', () => {
    const msg = nodeTooOld('v20.11.0');
    expect(msg).toMatch(new RegExp(`Node ${MIN_NODE_MAJOR} or newer`));
    expect(msg).toMatch(/nodejs\.org/);
  });

  it('passes the minimum and anything newer', () => {
    expect(nodeTooOld(`v${MIN_NODE_MAJOR}.0.0`)).toBeNull();
    expect(nodeTooOld('v24.3.1')).toBeNull();
  });

  it('does not block on an unparseable version', () => {
    expect(nodeTooOld('not-a-version')).toBeNull();
  });
});

describe('stable paths', () => {
  it('place the stable copy under ~/.commonly/cli', () => {
    expect(stableCliDir(HOME)).toBe('/home/tester/.commonly/cli');
    expect(stableCliEntry(HOME)).toBe(`/home/tester/.commonly/cli/node_modules/${CLI_PACKAGE}/src/index.js`);
  });
});

describe('stableInstalledVersion', () => {
  it('is null when the manifest is absent', () => {
    expect(stableInstalledVersion(HOME, { exists: () => false, readFile: () => '' })).toBeNull();
  });

  it('is the installed version when present', () => {
    expect(stableInstalledVersion(HOME, {
      exists: () => true,
      readFile: () => JSON.stringify({ version: '0.1.300' }),
    })).toBe('0.1.300');
  });

  it('is null when the manifest is unreadable', () => {
    expect(stableInstalledVersion(HOME, { exists: () => true, readFile: () => 'not json' })).toBeNull();
  });
});

describe('ensureStableCliInstall', () => {
  it('installs with --prefix under $HOME and the quiet flags when the version differs', async () => {
    const runInstall = jest.fn().mockResolvedValue(undefined);
    const mkdir = jest.fn();
    const result = await ensureStableCliInstall({
      version: '0.1.300', home: HOME, mkdir, runInstall, installedVersion: () => null,
    });
    expect(mkdir).toHaveBeenCalledWith('/home/tester/.commonly/cli');
    expect(runInstall).toHaveBeenCalledTimes(1);
    const [args] = runInstall.mock.calls[0];
    expect(args).toEqual(['install', '--prefix', '/home/tester/.commonly/cli', '--no-audit', '--no-fund', `${CLI_PACKAGE}@0.1.300`]);
    expect(result).toEqual(expect.objectContaining({ installed: true, version: '0.1.300' }));
    expect(result.entry).toBe(stableCliEntry(HOME));
  });

  it('does nothing when the stable copy is already at the version', async () => {
    const runInstall = jest.fn();
    const result = await ensureStableCliInstall({
      version: '0.1.300', home: HOME, mkdir: jest.fn(), runInstall, installedVersion: () => '0.1.300',
    });
    expect(runInstall).not.toHaveBeenCalled();
    expect(result.installed).toBe(false);
  });

  it('refuses without a version to pin', async () => {
    await expect(ensureStableCliInstall({ home: HOME })).rejects.toThrow(/version/);
  });
});

describe('orchestrateDaemonSetup', () => {
  const okRun = () => {
    const calls = [];
    const runCli = jest.fn((entry, args) => { calls.push(args); return Promise.resolve(); });
    return { calls, runCli };
  };
  const ensureStable = jest.fn(async () => ({ entry: stableCliEntry(HOME) }));

  it('runs login, register, then install as the stable CLI, in order', async () => {
    const { calls, runCli } = okRun();
    const out = await orchestrateDaemonSetup({
      version: '0.1.300', instanceUrl: 'https://x.example', runCli, nodeVersion: 'v22.0.0', ensureStable, home: HOME,
    });
    expect(ensureStable).toHaveBeenCalledWith(expect.objectContaining({ version: '0.1.300', home: HOME }));
    expect(calls).toEqual([
      ['login', '--instance', 'https://x.example'],
      ['daemon', 'register', '--instance', 'https://x.example'],
      ['daemon', 'install'],
    ]);
    expect(runCli).toHaveBeenCalledWith(stableCliEntry(HOME), expect.any(Array));
    expect(out.entry).toBe(stableCliEntry(HOME));
  });

  it('omits --instance when none is given, and never on install', async () => {
    const { calls, runCli } = okRun();
    await orchestrateDaemonSetup({
      version: '0.1.300', runCli, nodeVersion: 'v22.0.0', ensureStable, home: HOME,
    });
    expect(calls).toEqual([['login'], ['daemon', 'register'], ['daemon', 'install']]);
  });

  it('forwards --unsandboxed to the install step only', async () => {
    const { calls, runCli } = okRun();
    await orchestrateDaemonSetup({
      version: '0.1.300', runCli, unsandboxed: true, nodeVersion: 'v22.0.0', ensureStable, home: HOME,
    });
    expect(calls).toEqual([['login'], ['daemon', 'register'], ['daemon', 'install', '--unsandboxed']]);
  });

  it('stops the chain when login fails: register and install never run', async () => {
    const calls = [];
    const runCli = jest.fn((entry, args) => {
      calls.push(args);
      return args[0] === 'login' ? Promise.reject(new Error('device auth refused')) : Promise.resolve();
    });
    await expect(orchestrateDaemonSetup({
      version: '0.1.300', runCli, nodeVersion: 'v22.0.0', ensureStable, home: HOME,
    })).rejects.toThrow(/device auth refused/);
    expect(calls).toEqual([['login']]);
  });

  it('refuses on a too-old Node before touching the install', async () => {
    const ensure = jest.fn();
    const runCli = jest.fn();
    await expect(orchestrateDaemonSetup({
      version: '0.1.300', runCli, nodeVersion: 'v20.0.0', ensureStable: ensure, home: HOME,
    })).rejects.toThrow(new RegExp(`Node ${MIN_NODE_MAJOR}`));
    expect(ensure).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
  });

  it('refuses without a runCli function', async () => {
    await expect(orchestrateDaemonSetup({
      version: '0.1.300', nodeVersion: 'v22.0.0', ensureStable, home: HOME,
    })).rejects.toThrow(/runCli/);
  });
});
