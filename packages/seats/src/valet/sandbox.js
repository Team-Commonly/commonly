/**
 * Put one run inside the OS sandbox. prepareRunEnv decides what the run
 * holds (its env, a throwaway HOME, the granted credentials); this decides
 * what it can reach beyond that. It composes the Seatbelt and bwrap builders
 * in ../sandbox/ rather than writing a profile of its own, so the cli's
 * public seats and a valet run share one policy text.
 *
 *   macOS  Seatbelt: deny by default. Writes land only in the run's HOME
 *          (TMPDIR is inside it). The real HOME's login paths are denied by
 *          absolute path, after every allow, so even a workspace that holds
 *          them cannot open them. securityd's mach services are dropped and
 *          denied: the run's credentials are in its env, so nothing in it has
 *          a reason to ask the keychain.
 *   Linux  bwrap: only the run's HOME (and a workspace, if one is given) is
 *          bound; the real HOME is never mounted.
 *   other  no sandbox. That is a named result, never a quiet fallback: the
 *          caller gets RunFailure('unsupported') unless it passed
 *          require: false, and then { sandbox: 'none', reason }.
 *
 * Network stays open on both: a run needs its provider. Nothing here fences
 * egress.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { detectSeatbelt, wrapArgvWithSeatbelt } from '../sandbox/seatbelt.js';
import { detectBwrap, wrapArgvWithBwrap } from '../sandbox/bwrap.js';
import { traceOf } from '../trace/events.js';
import { runFailure } from '../failures.js';
import { isInside } from './env.js';

/**
 * Where a CLI keeps the user's login, relative to a real HOME. Seatbelt denies
 * each one even when a broader allow covers it.
 */
export const REAL_HOME_LOGIN_PATHS = Object.freeze([
  '.claude', '.claude.json', '.codex', '.commonly', '.config', '.ssh', '.aws',
  '.gnupg', '.netrc', '.npmrc', '.docker', '.kube',
  'Library/Keychains', 'Library/Application Support', 'Library/Cookies',
]);

// Seatbelt matches resolved paths (/var is /private/var), so compare those.
const real = (path) => {
  try { return realpathSync(path); } catch { return path; }
};

const checkPlacement = ({ run, workspace, realHomes, loginPaths, platform }) => {
  const home = real(run.home);
  for (const realHome of realHomes) {
    if (isInside(realHome, home)) throw new Error('sandboxRunArgv: the run HOME holds the real HOME');
  }
  if (loginPaths.some((path) => isInside(home, path))) {
    throw new Error('sandboxRunArgv: the run HOME is inside a login path the sandbox denies');
  }
  if (!workspace) return;
  const ws = real(workspace.path);
  if (loginPaths.some((path) => isInside(ws, path))) {
    throw new Error('sandboxRunArgv: the workspace is inside a login path the sandbox denies');
  }
  // bwrap can only leave a path unmounted, not punch a hole in a mount, so a
  // workspace holding the real HOME would mount its login with it.
  if (platform === 'linux' && realHomes.some((realHome) => isInside(realHome, ws))) {
    throw new Error('sandboxRunArgv: on Linux the workspace may not hold the real HOME');
  }
};

/**
 * sandboxRunArgv({ argv, run, platform?, workspace?, require?, trace?, ctx?, detect? })
 *   → { argv, sandbox: 'seatbelt'|'bwrap'|'none', reason? }
 *
 * `argv[0]` is the CLI by absolute path (prepareRunEnv drops PATH entries
 * under the real HOME, so a bare name is not a reliable lookup). `run` is
 * prepareRunEnv's result; spawn the returned argv with run.env, with cwd at
 * run.home or the workspace. `workspace` is { path, access: 'read'|'write' },
 * read when access is left out. `require` defaults to true.
 *
 * Emits sandbox.applied { sandbox, reason? } on `trace`, else ctx.trace.
 */
export const sandboxRunArgv = ({
  argv, run, platform = process.platform, workspace, require: required = true, trace, ctx, detect = {},
} = {}) => {
  if (!Array.isArray(argv) || argv.length === 0 || !isAbsolute(String(argv[0]))) {
    throw new Error('sandboxRunArgv: argv[0] must be the CLI by absolute path');
  }
  if (!run || typeof run.home !== 'string' || !isAbsolute(run.home)) {
    throw new Error("sandboxRunArgv: run must be prepareRunEnv's result");
  }
  if (workspace && (typeof workspace.path !== 'string' || !isAbsolute(workspace.path))) {
    throw new Error('sandboxRunArgv: workspace.path must be absolute');
  }
  const ws = workspace ? { path: workspace.path, access: workspace.access ?? 'read' } : null;
  const realHomes = [...new Set((run.realHomes?.length ? run.realHomes : [homedir()]).map(real))];
  const loginPaths = realHomes.flatMap((home) => REAL_HOME_LOGIN_PATHS.map((path) => join(home, path)));
  checkPlacement({ run, workspace: ws, realHomes, loginPaths, platform });

  const hook = trace && typeof trace.emit === 'function' ? trace : traceOf(ctx);
  const applied = (sandbox, wrapped, reason) => {
    hook.emit('sandbox.applied', reason ? { sandbox, reason } : { sandbox });
    return reason ? { argv: wrapped, sandbox, reason } : { argv: wrapped, sandbox };
  };
  const unsandboxed = (reason) => {
    if (required) throw runFailure('unsupported', `no OS sandbox for this run: ${reason}`);
    return applied('none', [...argv], reason);
  };

  if (platform === 'darwin') {
    const found = (detect.seatbelt || detectSeatbelt)();
    if (!found.available) return unsandboxed(found.error);
    return applied('seatbelt', wrapArgvWithSeatbelt(argv, {
      workspacePath: ws ? ws.path : run.home,
      workspaceAccess: ws ? ws.access : 'write',
      executablePath: argv[0],
      statePath: run.home,
      allowKeychainServices: false,
      denyPaths: loginPaths,
    }));
  }
  if (platform === 'linux') {
    const found = (detect.bwrap || detectBwrap)({ platform });
    if (!found.available) return unsandboxed(found.error);
    return applied('bwrap', wrapArgvWithBwrap(argv, {
      sandbox: {
        network: { policy: 'unrestricted' },
        // With a separate workspace, HOME is the extra writable mount.
        filesystem: ws ? { 'write-outside': [run.home] } : {},
      },
    }, {
      workspacePath: ws ? ws.path : run.home,
      workspaceAccess: ws ? ws.access : 'write',
      homePath: run.home,
      // The CLI by absolute path may live outside the default system binds.
      readOnlyPaths: [argv[0]],
    }));
  }
  return unsandboxed(`no supported OS sandbox on ${platform}`);
};
