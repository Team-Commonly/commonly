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
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  KEEP_VERSION_DIRS, PRUNE_GRACE_MS, REGISTRY_TTL_MS, STALE_LOCK_MS, WARM_RESULTS,
  claimInUse, inUseMarkerPath, isPidAlive, isUsableWarmHome, kickWarm, lockPathFor,
  liveInUsePids, mcpHomeDir, newestInstalledVersion, planMcpSpawn, prepareMcpSpawn,
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

/** Age a version dir, so a rule stated in TIME can be exercised. */
const OLD_MS = 48 * 60 * 60 * 1000;
const backdate = (path, msAgo = OLD_MS) => {
  const when = new Date(Date.now() - msAgo);
  utimesSync(path, when, when);
};

/** A pid that is certainly gone: a child that ran to completion and was reaped. */
const deadPid = () => {
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  return child.pid;
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

  test('a bin that escapes the package dir is refused, not exec’d', () => {
    // The published package is ours, so this cannot happen today. The check is
    // one line and makes the exec path self-evident rather than trusted (Vera,
    // 74880). The escaping target EXISTS, so a null here is the confinement and
    // not the `exists` check doing the work.
    const home = makeHome();
    const pkgDir = join(home, '0.3.13', 'node_modules', '@commonlyai', 'mcp');
    // Derived from `pkgDir` with the same join the reader uses, and asserted to be
    // outside it: the first draft of this arm placed the file at a path the join
    // never resolves to, so the `exists` check — not the confinement — was doing
    // the work and the mutation that removes the confinement SURVIVED.
    const escapeTarget = join(pkgDir, '../../escape/evil.js');
    mkdirSync(dirname(escapeTarget), { recursive: true });
    writeFileSync(escapeTarget, '#!/usr/bin/env node\n');
    expect(escapeTarget.startsWith(pkgDir)).toBe(false);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': '../../escape/evil.js' },
    }));

    expect(readBinPath(home, '0.3.13')).toBeNull();

    // Positive control: the same fixture with a contained bin resolves, so the
    // arm above is the path check and not a fixture that resolves to nothing.
    mkdirSync(join(pkgDir, 'src'), { recursive: true });
    writeFileSync(join(pkgDir, 'src', 'index.js'), '#!/usr/bin/env node\n');
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': 'src/index.js' },
    }));
    expect(readBinPath(home, '0.3.13')).toBe(join(pkgDir, 'src', 'index.js'));
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

  test('the home override refuses a junk value: `env.X = undefined` writes the STRING', () => {
    // The incident this comes from, in one line: a caller saved an unset override
    // and restored it with `process.env.COMMONLY_MCP_HOME = previous` while
    // previous was undefined — which SETS THE STRING "undefined". The warm then
    // created `./undefined/`, installed into it, and pointed at it, inside the
    // package directory. A path variable is not obliged to hold a path, so both
    // the reader and the child check.
    for (const junk of ['undefined', 'null', '', null, undefined]) {
      expect(mcpHomeDir({ COMMONLY_MCP_HOME: junk })).toContain(join('.commonly', 'mcp'));
    }
    expect(mcpHomeDir({ COMMONLY_MCP_HOME: '/tmp/a-real-home' })).toBe('/tmp/a-real-home');
    expect(isUsableWarmHome('/tmp/a-real-home')).toBe(true);
    for (const bad of ['undefined', 'null', '', 'relative/home', '.', undefined, null, 42]) {
      expect(isUsableWarmHome(bad)).toBe(false);
    }
  });

  test('kickWarm never hands the child the literal string "undefined"', () => {
    const calls = [];
    const spawnImpl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { unref: () => {} };
    };

    kickWarm({ home: undefined, spawnImpl, childPath: '/tmp/warm-child.mjs' });

    expect(calls[0].args[1]).not.toBe('undefined');
    // The configured home here is the empty temp dir the jest setup installs, or
    // the real `~/.commonly/mcp` outside it — either way a real, absolute path.
    expect(isUsableWarmHome(calls[0].args[1])).toBe(true);
    // The child reads the same value from its env, so the two cannot disagree.
    expect(calls[0].opts.env.COMMONLY_MCP_HOME).toBe(calls[0].args[1]);
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
    // The dirs being pruned must be past the grace window; the fixture's age is
    // the real variable here, so it is set rather than simulated.
    ['0.3.9', '0.3.10'].forEach((v) => backdate(join(home, v)));
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

describe('pruneVersionDirs — a count bounds disk, liveness and time bound risk', () => {
  test('keeps the newest N and removes the rest', () => {
    const home = makeHome();
    ['0.3.9', '0.3.10', '0.3.11', '0.3.12', '0.3.13'].forEach((v) => installVersion(home, v));
    // The candidates are old: the count decides WHICH are candidates, the grace
    // window decides whether being past the count is enough.
    ['0.3.9', '0.3.10'].forEach((v) => backdate(join(home, v)));

    const removed = pruneVersionDirs(home, '0.3.13', { keep: KEEP_VERSION_DIRS });

    expect(readdirSync(home).sort()).toEqual(['0.3.11', '0.3.12', '0.3.13']);
    expect(removed.sort()).toEqual(['0.3.10', '0.3.9']);
  });

  test('a current version outside the newest N survives, because a live spawn may be reading it', () => {
    const home = makeHome();
    ['0.3.9', '0.3.10', '0.3.11', '0.3.12', '0.3.13'].forEach((v) => installVersion(home, v));
    ['0.3.9', '0.3.10'].forEach((v) => backdate(join(home, v)));

    // 0.3.10 is older than the newest three and is still the pointer. Removing
    // it would break the seats running it, so it costs one extra dir until the
    // warm moves the pointer on — which is the trade this rule chooses.
    const removed = pruneVersionDirs(home, '0.3.10', { keep: KEEP_VERSION_DIRS });

    expect(readdirSync(home).sort()).toEqual(['0.3.10', '0.3.11', '0.3.12', '0.3.13']);
    expect(removed).toEqual(['0.3.9']);
  });

  test('a NON-current, non-newest dir with a LIVE claim survives — the arm the count cannot express', () => {
    // Vera's hold (74878): nothing recorded which version a live spawn was
    // executing, so a seat that started on 0.3.10 and had seen three advances
    // had its dir removed under it. This is that seat, claiming its own dir.
    const home = makeHome();
    ['0.3.9', '0.3.10', '0.3.11', '0.3.12', '0.3.13'].forEach((v) => installVersion(home, v));
    claimInUse({ home, version: '0.3.10', pid: process.pid });   // this test process is alive
    ['0.3.9', '0.3.10'].forEach((v) => backdate(join(home, v)));   // installed long ago

    const removed = pruneVersionDirs(home, '0.3.13', { keep: KEEP_VERSION_DIRS });

    expect(readdirSync(home)).toContain('0.3.10');
    expect(removed).toEqual(['0.3.9']);
  });

  test('the marker FILE is not the signal: a dead claimant does not pin its dir', () => {
    // A seat that is killed leaves `.inuse/<pid>` behind. A pruner that read
    // presence would never remove that version again — unbounded disk with extra
    // steps (Vera, 74889). The check is whether the claimant still exists.
    const home = makeHome();
    const gone = deadPid();
    ['0.3.9', '0.3.13'].forEach((v) => installVersion(home, v));
    mkdirSync(join(home, '0.3.9', '.inuse'), { recursive: true });
    writeFileSync(inUseMarkerPath(home, '0.3.9', gone), '');
    // Backdated AFTER the marker: adding an entry to a directory moves that
    // directory's mtime, and the age under test is the INSTALL age — the real
    // order is install, then (hours later) a spawn writing its claim.
    backdate(join(home, '0.3.9'));

    expect(isPidAlive(gone)).toBe(false);
    expect(liveInUsePids(home, '0.3.9')).toEqual([]);

    const removed = pruneVersionDirs(home, '0.3.13', { keep: 1 });

    expect(removed).toEqual(['0.3.9']);
    expect(existsSync(join(home, '0.3.9'))).toBe(false);
  });

  test('an unparseable marker is absent, not alive', () => {
    const home = makeHome();
    ['0.3.9', '0.3.13'].forEach((v) => installVersion(home, v));
    mkdirSync(join(home, '0.3.9', '.inuse'), { recursive: true });
    writeFileSync(join(home, '0.3.9', '.inuse', 'not-a-pid'), '');
    backdate(join(home, '0.3.9'));

    expect(liveInUsePids(home, '0.3.9')).toEqual([]);
    expect(pruneVersionDirs(home, '0.3.13', { keep: 1 })).toEqual(['0.3.9']);
  });

  test('isPidAlive: EPERM is alive, ESRCH is dead, a non-pid is dead', () => {
    const eperm = () => { const e = new Error('nope'); e.code = 'EPERM'; throw e; };
    const esrch = () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e; };

    expect(isPidAlive(4242, { kill: eperm })).toBe(true);
    expect(isPidAlive(4242, { kill: esrch })).toBe(false);
    expect(isPidAlive(0, { kill: eperm })).toBe(false);
    expect(isPidAlive('not-a-pid', { kill: eperm })).toBe(false);
    expect(isPidAlive(null, { kill: eperm })).toBe(false);
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test('a dir inside the grace window survives even with no claimant', () => {
    // A spawn that is starting up has not written its claim yet. Time is what
    // bounds that exposure, and the window is stated rather than implied.
    const home = makeHome();
    ['0.3.9', '0.3.13'].forEach((v) => installVersion(home, v));

    expect(pruneVersionDirs(home, '0.3.13', { keep: 1 })).toEqual([]);
    expect(existsSync(join(home, '0.3.9'))).toBe(true);
    // …and the same dir past the window is removed, so the rule is a window and
    // not an exemption.
    backdate(join(home, '0.3.9'), PRUNE_GRACE_MS + 60_000);
    expect(pruneVersionDirs(home, '0.3.13', { keep: 1 })).toEqual(['0.3.9']);
  });

  test('a dir with no readable mtime is left alone', () => {
    const home = makeHome();
    ['0.3.9', '0.3.13'].forEach((v) => installVersion(home, v));
    const mtime = () => null;

    expect(pruneVersionDirs(home, '0.3.13', { keep: 1, mtime })).toEqual([]);
    expect(existsSync(join(home, '0.3.9'))).toBe(true);
  });

  test('the REAL mtime reader leaves an unstat-able dir alone (the production fallback, not an injected one)', () => {
    // Vera's survivor (74902): the arm above injects `mtime: () => null`, which
    // witnesses the CONSUMER's `typeof !== 'number'` branch and never the
    // production fallback — the `catch` inside the DEFAULT reader, which is what
    // runs when `statSync` throws. Changing that catch to `return 0` passed all
    // 49 tests: an unreadable dir became "maximally old" and was pruned, the
    // hazard the branch exists to prevent. This arm uses the default reader, on a
    // version the directory listing reports and the filesystem does not have.
    const home = makeHome();
    ['0.3.11', '0.3.12', '0.3.13'].forEach((v) => installVersion(home, v));
    const remove = jest.fn();
    // 0.3.9 is past the count, so it IS a prune candidate — and it is gone from
    // disk, so the real reader's statSync throws. `keeps the newest N and removes
    // the rest` is the positive control: the same default reader prunes the same
    // shape of candidate when it CAN read the mtime.
    const readDir = () => ['0.3.9', '0.3.11', '0.3.12', '0.3.13'];

    const removed = pruneVersionDirs(home, '0.3.13', { keep: 3, remove, readDir });

    expect(removed).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
    expect(existsSync(join(home, '0.3.9'))).toBe(false);
  });

  test('a dir it cannot remove does not fail the warm', () => {
    const home = makeHome();
    installVersion(home, '0.3.9');
    installVersion(home, '0.3.13');
    backdate(join(home, '0.3.9'));
    const remove = jest.fn(() => { throw new Error('EBUSY'); });

    expect(() => pruneVersionDirs(home, '0.3.13', { keep: 1, remove })).not.toThrow();
    expect(statSync(join(home, '0.3.9')).isDirectory()).toBe(true);
  });
});

describe('the spawn claims the version it is about to run', () => {
  test('prepareMcpSpawn leaves a live claim naming this process', () => {
    const home = makeHome();
    installVersion(home, '0.3.13');
    pointAt(home, '0.3.13');

    prepareMcpSpawn(SHIPPED_COMMAND, { home, now: Date.now(), spawnImpl: () => ({ unref: () => {} }) });

    // The claim is what makes the pair of arms above safe: the prune's liveness
    // check is only load-bearing if something writes the marker on the spawn
    // path, and this is that half.
    expect(existsSync(inUseMarkerPath(home, '0.3.13', process.pid))).toBe(true);
    expect(liveInUsePids(home, '0.3.13')).toEqual([process.pid]);
  });

  test('an empty home claims nothing, because nothing is being run from it', () => {
    const home = makeHome();

    prepareMcpSpawn(SHIPPED_COMMAND, { home, now: Date.now(), spawnImpl: () => ({ unref: () => {} }) });

    expect(readdirSync(home)).toEqual([]);
  });

  test('claimInUse refuses a junk home, a non-version and a non-pid', () => {
    const home = makeHome();
    installVersion(home, '0.3.13');

    expect(claimInUse({ home: 'undefined', version: '0.3.13' })).toBe(false);
    expect(claimInUse({ home, version: 'not-a-version' })).toBe(false);
    expect(claimInUse({ home, version: '0.3.13', pid: 'not-a-pid' })).toBe(false);
    expect(existsSync(join(home, '0.3.13', '.inuse'))).toBe(false);
  });
});

