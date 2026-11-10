// A launchd label, a systemd user unit and a scheduled-task name are one per OS
// user, not one per HOME. Before the owner check, a second Commonly account's
// `daemon setup` on the same computer account unloaded the first account's
// running daemon and loaded its own under the same name (Growth's F370 walk).
// Install now asks the service manager which file the live service came from
// and refuses when it is not this HOME's file, unless --replace was given.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { jest } from '@jest/globals';

import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  decodeCmdOutput,
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

// The shape of a real `launchctl print` answer (macOS 26): the job's own path
// comes first, before stdout/stderr paths and nested dicts.
const launchctlPrint = (path) => `gui/501/${LAUNCHD_LABEL} = {
\tactive count = 1
\tpath = ${path}
\ttype = LaunchAgent
\tstate = running

\tprogram = /opt/node/bin/node
\targuments = {
\t\t/opt/node/bin/node
\t\tdaemon
\t}

\tstdout path = /Users/first/.commonly/logs/daemon/daemon.log
\tstderr path = /Users/first/.commonly/logs/daemon/daemon.log
\tenvironment = {
\t\tHOME => /Users/first
\t}
}
`;

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

  test('schtasks: entities inside the path are decoded, and an undecodable answer is no answer', () => {
    expect(loadedServiceFile('schtasks', '<Arguments>-File &quot;C:\\Users\\A&amp;B\\x.ps1&quot;</Arguments>')).toBe('C:\\Users\\A&B\\x.ps1');
    expect(loadedServiceFile('schtasks', '<Arguments>-File "C:\\Users\\\uFFFD\uFFFD\\x.ps1"</Arguments>')).toBeNull();
  });

  test('command output decodes UTF-16 (BOM or NUL bytes) and UTF-8 alike', () => {
    const xml = '<Arguments>-File "C:\\Users\\李雷\\x.ps1"</Arguments>';
    const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
    expect(decodeCmdOutput(bom)).toBe(xml);
    expect(decodeCmdOutput(Buffer.from(xml, 'utf16le'))).toBe(xml);
    expect(decodeCmdOutput(Buffer.from(xml, 'utf8'))).toBe(xml);
    expect(loadedServiceFile('schtasks', decodeCmdOutput(bom))).toBe('C:\\Users\\李雷\\x.ps1');
  });

  test('the same file under a symlinked HOME is not foreign', () => {
    const root = mkdtempSync(join(tmpdir(), 'owner-'));
    try {
      const real = join(root, 'real');
      mkdirSync(join(real, 'Library', 'LaunchAgents'), { recursive: true });
      symlinkSync(real, join(root, 'link'));
      const target = servicePaths('darwin', join(root, 'link'));
      expect(foreignServiceRefusal({ target, loadedFile: servicePaths('darwin', real).file })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Linux says one daemon per computer account, since --replace can\'t load a unit from another HOME', () => {
    const refusal = foreignServiceRefusal({
      target: servicePaths('linux', '/home/second'),
      loadedFile: '/home/first/.config/systemd/user/commonly-daemon.service',
    });
    expect(refusal).toContain('one computer account runs one Commonly daemon');
    expect(refusal).not.toContain('--replace');
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
