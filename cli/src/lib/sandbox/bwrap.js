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
import { isAbsolute, join } from 'path';
import { homedir } from 'os';

// Tilde-expansion lives here (and not in environment.js's expandHome) because
// bwrap reads OS-level paths verbatim — `~` is a shell construct, not a
// kernel one, so any `~/foo` entry in `read-outside` / `write-outside` would
// be passed literally to `--ro-bind-try` and silently skipped (the `-try`
// variant tolerates missing paths). Surfaced live during the 2026-04-17
// demo validation: `~/.local/bin` was declared but `claude` still wasn't
// reachable inside the sandbox.
const expandHome = (p) => {
  if (!p || typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
};

// Never advise `sandbox.mode: none` here: a public seat refuses it, and the
// mechanisms that do exist are named instead.
const MACOS_MESSAGE = 'bwrap is Linux-only. On macOS a public seat runs under Seatbelt '
  + '(sandbox.mode workspace or read-only); Windows has no supported sandbox yet, so use WSL 2.';

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

// `bwrap --version` only proves the binary is there. On Ubuntu 24.04 and later
// AppArmor restricts unprivileged user namespaces, so bwrap is installed and
// every sandbox it starts fails (`setting up uid map: Permission denied`,
// ubuntu run 38982219348). Starting one empty namespace is the real check.
const NAMESPACE_PROBE = ['--unshare-all', '--ro-bind', '/', '/', 'true'];

export const detectBwrap = ({ spawn = spawnSync, platform = process.platform } = {}) => {
  if (platform !== 'linux') {
    return { available: false, error: MACOS_MESSAGE };
  }
  try {
    const res = spawn('bwrap', ['--version'], { encoding: 'utf8' });
    if (res.error || res.status !== 0) {
      return {
        available: false,
        error: 'bwrap not found on PATH. Install bubblewrap: `sudo apt install bubblewrap` (Debian/Ubuntu, WSL), '
          + '`sudo dnf install bubblewrap` (Fedora) or `sudo pacman -S bubblewrap` (Arch).',
      };
    }
    const probe = spawn('bwrap', NAMESPACE_PROBE, { encoding: 'utf8', timeout: 10_000 });
    if (probe.error || probe.status !== 0) {
      const reason = (probe.stderr || probe.error?.message || `exit ${probe.status}`).trim().split('\n').pop();
      return {
        available: false,
        error: `bubblewrap is installed but cannot start a sandbox on this machine (${reason}). `
          + 'On Ubuntu 24.04 and later, AppArmor restricts the unprivileged user namespaces it needs.',
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
 *   - restricted   → --unshare-net (no external network). OpenCode may opt
 *     into a private loopback bridge to its per-spawn Unix-socket proxy.
 *     Host-allowlist filtering is not supplied by bwrap itself.
 *
 * The expansion order matches `bwrap`'s left-to-right argument application:
 * isolation flags first, then binds (later binds win on collision), then the
 * isolated HOME, then `--` and the inner argv. The caller passes the filtered
 * child environment as the bwrap process environment; values must not be
 * serialized into argv, where they would be visible in the process list.
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
  if (opts.enableLoopback && policy !== 'restricted') {
    throw new Error('bwrap loopback bridge requires an isolated network namespace');
  }

  const flags = [
    '--unshare-all',
    ...networkFlags,
    ...(opts.enableLoopback ? [
      '--uid', '0', '--gid', '0',
      '--cap-add', 'CAP_NET_ADMIN', '--cap-add', 'CAP_SETPCAP',
    ] : []),
    '--die-with-parent',
    '--new-session',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ];

  const userReadOutside = Array.isArray(env?.sandbox?.filesystem?.['read-outside'])
    ? env.sandbox.filesystem['read-outside'].map(expandHome)
    : [];
  const roBinds = [...new Set([...DEFAULT_RO_BINDS, ...userReadOutside])];
  for (const p of roBinds) {
    flags.push('--ro-bind-try', p, p);
  }

  const userWriteOutside = Array.isArray(env?.sandbox?.filesystem?.['write-outside'])
    ? env.sandbox.filesystem['write-outside'].map(expandHome)
    : [];
  for (const p of userWriteOutside) {
    flags.push('--bind-try', p, p);
  }

  // Adapter-owned transient inputs (for example Claude's per-spawn MCP
  // config) live outside the workspace so model-visible Read(./**) cannot
  // reach them. Bind only the exact directories the adapter prepared; they
  // remain read-only inside the namespace and disappear after the spawn.
  for (const p of opts.readOnlyPaths || []) {
    if (!p || !isAbsolute(p)) {
      throw new Error('wrapArgvWithBwrap opts.readOnlyPaths entries must be absolute paths');
    }
    flags.push('--ro-bind', p, p);
  }
  for (const p of opts.optionalReadOnlyPaths || []) {
    if (!p || !isAbsolute(p)) {
      throw new Error('wrapArgvWithBwrap opts.optionalReadOnlyPaths entries must be absolute paths');
    }
    flags.push('--ro-bind-try', p, p);
  }

  // A HOME the adapter keeps outside the workspace (a workspace seat's state)
  // is bound writable on its own, so the child's transcripts and login stay
  // out of the person's project.
  for (const p of opts.writablePaths || []) {
    if (!p || !isAbsolute(p)) {
      throw new Error('wrapArgvWithBwrap opts.writablePaths entries must be absolute paths');
    }
    flags.push('--bind', p, p);
  }

  flags.push(opts.workspaceReadOnly ? '--ro-bind' : '--bind', opts.workspacePath, opts.workspacePath);
  // Entries held read-only inside a writable workspace (its .git). Bound after
  // the workspace so they land on top of it. In a writable workspace a missing
  // entry cannot be protected — the child could create it, and a planted
  // .git/hooks runs on the person's next git command — so the bind is strict
  // there and bwrap fails rather than starts.
  for (const entry of opts.readOnlyWorkspaceEntries || []) {
    if (!entry || isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
      throw new Error('wrapArgvWithBwrap opts.readOnlyWorkspaceEntries entries must be relative names inside the workspace');
    }
    const p = join(opts.workspacePath, entry);
    flags.push(opts.workspaceReadOnly ? '--ro-bind-try' : '--ro-bind', p, p);
  }
  flags.push('--chdir', opts.workspacePath);
  flags.push('--setenv', 'HOME', opts.homePath || opts.workspacePath);

  return ['bwrap', ...flags, '--', ...innerArgv];
};

export const BWRAP_MACOS_MESSAGE = MACOS_MESSAGE;
