/**
 * bubblewrap sandbox adapter — ADR-008 Phase 1.
 *
 * Wraps an inner adapter argv (e.g. claude -p ...) in a bwrap invocation that
 * pins the spawn into a workspace, isolates the network namespace, and
 * read-only-binds a small allowlist of host paths the adapter needs to start
 * (TLS certs, libc, the binary itself).
 *
 * Linux-only by design: bwrap is a setuid Linux helper. macOS callers get a
 * loud, specific error at attach time so the failure shape never reaches run.
 *
 * Detection idiom mirrors `claude.js#detect`: spawnSync with --version, treat
 * non-zero or spawn error as "not available."
 */

import { spawnSync } from 'child_process';
import { isAbsolute } from 'path';

const MACOS_MESSAGE = 'bwrap is Linux-only; use sandbox.mode: none in Phase 1 or wait for sandbox-exec adapter';

const DEFAULT_RO_BINDS = [
  '/etc/ssl/certs',
  '/etc/resolv.conf',
  '/usr/lib',
  '/usr/lib64',
  '/usr/bin',
  '/bin',
  '/lib',
  '/lib64',
];

export const detectBwrap = () => {
  if (process.platform !== 'linux') {
    return { available: false, error: MACOS_MESSAGE };
  }
  try {
    const res = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
    if (res.error || res.status !== 0) {
      return {
        available: false,
        error: 'bwrap not found on PATH. Install bubblewrap: `apt install bubblewrap` (Debian/Ubuntu) or `dnf install bubblewrap` (Fedora).',
      };
    }
    return { available: true, path: 'bwrap' };
  } catch (err) {
    return { available: false, error: `bwrap detection failed: ${err.message}` };
  }
};

/**
 * Build the bwrap-wrapped argv. Caller spawns argv[0] with argv.slice(1).
 *
 * Network policy honesty (ADR-008 §invariant #4 informs this):
 *   - unrestricted → --share-net (host networking inside the namespace)
 *   - restricted   → --unshare-net (NO network at all). Host-allowlist
 *     filtering needs an outbound proxy or per-host TLS interception, neither
 *     of which is in Phase 1 scope. Attach-time emits a loud warning so the
 *     user sees the gap before they think they're protected.
 *
 * The expansion order matches `bwrap`'s left-to-right argument application:
 * isolation flags first, then binds (later binds win on collision), then
 * --setenv, then `--` and the inner argv.
 */
export const wrapArgvWithBwrap = (innerArgv, env, opts = {}) => {
  if (process.platform !== 'linux') {
    throw new Error(MACOS_MESSAGE);
  }
  if (!Array.isArray(innerArgv) || innerArgv.length === 0) {
    throw new Error('wrapArgvWithBwrap requires a non-empty innerArgv');
  }
  if (!opts.workspacePath || !isAbsolute(opts.workspacePath)) {
    throw new Error('wrapArgvWithBwrap requires opts.workspacePath as an absolute path');
  }

  const policy = env?.sandbox?.network?.policy || 'unrestricted';
  const networkFlags = policy === 'restricted'
    ? ['--unshare-net']
    : ['--share-net'];

  const flags = [
    '--unshare-all',
    ...networkFlags,
    '--die-with-parent',
    '--new-session',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ];

  const userReadOutside = Array.isArray(env?.sandbox?.filesystem?.['read-outside'])
    ? env.sandbox.filesystem['read-outside']
    : [];
  const roBinds = [...new Set([...DEFAULT_RO_BINDS, ...userReadOutside])];
  for (const p of roBinds) {
    flags.push('--ro-bind-try', p, p);
  }

  const userWriteOutside = Array.isArray(env?.sandbox?.filesystem?.['write-outside'])
    ? env.sandbox.filesystem['write-outside']
    : [];
  for (const p of userWriteOutside) {
    flags.push('--bind-try', p, p);
  }

  flags.push('--bind', opts.workspacePath, opts.workspacePath);
  flags.push('--chdir', opts.workspacePath);
  flags.push('--setenv', 'HOME', opts.workspacePath);

  return ['bwrap', ...flags, '--', ...innerArgv];
};

export const BWRAP_MACOS_MESSAGE = MACOS_MESSAGE;
