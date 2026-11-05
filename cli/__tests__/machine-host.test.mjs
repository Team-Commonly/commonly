/**
 * TASK-784 (D164): the daemon tells the server what its computer runs, as
 * metadata only: the platform, the OS release major, the arch and this CLI's
 * version. Never a hostname, a path or a user name.
 */
import { readFileSync } from 'fs';
import os from 'os';
import { machineHostReport, osReleaseMajor } from '../src/lib/machine-host.js';

const cliVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

describe('the machine host report', () => {
  test.each([
    ['10.0.22631', 10], // Windows 11 reports 10.0.<build>
    ['25.4.0', 25], // Darwin kernel major
    ['6.5.0-1025-azure', 6], // a Linux runner kernel
    ['', null],
    ['abc', null],
    [undefined, null],
  ])('reads the OS release major from %p', (release, major) => {
    expect(osReleaseMajor(release)).toBe(major);
  });

  test('carries exactly the four metadata fields, and nothing that names the machine or the person', () => {
    const report = machineHostReport({ platform: 'win32', release: '10.0.22631', arch: 'x64', cliVersion: '0.1.245' });
    expect(report).toEqual({ platform: 'win32', osMajor: 10, arch: 'x64', cliVersion: '0.1.245' });
    const text = JSON.stringify(machineHostReport());
    expect(text).not.toContain(os.hostname());
    expect(text).not.toContain(os.homedir());
    expect(text).not.toContain(os.userInfo().username);
  });

  test('by default reports this process and the CLI version it shipped with', () => {
    expect(machineHostReport()).toEqual({
      platform: process.platform,
      osMajor: osReleaseMajor(os.release()),
      arch: process.arch,
      cliVersion,
    });
  });
});
