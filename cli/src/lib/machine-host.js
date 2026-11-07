/**
 * TASK-784 (D164): what the daemon's computer runs, as the server stores it.
 * Metadata only: Node's platform and arch names, the OS release's leading
 * number, and this CLI's version. Nothing here may name the machine or the
 * person (no hostname, path or user name); the server drops anything else.
 */
import { release as osRelease } from 'os';
import { installedCliVersion } from './update-check.js';

/**
 * The leading number of an OS release string: Windows "10.0.22631" is 10,
 * a Darwin kernel "25.4.0" is 25, Linux "6.5.0-1025-azure" is 6.
 */
export const osReleaseMajor = (release) => {
  const match = /^(\d{1,4})(?:\D|$)/.exec(String(release ?? ''));
  return match ? Number(match[1]) : null;
};

export const machineHostReport = ({
  platform = process.platform,
  release = osRelease(),
  arch = process.arch,
  cliVersion = installedCliVersion(),
} = {}) => ({
  platform,
  osMajor: osReleaseMajor(release),
  arch,
  cliVersion: cliVersion || null,
});
