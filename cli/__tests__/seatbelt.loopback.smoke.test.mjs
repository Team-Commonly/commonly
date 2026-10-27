/**
 * The loopback Seatbelt profile a confined dsh seat runs under, enforced by
 * the kernel: writes outside the workspace, the seat's secrets on disk, other
 * network routes and the keychain's Security services are all denied, while
 * the workspace and the one admitted loopback port work. macOS only.
 */
import { probeSeatbeltConfinement } from '../scripts/probe-seatbelt-confinement.mjs';

const macTest = process.platform === 'darwin' ? test : test.skip;

macTest('a loopback profile denies what a confined seat must not reach', async () => {
  const report = await probeSeatbeltConfinement();
  const failed = report.results.filter((row) => !row.pass);
  expect(failed).toEqual([]);
  expect(report.results.map((row) => row.probe)).toEqual(expect.arrayContaining([
    'write outside the workspace', 'open ~/.commonly', 'open ~/.config/gh/hosts.yml',
    'open the login keychain file', 'connect to 1.1.1.1:443', 'connect to another loopback port',
  ]));
}, 60000);
