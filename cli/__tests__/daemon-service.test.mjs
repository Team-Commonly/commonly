// ADR-026 D1: the generated service units and the install/uninstall flows,
// with every side effect injected — no launchctl, no systemctl, no writes.
//
// Three exceptions, deliberate: the mode and atomicity claims are witnessed on
// real files, because a jest.fn() writer cannot show the mode a file was CREATED
// with, and no mock can show that a destination file was REPLACED rather than
// rewritten. Injection is used for the values passed and for ordering, never as
// a stand-in for the filesystem property under test.
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { jest } from '@jest/globals';

import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  daemonLogPath,
  installDaemonService,
  launchdPlist,
  restartDaemonService,
  servicePaths,
  serviceTempPath,
  startDaemonService,
  stopDaemonService,
  systemdUnit,
  uninstallDaemonService,
  writeServiceFile,
} from '../src/lib/daemon-service.js';
import { providerKeyEnvNames } from '../src/lib/adapters/index.js';

const nodePath = '/opt/node/bin/node';
const cliPath = '/opt/cli/src/index.js';
const home = '/Users/sam';

describe('unit content', () => {
  test('launchd plist runs the exact interpreter + entry, keeps alive, and gives children a usable PATH', () => {
    const plist = launchdPlist({ nodePath, cliPath, home });
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain(`<string>${nodePath}</string>\n\t\t<string>${cliPath}</string>\n\t\t<string>daemon</string>\n\t\t<string>run</string>`);
    expect(plist).toContain('<key>KeepAlive</key>\n\t<true/>');
    // Children spawn the user's claude/codex by name — homebrew must be on PATH.
    expect(plist).toContain('/opt/node/bin:/opt/homebrew/bin');
    expect(plist).toContain(daemonLogPath(home));
  });

  test('systemd unit restarts always and runs the same argv', () => {
    const unit = systemdUnit({ nodePath, cliPath });
    expect(unit).toContain(`ExecStart=${nodePath} ${cliPath} daemon run`);
    expect(unit).toContain('Restart=always');
  });

  // TASK-049: launchd and systemd start the daemon with a CLEAN environment, so
  // a provider key that lives only in the operator's shell is absent at boot and
  // the seat dies inside its adapter. The install is the only moment the
  // operator's shell is in reach, so the keys are captured there.
  test('both units carry the provider keys the install could see', () => {
    const providerEnv = [['COMMONLY_LITELLM_KEY', 'vk-secret']];
    const plist = launchdPlist({ nodePath, cliPath, home, providerEnv });
    expect(plist).toContain('<key>COMMONLY_LITELLM_KEY</key>\n\t\t<string>vk-secret</string>');
    expect(systemdUnit({ nodePath, cliPath, providerEnv })).toContain('Environment="COMMONLY_LITELLM_KEY=vk-secret"');
  });

  test('a provider key value cannot break the plist XML', () => {
    const plist = launchdPlist({ nodePath, cliPath, home, providerEnv: [['COMMONLY_LITELLM_KEY', 'a&b<c']] });
    expect(plist).toContain('<string>a&amp;b&lt;c</string>');
  });

  // Two sinks, two escaping rules, and the systemd one is the stricter: inside
  // `Environment="…"` a raw quote closes it and a raw newline ends the
  // assignment, so the remainder of the key lands in the unit as a directive of
  // its own. Escaping only the plist would leave the sink nobody looked at.
  test('a provider key value cannot break the systemd unit either', () => {
    const unit = systemdUnit({ nodePath, cliPath, providerEnv: [['COMMONLY_LITELLM_KEY', 'a"b\nKillMode=none']] });
    expect(unit).toContain('Environment="COMMONLY_LITELLM_KEY=a\\"b\\nKillMode=none"');
    expect(unit).not.toContain('\nKillMode=none');
  });

  // `Environment=` does not expand `$VAR` but DOES expand specifiers
  // (systemd.exec(5)), and `%%` is the escape for a literal `%` (systemd.unit(5)).
  // Without it a key containing `%h` is rewritten to the home directory: the unit
  // parses, the daemon starts, the seat authenticates with a key nobody exported,
  // and the only symptom is at the provider — the failure class this PR removes,
  // arriving through the escaping instead of the omission.
  test('a provider key value survives systemd specifier expansion', () => {
    const unit = systemdUnit({ nodePath, cliPath, providerEnv: [['COMMONLY_LITELLM_KEY', 'k%h-100%']] });
    expect(unit).toContain('Environment="COMMONLY_LITELLM_KEY=k%%h-100%%"');
    expect(unit).not.toContain('k%h');
  });

  test('no provider keys declared — neither unit gains an env line', () => {
    const plist = launchdPlist({ nodePath, cliPath, home });
    expect(plist).not.toContain('provider');
    expect(systemdUnit({ nodePath, cliPath })).not.toContain('Environment="');
  });

  // The daemon reads this list from the registry, so a renamed variable in the
  // adapter must not silently stop the key from being carried.
  test('the pi adapter declares the provider key the daemon carries', () => {
    expect(providerKeyEnvNames()).toContain('COMMONLY_LITELLM_KEY');
    expect(providerKeyEnvNames({ pi: { providerKeyEnv: 'X' }, claude: {}, codex: {} })).toEqual(['X']);
  });
});

const makeDeps = () => ({
  writeFile: jest.fn(),
  mkdirp: jest.fn(),
  existsFile: jest.fn(() => true),
  removeFile: jest.fn(),
  execCmd: jest.fn(async () => {}),
  log: jest.fn(),
});

describe('install', () => {
  test('darwin: writes the plist and loads it (stale unload tolerated)', async () => {
    const deps = makeDeps();
    deps.execCmd.mockRejectedValueOnce(new Error('not loaded')); // the unload
    const target = await installDaemonService({
      platform: 'darwin', home, nodePath, cliPath, ...deps,
    });
    expect(target.kind).toBe('launchd');
    expect(deps.writeFile).toHaveBeenCalledWith(target.file, expect.stringContaining(LAUNCHD_LABEL));
    expect(deps.execCmd).toHaveBeenLastCalledWith(['launchctl', 'load', '-w', target.file]);
  });

  test('linux: writes the unit, reloads, enables --now', async () => {
    const deps = makeDeps();
    const target = await installDaemonService({
      platform: 'linux', home, nodePath, cliPath, ...deps,
    });
    expect(target.kind).toBe('systemd');
    expect(deps.execCmd.mock.calls).toEqual([
      [['systemctl', '--user', 'daemon-reload']],
      [['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT]],
    ]);
  });

  test('a failing load surfaces instead of reporting success', async () => {
    const deps = makeDeps();
    deps.execCmd
      .mockResolvedValueOnce() // unload
      .mockRejectedValueOnce(new Error('launchctl load exited 1'));
    await expect(installDaemonService({
      platform: 'darwin', home, nodePath, cliPath, ...deps,
    })).rejects.toThrow(/exited 1/);
  });

  test('hardens the daemon log directory on install', async () => {
    const deps = makeDeps();
    deps.chmod = jest.fn();
    deps.ensureFile = jest.fn();
    await installDaemonService({ platform: 'darwin', home, nodePath, cliPath, ...deps });
    expect(deps.chmod).toHaveBeenCalledWith(`${home}/.commonly/logs/daemon`, 0o700);
    expect(deps.ensureFile).toHaveBeenCalledWith(daemonLogPath(home));
    expect(deps.chmod).toHaveBeenCalledWith(daemonLogPath(home), 0o600);
  });

  test('install carries a present provider key into the unit and warns about a missing one', async () => {
    const withKey = makeDeps();
    withKey.warn = jest.fn();
    await installDaemonService({
      platform: 'darwin',
      home,
      nodePath,
      cliPath,
      providerKeyEnvNames: ['COMMONLY_LITELLM_KEY'],
      env: { COMMONLY_LITELLM_KEY: 'vk-secret' },
      ...withKey,
    });
    expect(withKey.writeFile.mock.calls[0][1]).toContain('COMMONLY_LITELLM_KEY</key>');
    expect(withKey.warn).not.toHaveBeenCalled();

    const withoutKey = makeDeps();
    withoutKey.warn = jest.fn();
    await installDaemonService({
      platform: 'darwin',
      home,
      nodePath,
      cliPath,
      providerKeyEnvNames: ['COMMONLY_LITELLM_KEY'],
      env: {},
      ...withoutKey,
    });
    // Absent is stated, never invented: nothing is written and the operator is
    // told at install time rather than discovering it one crash-looping seat at
    // a time.
    expect(withoutKey.writeFile.mock.calls[0][1]).not.toContain('COMMONLY_LITELLM_KEY');
    expect(withoutKey.warn).toHaveBeenCalledWith(expect.stringContaining('COMMONLY_LITELLM_KEY is not set in this shell'));
  });

  // The mode is held by construction — a sibling file created 0600 and renamed
  // over the target — so the property to witness is the mode and the content,
  // not which call did it. Real file through the REAL default writer, with chmod
  // left at its no-op default: the 0600 observed can only have come from the
  // file's own creation.
  test('a fresh install lands the unit 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commonly-daemon-install-'));
    try {
      const target = await installDaemonService({
        platform: 'linux',
        home: dir,
        nodePath,
        cliPath,
        providerKeyEnvNames: ['COMMONLY_LITELLM_KEY'],
        env: { COMMONLY_LITELLM_KEY: 'vk-secret' },
        mkdirp: (path) => mkdirSync(path, { recursive: true }),
        execCmd: async () => {},
        log: () => {},
      });
      expect(statSync(target.file).mode & 0o777).toBe(0o600);
      expect(readFileSync(target.file, 'utf8')).toContain('Environment="COMMONLY_LITELLM_KEY=vk-secret"');
      expect(readdirSync(dirname(target.file)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The upgrade half: the case every existing operator meets. `writeFileSync`'s
  // mode applies only when the file does not exist, so a write straight at the
  // target cannot narrow a file a PRE-PR install left at 0644.
  test('an upgrade over a pre-PR 0644 file lands the unit 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commonly-daemon-upgrade-'));
    try {
      const target = servicePaths('linux', dir);
      mkdirSync(dirname(target.file), { recursive: true });
      writeFileSync(target.file, 'old unit\n', { mode: 0o644 });
      chmodSync(target.file, 0o644);
      // Control: the file really is 0644 going in, so a pass below cannot come
      // from the fixture having been 0600 already.
      expect(statSync(target.file).mode & 0o777).toBe(0o644);

      await installDaemonService({
        platform: 'linux',
        home: dir,
        nodePath,
        cliPath,
        providerKeyEnvNames: ['COMMONLY_LITELLM_KEY'],
        env: { COMMONLY_LITELLM_KEY: 'vk-secret' },
        mkdirp: (path) => mkdirSync(path, { recursive: true }),
        chmod: chmodSync,
        execCmd: async () => {},
        log: () => {},
      });
      expect(statSync(target.file).mode & 0o777).toBe(0o600);
      expect(readFileSync(target.file, 'utf8')).toContain('Environment="COMMONLY_LITELLM_KEY=vk-secret"');
      expect(readFileSync(target.file, 'utf8')).not.toContain('old unit');
      expect(readdirSync(dirname(target.file)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A second, independent instrument on the same mechanism, and the one a
  // rewrite-in-place cannot pass: a hard link is a SECOND NAME FOR THE SAME
  // INODE, so content written into the existing file would show up under the
  // link too. It does not, so the install displaced the old file rather than
  // overwriting it — which is also what keeps a reader CONCURRENT with the write
  // (a `daemon-reload` from another install, `systemctl --user show`) from parsing
  // a half-written unit. systemd does not re-read a changed unit by itself: it
  // reports the file as changed on disk until a `daemon-reload`.
  test('the new unit REPLACES the old file instead of being written into it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commonly-daemon-replace-'));
    try {
      const target = servicePaths('linux', dir);
      mkdirSync(dirname(target.file), { recursive: true });
      writeFileSync(target.file, 'old unit\n', { mode: 0o644 });
      const sameInode = `${target.file}.witness`;
      linkSync(target.file, sameInode);

      await installDaemonService({
        platform: 'linux',
        home: dir,
        nodePath,
        cliPath,
        providerKeyEnvNames: ['COMMONLY_LITELLM_KEY'],
        env: { COMMONLY_LITELLM_KEY: 'vk-secret' },
        mkdirp: (path) => mkdirSync(path, { recursive: true }),
        chmod: chmodSync,
        execCmd: async () => {},
        log: () => {},
      });
      expect(readFileSync(sameInode, 'utf8')).toBe('old unit\n');
      expect(readFileSync(target.file, 'utf8')).toContain('COMMONLY_LITELLM_KEY');
      expect(statSync(target.file).mode & 0o777).toBe(0o600);
      unlinkSync(sameInode);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The OTHER half of the same threat, and the reason the temp is created with
  // O_EXCL rather than merely under an unlikely name. A predictable temp path
  // lets any process running as this user — every seat this repo spawns — plant a
  // symlink there, and a plain write follows it: the key lands at a path and a
  // mode the writer did not choose. The suffix is injected so the plant can be
  // aimed at the exact path the writer will use; `wx` then refuses it.
  test('a symlink planted at the temp path is refused, not followed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commonly-daemon-symlink-'));
    try {
      const target = servicePaths('linux', dir);
      mkdirSync(dirname(target.file), { recursive: true });
      const captured = join(dir, 'captured.txt');
      writeFileSync(captured, 'OLDCONTENT', { mode: 0o644 });
      chmodSync(captured, 0o644);
      const planted = serviceTempPath(target.file, 'suffix-used-by-the-test');
      symlinkSync(captured, planted);

      // Control: the fixture is a working symlink, so a refusal below cannot come
      // from a plant that failed. Without `wx` this is exactly the exfiltration.
      writeFileSync(planted, 'CONTROL-WRITE');
      expect(readFileSync(captured, 'utf8')).toBe('CONTROL-WRITE');
      writeFileSync(captured, 'OLDCONTENT');
      chmodSync(captured, 0o644);

      expect(() => writeServiceFile(target.file, 'sk-SECRET', { suffix: 'suffix-used-by-the-test' }))
        .toThrow(/EEXIST/);
      // The key never reached the link's target, and the link was left alone —
      // removing a path we did not create would be its own bug.
      expect(readFileSync(captured, 'utf8')).toBe('OLDCONTENT');
      expect(statSync(captured).mode & 0o777).toBe(0o644);
      expect(lstatSync(planted).isSymbolicLink()).toBe(true);
      expect(existsSync(target.file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The target may itself be planted as a symlink; `rename` displaces the link
  // rather than writing through it, and the key's mode still comes from creation.
  test('a symlink at the target path is displaced, not written through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commonly-daemon-target-link-'));
    try {
      const target = servicePaths('linux', dir);
      mkdirSync(dirname(target.file), { recursive: true });
      const captured = join(dir, 'captured.txt');
      writeFileSync(captured, 'OLDCONTENT', { mode: 0o644 });
      symlinkSync(captured, target.file);

      await installDaemonService({
        platform: 'linux',
        home: dir,
        nodePath,
        cliPath,
        providerKeyEnvNames: ['COMMONLY_LITELLM_KEY'],
        env: { COMMONLY_LITELLM_KEY: 'vk-secret' },
        mkdirp: (path) => mkdirSync(path, { recursive: true }),
        chmod: chmodSync,
        execCmd: async () => {},
        log: () => {},
      });
      expect(readFileSync(captured, 'utf8')).toBe('OLDCONTENT');
      expect(lstatSync(target.file).isSymbolicLink()).toBe(false);
      expect(statSync(target.file).mode & 0o777).toBe(0o600);
      expect(readFileSync(target.file, 'utf8')).toContain('COMMONLY_LITELLM_KEY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A tripwire, not a proof: the name must not be derivable from the process, so
  // that guessing it is not free. The refusal above is what actually holds.
  test('the temp name is unpredictable, not derived from the pid', () => {
    const first = serviceTempPath('/home/someone/.config/systemd/user/commonly.service');
    const second = serviceTempPath('/home/someone/.config/systemd/user/commonly.service');
    expect(first).not.toBe(second);
    expect(first).not.toContain(String(process.pid));
  });

  // A failed install must not leave the key sitting in a temp file. The failure
  // here is real rather than injected: a directory at the target path makes the
  // rename fail after the content has already been written, which is the only
  // moment the cleanup path runs.
  test('a failed rename removes the temp and rethrows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commonly-daemon-fail-'));
    try {
      const target = servicePaths('linux', dir);
      mkdirSync(target.file, { recursive: true });
      await expect(installDaemonService({
        platform: 'linux',
        home: dir,
        nodePath,
        cliPath,
        providerKeyEnvNames: ['COMMONLY_LITELLM_KEY'],
        env: { COMMONLY_LITELLM_KEY: 'vk-secret' },
        mkdirp: (path) => mkdirSync(path, { recursive: true }),
        chmod: chmodSync,
        execCmd: async () => {},
        log: () => {},
      })).rejects.toThrow();
      expect(readdirSync(dirname(target.file)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('uninstall', () => {
  test('darwin: unloads and removes the plist', async () => {
    const deps = makeDeps();
    const target = await uninstallDaemonService({ platform: 'darwin', home, ...deps });
    expect(deps.execCmd).toHaveBeenCalledWith(['launchctl', 'unload', '-w', target.file]);
    expect(deps.removeFile).toHaveBeenCalledWith(target.file);
  });

  test('nothing installed — a no-op, not an error', async () => {
    const deps = makeDeps();
    deps.existsFile.mockReturnValue(false);
    await expect(uninstallDaemonService({ platform: 'darwin', home, ...deps })).resolves.toBeNull();
    expect(deps.removeFile).not.toHaveBeenCalled();
  });
});

describe('paths', () => {
  test('per-platform service file locations', () => {
    expect(servicePaths('darwin', home).file).toBe(`${home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
    expect(servicePaths('linux', home).file).toBe(`${home}/.config/systemd/user/${SYSTEMD_UNIT}`);
  });
});

describe('service controls', () => {
  test('launchd start/stop controls the installed file, not a KeepAlive label', async () => {
    const execCmd = jest.fn(async () => {});
    const target = servicePaths('darwin', home);
    await startDaemonService({ platform: 'darwin', home, execCmd });
    await stopDaemonService({ platform: 'darwin', home, execCmd });
    expect(execCmd.mock.calls).toEqual([
      [['launchctl', 'load', '-w', target.file]],
      [['launchctl', 'unload', '-w', target.file]],
    ]);
  });

  test('launchd start falls back to starting an already-loaded plist', async () => {
    const execCmd = jest.fn()
      .mockRejectedValueOnce(new Error('already loaded'))
      .mockResolvedValueOnce();
    await startDaemonService({ platform: 'darwin', home, execCmd });
    expect(execCmd.mock.calls).toEqual([
      [['launchctl', 'load', '-w', servicePaths('darwin', home).file]],
      [['launchctl', 'start', LAUNCHD_LABEL]],
    ]);
  });

  test('systemd restart delegates to the user unit', async () => {
    const execCmd = jest.fn(async () => {});
    await restartDaemonService({ platform: 'linux', home, execCmd });
    expect(execCmd).toHaveBeenCalledWith(['systemctl', '--user', 'restart', SYSTEMD_UNIT]);
  });
});
