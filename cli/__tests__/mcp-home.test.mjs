/**
 * mcp-home.test.mjs — TASK-174, the spawn path.
 *
 * The defect: every seat declared `npx -y @commonlyai/mcp@latest`, whose npx dir
 * is keyed by the spec string, so all seats shared one dir that a spawn rewrote
 * in place after a publish — and every npx run did registry + lock work before
 * the server started. This file witnesses the replacement: a spawn reads a
 * pointer file and exec's `node <bin>` from a version dir, and NOTHING on the
 * spawn path touches the network.
 *
 * The fixtures carry the shape the package actually has at 0.3.13 —
 * `bin: { 'commonly-mcp': 'src/index.js' }`, `type: 'module'`, no `main` — taken
 * from an installed copy, because a fixture that carries a different shape
 * proves a fact about the fixture.
 */
import { jest } from '@jest/globals';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  KEEP_VERSION_DIRS, REGISTRY_TTL_MS, STALE_LOCK_MS, WARM_RESULTS,
  lockPathFor, mcpHomeDir, newestInstalledVersion, planMcpSpawn, prepareMcpSpawn,
  readBinPath, readCurrentVersion, readRegistryCache, warmLooksWanted,
} from '../src/lib/mcp-home.js';
import { acquireWarmLock, pruneVersionDirs, resolveRegistryLatest, warmMcpHome } from '../src/lib/mcp-warm-child.mjs';

const SHIPPED_COMMAND = ['npx', '-y', '@commonlyai/mcp@latest'];

const makeHome = () => mkdtempSync(join(tmpdir(), 'commonly-mcp-home-'));

/** The package tree under a prefix dir — the shape `npm install --prefix <dir>` leaves. */
const writePackage = (dir, version, { bin = 'src/index.js', name = '@commonlyai/mcp', writeBin = true } = {}) => {
  const pkgDir = join(dir, 'node_modules', '@commonlyai/mcp');
  mkdirSync(join(pkgDir, dirname(bin)), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name, version, type: 'module', files: ['src', 'README.md', 'package.json'], bin: { 'commonly-mcp': bin },
  }));
  if (writeBin) writeFileSync(join(pkgDir, bin), '#!/usr/bin/env node\n');
  return join(pkgDir, bin);
};

/** A version dir in the seat's home, in the shape the published package has. */
const installVersion = (home, version, options) => writePackage(join(home, version), version, options);

const pointAt = (home, version) => {
  writeFileSync(join(home, 'current'), `${version}\n`);
};

afterAll(() => {
  // Temp homes are tiny and the OS reaps them; leaving them makes a failure
  // reproducible by hand from the printed path.
});

describe('planMcpSpawn — what a spawn executes', () => {
  test('a warmed home turns the shipped declaration into `node <bin>`', () => {
    const home = makeHome();
    const bin = installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');

    const plan = planMcpSpawn(SHIPPED_COMMAND, { home });

    expect(plan.source).toBe('home');
    expect(plan.version).toBe('0.3.13');
    expect(plan.command).toEqual(['node', bin]);
    expect(plan.command.join(' ')).not.toContain('npx');
  });

  test('an empty home runs the declaration as written, and says which state it was', () => {
    const home = makeHome();
    const plan = planMcpSpawn(SHIPPED_COMMAND, { home });

    expect(plan.source).toBe('declared');
    expect(plan.command).toEqual(SHIPPED_COMMAND);
    expect(plan.reason).toBe('home-empty');
  });

  test('positive control: the SAME populated home leaves an operator-pinned spec alone', () => {
    // Without this control the empty-home arm above would also pass if the
    // function simply returned its input — the arm has to be able to fail.
    const home = makeHome();
    installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');

    const pinned = planMcpSpawn(['npx', '-y', '@commonlyai/mcp@0.3.5'], { home });
    const unpinned = planMcpSpawn(SHIPPED_COMMAND, { home });

    expect(pinned).toEqual({
      command: ['npx', '-y', '@commonlyai/mcp@0.3.5'],
      source: 'declared',
      version: null,
      reason: 'not-the-shipped-unpinned-spec',
    });
    expect(unpinned.source).toBe('home');
  });

  test('a pointer whose bin was deleted under the seat falls back to the newest local build', () => {
    const home = makeHome();
    installVersion(home, '0.3.12');
    const newest = installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');
    // The failure this covers: a hand-prune, or a version dir removed under a
    // live seat. `current` still names it, but nothing runnable is there.
    rmSync(join(home, '0.3.13', 'node_modules', '@commonlyai', 'mcp', 'src', 'index.js'), { force: true });

    const plan = planMcpSpawn(SHIPPED_COMMAND, { home });

    expect(plan.source).toBe('home');
    expect(plan.reason).toBe('pointer-bin-missing');
    expect(plan.version).toBe('0.3.12');
    expect(plan.command[1]).toContain('0.3.12');
    expect(plan.command[1]).not.toBe(newest);
  });

  test('the pointer wins over a NEWER dir that the warm has not verified', () => {
    // A version dir exists only after its bin answered `initialize` (the warm
    // renames it in), but the POINTER is what an install that has not finished
    // switching must not be able to move: a dir can be renamed in and the process
    // killed before the pointer is written.
    const home = makeHome();
    installVersion(home, '0.3.14');
    installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');

    const plan = planMcpSpawn(SHIPPED_COMMAND, { home });

    expect(plan.reason).toBe('pointer');
    expect(plan.version).toBe('0.3.13');
  });

  test('a home with no runnable version dir at all is the declared command', () => {
    const home = makeHome();
    mkdirSync(join(home, '0.3.13'), { recursive: true }); // exists, no package.json
    pointAt(home, '0.3.13');

    expect(planMcpSpawn(SHIPPED_COMMAND, { home }).command).toEqual(SHIPPED_COMMAND);
  });

  test('commands that are not the shipped server are untouched', () => {
    const home = makeHome();
    installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');

    for (const command of [
      ['npx', '-y', 'some-other-mcp'],
      ['node', '/opt/other/index.js'],
      ['npx', '-y'],
      ['npx', '@commonlyai/mcp'],
    ]) {
      // `npx @commonlyai/mcp` (no -y) is not the shipped 3-arg form, so it is
      // not ours to rewrite either.
      expect(planMcpSpawn(command, { home }).command).toEqual(command);
    }
  });

  test('readCurrentVersion refuses a pointer it cannot parse rather than building a path from it', () => {
    const home = makeHome();
    for (const value of ['', '\n', 'latest', '../../etc', 'v0.3.13']) {
      writeFileSync(join(home, 'current'), value);
      expect(readCurrentVersion(home)).toBeNull();
    }
    writeFileSync(join(home, 'current'), ' 0.3.13 \n');
    expect(readCurrentVersion(home)).toBe('0.3.13');
  });

  test('readBinPath reads a bare-string bin too, and refuses a foreign package.json', () => {
    const home = makeHome();
    const pkgDir = join(home, '0.3.9', 'node_modules', '@commonlyai/mcp');
    mkdirSync(join(pkgDir, 'dist'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@commonlyai/mcp', version: '0.3.9', bin: 'dist/index.js' }));
    writeFileSync(join(pkgDir, 'dist/index.js'), '');

    expect(readBinPath(home, '0.3.9')).toBe(join(pkgDir, 'dist/index.js'));

    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@other/mcp', version: '0.3.9', bin: 'dist/index.js' }));
    expect(readBinPath(home, '0.3.9')).toBeNull();
  });

  test('newestInstalledVersion ignores names that are not versions and dirs with no bin', () => {
    const home = makeHome();
    installVersion(home, '0.3.9');
    installVersion(home, '0.3.11');
    mkdirSync(join(home, '.tmp-0.3.99-1'), { recursive: true });
    mkdirSync(join(home, 'node_modules'), { recursive: true });

    expect(newestInstalledVersion(home)).toBe('0.3.11');
  });
});

describe('prepareMcpSpawn — the warm is kicked when it is due, and only then', () => {
  const warmSpy = () => {
    const calls = [];
    const spawnImpl = (cmd, args) => {
      calls.push({ cmd, args });
      return { unref: jest.fn() };
    };
    return { calls, spawnImpl };
  };

  test('an empty home kicks exactly one warm and still runs the declaration', () => {
    const home = makeHome();
    const { calls, spawnImpl } = warmSpy();

    const command = prepareMcpSpawn(SHIPPED_COMMAND, { home, spawnImpl, childPath: '/tmp/warm-child.mjs', apiUrl: 'https://api.example.test' });

    expect(command).toEqual(SHIPPED_COMMAND);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['/tmp/warm-child.mjs', home]);
  });

  test('a warm already running (lock present) is not started twice', () => {
    const home = makeHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(lockPathFor(home), '1\n');
    const { calls, spawnImpl } = warmSpy();

    prepareMcpSpawn(SHIPPED_COMMAND, { home, spawnImpl, childPath: '/tmp/warm-child.mjs' });

    expect(calls).toEqual([]);
  });

  test('a fresh cache saying current == latest does not kick', () => {
    const home = makeHome();
    installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');
    writeFileSync(join(home, '.registry.json'), JSON.stringify({ version: '0.3.13', checkedAt: Date.now() }));
    const { calls, spawnImpl } = warmSpy();

    const command = prepareMcpSpawn(SHIPPED_COMMAND, { home, spawnImpl, childPath: '/tmp/warm-child.mjs' });

    expect(command[0]).toBe('node');
    expect(calls).toEqual([]);
  });

  test('a fresh cache naming a NEWER version kicks, and the spawn still runs the local build', () => {
    const home = makeHome();
    installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');
    writeFileSync(join(home, '.registry.json'), JSON.stringify({ version: '0.3.14', checkedAt: Date.now() }));
    const { calls, spawnImpl } = warmSpy();

    const command = prepareMcpSpawn(SHIPPED_COMMAND, { home, spawnImpl, childPath: '/tmp/warm-child.mjs' });

    expect(calls).toHaveLength(1);
    expect(command[1]).toContain('0.3.13');
    expect(command[1]).not.toContain('0.3.14');
  });

  test('an expired cache kicks even when the home looks current', () => {
    const home = makeHome();
    installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');
    writeFileSync(join(home, '.registry.json'), JSON.stringify({ version: '0.3.13', checkedAt: Date.now() - REGISTRY_TTL_MS - 1000 }));
    const { calls, spawnImpl } = warmSpy();

    prepareMcpSpawn(SHIPPED_COMMAND, { home, spawnImpl, childPath: '/tmp/warm-child.mjs' });

    expect(calls).toHaveLength(1);
  });

  test('a broken home never costs the seat its tools', () => {
    const home = makeHome();
    const readFile = () => { throw new Error('EIO: i/o error, read'); };

    expect(prepareMcpSpawn(SHIPPED_COMMAND, { home, readFile, spawnImpl: () => ({ unref: () => {} }) }))
      .toEqual(SHIPPED_COMMAND);
  });

  test('warmLooksWanted treats a missing or unparseable cache as wanted', () => {
    const home = makeHome();
    expect(warmLooksWanted(home, null)).toBe(true);
    writeFileSync(join(home, '.registry.json'), 'not json');
    expect(warmLooksWanted(home, '0.3.13')).toBe(true);
    expect(readRegistryCache(home)).toBeNull();
    writeFileSync(join(home, '.registry.json'), JSON.stringify({ version: '0.3.13', checkedAt: Date.now() }));
    expect(warmLooksWanted(home, '0.3.13')).toBe(false);
    expect(warmLooksWanted(home, '0.3.12')).toBe(true);
  });

  test('mcpHomeDir honours the override', () => {
    expect(mcpHomeDir({ COMMONLY_MCP_HOME: '/tmp/some-home' })).toBe('/tmp/some-home');
    expect(mcpHomeDir({})).toContain(join('.commonly', 'mcp'));
  });
});

describe('acquireWarmLock — single flight, and a dead warm is not a wedge', () => {
  test('a fresh lock belongs to the live warm and is not stolen', () => {
    const home = makeHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(lockPathFor(home), 'live\n');

    expect(acquireWarmLock(home, { now: Date.now() })).toBeNull();
  });

  test('a lock older than the stale window is reclaimed', () => {
    const home = makeHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(lockPathFor(home), 'dead\n');
    const old = (Date.now() - STALE_LOCK_MS - 60_000) / 1000;
    utimesSync(lockPathFor(home), old, old);

    const fd = acquireWarmLock(home, { now: Date.now() });
    expect(fd).not.toBeNull();
    // Held: a second attempt while held is refused.
    expect(acquireWarmLock(home, { now: Date.now() })).toBeNull();
  });

  test('a lock file that vanished between EEXIST and stat is not broken', () => {
    const home = makeHome();
    const fd = acquireWarmLock(home, {
      open: () => { const e = new Error('exists'); e.code = 'EEXIST'; throw e; },
      stat: () => { const e = new Error('gone'); e.code = 'ENOENT'; throw e; },
    });
    expect(fd).toBeNull();
  });
});

describe('resolveRegistryLatest — the only networked read, cached', () => {
  test('a fresh cache is used without running npm', async () => {
    const home = makeHome();
    writeFileSync(join(home, '.registry.json'), JSON.stringify({ version: '0.3.13', checkedAt: Date.now() }));
    const exec = jest.fn();

    const result = await resolveRegistryLatest(home, { exec, now: Date.now() });

    expect(result).toEqual({ version: '0.3.13', source: 'cache' });
    expect(exec).not.toHaveBeenCalled();
  });

  test('a stale cache runs npm and rewrites the cache', async () => {
    const home = makeHome();
    writeFileSync(join(home, '.registry.json'), JSON.stringify({ version: '0.3.12', checkedAt: Date.now() - REGISTRY_TTL_MS - 1 }));
    const exec = jest.fn(async () => ({ ok: true, stdout: '"0.3.13"\n' }));

    const result = await resolveRegistryLatest(home, { exec, now: Date.now() });

    expect(result).toEqual({ version: '0.3.13', source: 'registry' });
    expect(readRegistryCache(home).version).toBe('0.3.13');
  });

  test('registry down: the last known version is kept, and no throw', async () => {
    const home = makeHome();
    writeFileSync(join(home, '.registry.json'), JSON.stringify({ version: '0.3.12', checkedAt: Date.now() - REGISTRY_TTL_MS - 1 }));
    const exec = jest.fn(async () => ({ ok: false, stdout: '', stderr: 'ENOTFOUND registry.npmjs.org' }));

    expect(await resolveRegistryLatest(home, { exec, now: Date.now() }))
      .toEqual({ version: '0.3.12', source: 'stale-cache' });
  });

  test('registry down with no cache at all is unavailable, not a guess', async () => {
    const home = makeHome();
    const exec = jest.fn(async () => ({ ok: false, stdout: '' }));

    expect(await resolveRegistryLatest(home, { exec, now: Date.now() }))
      .toEqual({ version: null, source: 'unavailable' });
  });

  test('garbage from the registry is not a version', async () => {
    const home = makeHome();
    const exec = jest.fn(async () => ({ ok: true, stdout: 'npm ERR! code E404\n' }));

    expect(await resolveRegistryLatest(home, { exec, now: Date.now() }).then((r) => r.version)).toBeNull();
  });
});

describe('warmMcpHome — install, probe, then move the pointer', () => {
  const fakeInstall = (home, version, { probe = true, ok = true } = {}) => {
    const exec = jest.fn(async (bin, args) => {
      if (bin === 'npm' && args[0] === 'view') return { ok: true, stdout: `"${version}"\n` };
      if (bin === 'npm' && args[0] === 'install') {
        if (!ok) return { ok: false, code: 1, stderr: 'EACCES' };
        // args = ['install', '--prefix', <temp>, <spec>, ...]
        writePackage(args[2], version);
        return { ok: true, stdout: 'added 1 package\n' };
      }
      return { ok: false, stdout: '' };
    });
    return { exec, probe: jest.fn(async () => probe) };
  };

  test('a newer version is installed by EXACT spec, probed, then pointed at', async () => {
    const home = makeHome();
    installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');
    const { exec, probe } = fakeInstall(home, '0.3.14');

    const result = await warmMcpHome(home, { exec, probe, now: Date.now() });

    expect(result).toBe(WARM_RESULTS.ADVANCED);
    expect(readCurrentVersion(home)).toBe('0.3.14');
    const installArgs = exec.mock.calls.find(([, args]) => args[0] === 'install')[1];
    expect(installArgs).toContain('@commonlyai/mcp@0.3.14');
    expect(installArgs.join(' ')).not.toContain('@latest');
    // Probed INSIDE the temp dir, before the rename: that ordering is what
    // makes "a version dir in the home" mean "a build that answered the
    // protocol at least once".
    expect(probe.mock.calls[0][0]).toContain('.tmp-0.3.14-');
    expect(probe.mock.calls[0][0]).toContain(join('node_modules', '@commonlyai', 'mcp', 'src', 'index.js'));
    // The temp dir is gone; only version dirs remain.
    expect(readdirSync(home).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
    // And the lock is released, so the next spawn's warm can run.
    expect(existsSync(lockPathFor(home))).toBe(false);
  });

  test('old version dirs are pruned once the pointer has moved', async () => {
    // Not the same arm as the pruneVersionDirs unit test: this one witnesses
    // that the WARM calls it. Without it a home grows by one build per publish
    // forever, and nothing goes red until a disk fills.
    const home = makeHome();
    ['0.3.9', '0.3.10', '0.3.11', '0.3.12'].forEach((v) => installVersion(home, v));
    pointAt(home, '0.3.12');
    const { exec, probe } = fakeInstall(home, '0.3.13');

    expect(await warmMcpHome(home, { exec, probe, now: Date.now() })).toBe(WARM_RESULTS.ADVANCED);

    expect(readdirSync(home).filter((n) => !n.startsWith('.') && n !== 'current').sort())
      .toEqual(['0.3.11', '0.3.12', '0.3.13']);
  });

  test('a build that does not answer initialize never becomes current', async () => {
    const home = makeHome();
    installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');
    const { exec, probe } = fakeInstall(home, '0.3.14', { probe: false });

    const result = await warmMcpHome(home, { exec, probe, now: Date.now() });

    expect(result).toBe(WARM_RESULTS.PROBE_FAILED);
    expect(readCurrentVersion(home)).toBe('0.3.13');
    expect(existsSync(join(home, '0.3.14'))).toBe(false);
    expect(readdirSync(home).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  test('a failed install leaves the pointer and the home alone', async () => {
    const home = makeHome();
    installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');
    const { exec, probe } = fakeInstall(home, '0.3.14', { ok: false });

    expect(await warmMcpHome(home, { exec, probe, now: Date.now() })).toBe(WARM_RESULTS.INSTALL_FAILED);
    expect(readCurrentVersion(home)).toBe('0.3.13');
    expect(probe).not.toHaveBeenCalled();
  });

  test('a second warm while the first holds the lock does no work at all', async () => {
    const home = makeHome();
    installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');
    const { exec, probe } = fakeInstall(home, '0.3.14');
    const held = () => 7;
    const release = jest.fn();

    const [first, second] = await Promise.all([
      warmMcpHome(home, { exec, probe, lock: held, closeLock: release }),
      warmMcpHome(home, { exec, probe, lock: () => null, closeLock: release }),
    ]);

    expect([first, second].sort()).toEqual([WARM_RESULTS.ADVANCED, WARM_RESULTS.LOCKED].sort());
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'install')).toHaveLength(1);
  });

  test('a registry outage is a no-op that keeps the current version', async () => {
    const home = makeHome();
    installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');
    const exec = jest.fn(async () => ({ ok: false, stdout: '' }));

    expect(await warmMcpHome(home, { exec, probe: jest.fn(), now: Date.now() })).toBe(WARM_RESULTS.REGISTRY_UNAVAILABLE);
    expect(readCurrentVersion(home)).toBe('0.3.13');
  });

  test('current == latest does no install and no probe', async () => {
    const home = makeHome();
    installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');
    const { exec, probe } = fakeInstall(home, '0.3.13');

    expect(await warmMcpHome(home, { exec, probe, now: Date.now() })).toBe(WARM_RESULTS.CURRENT);
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'install')).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  test('the lock is released even when the warm throws', async () => {
    const home = makeHome();
    const closeLock = jest.fn();
    await warmMcpHome(home, {
      lock: () => 3,
      closeLock,
      exec: async () => { throw new Error('boom'); },
      probe: jest.fn(),
    });
    expect(closeLock).toHaveBeenCalledWith(3);
    expect(existsSync(lockPathFor(home))).toBe(false);
  });
});

describe('pruneVersionDirs', () => {
  test('keeps the newest N and removes the rest', () => {
    const home = makeHome();
    ['0.3.9', '0.3.10', '0.3.11', '0.3.12', '0.3.13'].forEach((v) => installVersion(home, v));

    const removed = pruneVersionDirs(home, '0.3.13', { keep: KEEP_VERSION_DIRS });

    expect(readdirSync(home).sort()).toEqual(['0.3.11', '0.3.12', '0.3.13']);
    expect(removed.sort()).toEqual(['0.3.10', '0.3.9']);
  });

  test('a current version outside the newest N survives, because a live spawn may be reading it', () => {
    const home = makeHome();
    ['0.3.9', '0.3.10', '0.3.11', '0.3.12', '0.3.13'].forEach((v) => installVersion(home, v));

    // 0.3.10 is older than the newest three and is still the pointer. Removing
    // it would break the seats running it, so it costs one extra dir until the
    // warm moves the pointer on — which is the trade this rule chooses.
    const removed = pruneVersionDirs(home, '0.3.10', { keep: KEEP_VERSION_DIRS });

    expect(readdirSync(home).sort()).toEqual(['0.3.10', '0.3.11', '0.3.12', '0.3.13']);
    expect(removed).toEqual(['0.3.9']);
  });

  test('a dir it cannot remove does not fail the warm', () => {
    const home = makeHome();
    installVersion(home, '0.3.9');
    installVersion(home, '0.3.13');
    const remove = jest.fn(() => { throw new Error('EBUSY'); });

    expect(() => pruneVersionDirs(home, '0.3.13', { keep: 1, remove })).not.toThrow();
    expect(statSync(join(home, '0.3.9')).isDirectory()).toBe(true);
  });
});
