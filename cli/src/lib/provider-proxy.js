import { resolveProviderKeyFile as resolveKeyFileShared } from '@commonlyai/seats/wire/provider-proxy';
import { effectiveSandboxTrust } from './environment.js';
import { bwrapReadRoots } from './sandbox/bwrap.js';
import { seatbeltSystemReadRoots } from './sandbox/seatbelt.js';

export * from '@commonlyai/seats/wire/provider-proxy';

/**
 * F453. What a sandboxed seat can read on this platform, as roots, or
 * undefined for a spawn that runs in no sandbox. macOS: the Seatbelt
 * baseline's read grants, read from the profile itself. Linux: bwrap's read
 * binds, including the seat's declared read-outside and write-outside.
 * `sandboxed` is the adapter's word on whether this spawn is confined; left
 * out, a public seat is confined and any other is not.
 */
export const sandboxReadableRoots = (environment, platform = process.platform, { sandboxed } = {}) => {
  const confined = sandboxed ?? effectiveSandboxTrust(environment?.sandbox?.trust) === 'public';
  if (!confined) return undefined;
  if (platform === 'darwin') return seatbeltSystemReadRoots();
  if (platform === 'linux') return bwrapReadRoots(environment);
  return { subpaths: [], literals: [] };
};

/**
 * The shared key-file validation, with the sandbox check every adapter gets:
 * the proxy reads a confined seat's key file outside the sandbox, so a key
 * file the sandbox can read is refused before the seat starts, and before
 * anything opens the file. Adapters pass their environment; `seatDirectories`
 * names stable directories the adapter itself gives the sandbox (a seat home),
 * checked whenever the spawn is confined. Without options nothing changes.
 */
export const resolveProviderKeyFile = (provider, workspacePath, adapterLabel, {
  environment, platform, sandboxed, seatDirectories = [],
} = {}) => {
  const roots = sandboxReadableRoots(environment, platform, { sandboxed });
  return resolveKeyFileShared(provider, workspacePath, adapterLabel, {
    readableRoots: roots && {
      subpaths: [...roots.subpaths, ...seatDirectories.filter(Boolean)],
      literals: roots.literals,
    },
  });
};
