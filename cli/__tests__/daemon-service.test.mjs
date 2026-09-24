// ADR-026 D1: the generated service units and the install/uninstall flows,
// with every side effect injected — no launchctl, no systemctl, no writes.
import { jest } from '@jest/globals';

import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  daemonLogPath,
  installDaemonService,
  launchdPlist,
  restartDaemonService,
  servicePaths,
  startDaemonService,
  stopDaemonService,
  systemdUnit,
  uninstallDaemonService,
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

  test('the service file is 0600, because it can now carry a secret', async () => {
    const deps = makeDeps();
    deps.chmod = jest.fn();
    const target = await installDaemonService({ platform: 'darwin', home, nodePath, cliPath, ...deps });
    expect(deps.chmod).toHaveBeenCalledWith(target.file, 0o600);
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
