import { resolveProviderKeyFile as resolveKeyFileShared } from '@commonlyai/seats/wire/provider-proxy';
import { effectiveSandboxTrust } from './environment.js';
import { bwrapReadRoots } from './sandbox/bwrap.js';
import { seatbeltSystemReadRoots } from './sandbox/seatbelt.js';

export * from '@commonlyai/seats/wire/provider-proxy';

/**
 * F453. What a public seat's sandbox can read on this platform, as roots, or
 * undefined for a seat that runs in no sandbox. macOS: the Seatbelt baseline's
 * read grants, read from the profile itself. Linux: bwrap's read binds,
 * including the seat's declared read-outside and write-outside. Per-turn paths
 * an adapter adds (its seat home, its package) are the adapter's to check.
 */
export const sandboxReadableRoots = (environment, platform = process.platform) => {
  if (effectiveSandboxTrust(environment?.sandbox?.trust) !== 'public') return undefined;
  if (platform === 'darwin') return seatbeltSystemReadRoots();
  if (platform === 'linux') return bwrapReadRoots(environment);
  return undefined;
};

/**
 * The shared key-file validation, with the sandbox check every adapter gets:
 * the proxy reads a public seat's key file outside the sandbox, so a key file
 * the sandbox can read is refused before the seat starts. Adapters pass their
 * environment (and, in tests, a platform); without one, nothing changes.
 */
export const resolveProviderKeyFile = (provider, workspacePath, adapterLabel, { environment, platform } = {}) => (
  resolveKeyFileShared(provider, workspacePath, adapterLabel, {
    readableRoots: sandboxReadableRoots(environment, platform),
  })
);
