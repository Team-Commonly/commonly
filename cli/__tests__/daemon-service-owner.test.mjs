// A launchd label, a systemd user unit and a scheduled-task name are one per OS
// user, not one per HOME. Before the owner check, a second Commonly account's
// `daemon setup` on the same computer account unloaded the first account's
// running daemon and loaded its own under the same name (Growth's F370 walk).
// Install now asks the service manager which file the live service came from
// and refuses when it is not this HOME's file, unless --replace was given.
import { jest } from '@jest/globals';

import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  foreignServiceRefusal,
  installDaemonService,
  loadedServiceFile,
  servicePaths,
  serviceOwnerQuery,
} from '../src/lib/daemon-service.js';
import { WINDOWS_TASK_NAME } from '../src/lib/daemon-service-windows.js';

const nodePath = '/opt/node/bin/node';
const cliPath = '/opt/cli/src/index.js';
const home = '/Users/second';
const otherHome = '/Users/first';

const makeDeps = (loaded) => ({
  writeFile: jest.fn(),
  mkdirp: jest.fn(),
  existsFile: jest.fn(() => true),
  execCmd: jest.fn(async () => {}),
  readCmd: jest.fn(async () => loaded),
  uid: 501,
  log: jest.fn(),
});

const launchctlPrint = (path) => `gui/501/${LAUNCHD_LABEL} = {\n\tactive count = 1\n\tpath = ${path}\n\ttype = LaunchAgent\n\tstate = running\n}\n`;

describe('which file the live service came from', () => {
  test('asks each service manager for the one service the CLI installs', () => {
    expect(serviceOwnerQuery('darwin', 501)).toEqual(['launchctl', 'print', `gui/501/${LAUNCHD_LABEL}`]);
    expect(serviceOwnerQuery('linux')).toEqual(['systemctl', '--user', 'show', SYSTEMD_UNIT, '-p', 'FragmentPath', '--value']);
    expect(serviceOwnerQuery('win32')).toEqual(['schtasks', '/Query', '/TN', WINDOWS_TASK_NAME, '/XML']);
  });

  test('reads the path out of each answer, and nothing out of an empty one', () => {
    const plist = servicePaths('darwin', otherHome).file;
    expect(loadedServiceFile('launchd', launchctlPrint(plist))).toBe(plist);
    expect(loadedServiceFile('systemd', '/home/first/.config/systemd/user/commonly-daemon.service\n'))
      .toBe('/home/first/.config/systemd/user/commonly-daemon.service');
    expect(loadedServiceFile('systemd', '\n')).toBeNull();
    // schtasks prints the definition it holds; the launcher path is the HOME's.
    const xml = '<Exec><Command>powershell.exe</Command><Arguments>-NoProfile -File "C:\\Users\\first\\.commonly\\daemon\\service\\commonly-daemon.ps1"</Arguments></Exec>';
    expect(loadedServiceFile('schtasks', xml)).toBe('C:\\Users\\first\\.commonly\\daemon\\service\\commonly-daemon.ps1');
    expect(loadedServiceFile('schtasks', xml.replace(/"/g, '&quot;'))).toBe('C:\\Users\\first\\.commonly\\daemon\\service\\commonly-daemon.ps1');
    expect(loadedServiceFile('launchd', '')).toBeNull();
  });

  test('this HOME\'s own file is not foreign; another HOME\'s is, and the refusal says what to do', () => {
    const target = servicePaths('darwin', home);
    expect(foreignServiceRefusal({ target, loadedFile: null })).toBeNull();
    expect(foreignServiceRefusal({ target, loadedFile: target.file })).toBeNull();
    const refusal = foreignServiceRefusal({ target, loadedFile: servicePaths('darwin', otherHome).file });
    expect(refusal).toContain('already runs a Commonly daemon for another account');
    expect(refusal).toContain(servicePaths('darwin', otherHome).file);
    expect(refusal).toContain('commonly daemon status');
    expect(refusal).toContain('--replace');
  });

  test('Windows compares the launcher, ignoring case', () => {
    const target = servicePaths('win32', 'C:\\Users\\second');
    expect(foreignServiceRefusal({ target, loadedFile: target.launcher.toUpperCase(), platform: 'win32' })).toBeNull();
    expect(foreignServiceRefusal({ target, loadedFile: servicePaths('win32', 'C:\\Users\\first').launcher, platform: 'win32' }))
      .toContain('another account');
  });
});

describe('install refuses to take over another account\'s daemon', () => {
  test('darwin: another HOME\'s live job stops the install before anything is written or unloaded', async () => {
    const deps = makeDeps(launchctlPrint(servicePaths('darwin', otherHome).file));
    await expect(installDaemonService({ platform: 'darwin', home, nodePath, cliPath, ...deps }))
      .rejects.toThrow(/another account/);
    expect(deps.readCmd).toHaveBeenCalledWith(['launchctl', 'print', `gui/501/${LAUNCHD_LABEL}`]);
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.execCmd).not.toHaveBeenCalled();
  });

  test('darwin: --replace takes it over on purpose', async () => {
    const deps = makeDeps(launchctlPrint(servicePaths('darwin', otherHome).file));
    const target = await installDaemonService({ platform: 'darwin', home, nodePath, cliPath, replace: true, ...deps });
    expect(deps.execCmd).toHaveBeenLastCalledWith(['launchctl', 'load', '-w', target.file]);
  });

  test('the same HOME re-running install still updates in place', async () => {
    const own = servicePaths('darwin', home).file;
    const deps = makeDeps(launchctlPrint(own));
    await installDaemonService({ platform: 'darwin', home, nodePath, cliPath, ...deps });
    expect(deps.writeFile).toHaveBeenCalledWith(own, expect.any(String));
  });

  test('no live service (the query fails) installs as before', async () => {
    const deps = makeDeps('');
    deps.readCmd.mockRejectedValueOnce(new Error('Could not find service'));
    await installDaemonService({ platform: 'darwin', home, nodePath, cliPath, ...deps });
    expect(deps.writeFile).toHaveBeenCalled();
  });

  test('linux: another HOME\'s unit is refused too', async () => {
    const deps = makeDeps('/home/first/.config/systemd/user/commonly-daemon.service\n');
    await expect(installDaemonService({ platform: 'linux', home: '/home/second', nodePath, cliPath, ...deps }))
      .rejects.toThrow(/another account/);
    expect(deps.execCmd).not.toHaveBeenCalled();
  });

  test('win32: another HOME\'s task is refused too', async () => {
    const xml = `<Arguments>-File "${servicePaths('win32', 'C:\\Users\\first').launcher}"</Arguments>`;
    const deps = makeDeps(xml);
    await expect(installDaemonService({ platform: 'win32', home: 'C:\\Users\\second', nodePath, cliPath, ...deps }))
      .rejects.toThrow(/another account/);
    expect(deps.execCmd).not.toHaveBeenCalled();
  });
});
