/**
 * F370 (ADR-026): a stable, user-owned install of @commonlyai/cli, so the
 * daemon-first one-paste works from `npx` with no global install.
 *
 * Why this exists. `commonly daemon install` pins the launchd/systemd/schtasks
 * service to the EXACT interpreter + CLI entry that ran it (daemon-service.js,
 * resolved at install time). Run from the npx cache (`~/.npm/_npx/<hash>`),
 * that entry is shared across every npx run and evictable — `npm cache clean`
 * or ordinary reclamation deletes it, and the daemon then fails to start at the
 * next boot with nothing on screen to say why. `npm i -g` keeps a stable path
 * but is EACCES on a stock-Node Mac (the nodejs.org .pkg, no version manager)
 * and needs sudo — the exact wall that cost a first-time user an hour.
 *
 * So `daemon setup` installs the CLI UNDER $HOME — no sudo, no EACCES, no npx
 * cache — and runs `daemon install` AS that stable copy, which pins the service
 * there. The daemon then spawns its seats with its own argv (daemon.js `run`),
 * so the seats are pinned to the same stable CLI by construction.
 *
 * Side effects are injected so the install decision and the setup sequence are
 * unit-testable without touching npm or the network.
 */
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { resolveLaunch } from './windows-command.js';

export const CLI_PACKAGE = '@commonlyai/cli';

// The daemon's adapters (claude, codex) need a current Node; below this the
// setup fails later with a cryptic error, so it is named up front instead.
export const MIN_NODE_MAJOR = 22;

// One stable copy, one version at a time. `daemon setup` keeps it at the
// version that invoked it, so what runs resident is what the user installed.
export const stableCliDir = (home = homedir()) => join(home, '.commonly', 'cli');
export const stableCliEntry = (home = homedir()) => (
  join(stableCliDir(home), 'node_modules', CLI_PACKAGE, 'src', 'index.js')
);

/** The version installed at the stable path, or null when it is not there. */
export const stableInstalledVersion = (home = homedir(), { readFile = readFileSync, exists = existsSync } = {}) => {
  const manifest = join(stableCliDir(home), 'node_modules', CLI_PACKAGE, 'package.json');
  if (!exists(manifest)) return null;
  try {
    return JSON.parse(readFile(manifest, 'utf8')).version || null;
  } catch {
    return null;
  }
};

/** A message when this Node is too old for the daemon, or null when it is fine. */
export const nodeTooOld = (version = process.version, min = MIN_NODE_MAJOR) => {
  const major = Number.parseInt(String(version).replace(/^v/, '').split('.')[0], 10);
  if (!Number.isFinite(major) || major >= min) return null;
  return `Node ${version} is too old for the Commonly daemon, which needs Node ${min} or newer. `
    + 'Install the current Node from nodejs.org, or with a version manager such as nvm, then run this again.';
};

// Spawn one `npm` with the Windows-safe launcher the adapters use (npm is
// npm.cmd there, which Node cannot spawn without a shell). Inherits stdio so
// the one-time install is visible; rejects on a non-zero exit.
const runNpm = (args, { cwd, stdio = 'inherit', spawnImpl = spawn, resolution } = {}) => new Promise((resolve, reject) => {
  let launch;
  try {
    launch = resolveLaunch('npm', args, { cwd, ...resolution });
  } catch (error) {
    reject(error);
    return;
  }
  const child = spawnImpl(launch.command, launch.args, { cwd, stdio, env: process.env });
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm ${args[0] || ''} exited with code ${code}`))));
});

/**
 * Ensure @commonlyai/cli@<version> is installed under $HOME and return the
 * stable CLI entry to pin the daemon to. Idempotent: a stable copy already at
 * <version> is left as is.
 */
export const ensureStableCliInstall = async ({
  version,
  home = homedir(),
  mkdir = (dir) => mkdirSync(dir, { recursive: true }),
  installedVersion = stableInstalledVersion,
  runInstall = runNpm,
  log = () => {},
} = {}) => {
  if (!version) throw new Error('ensureStableCliInstall needs the version to pin');
  const dir = stableCliDir(home);
  const entry = stableCliEntry(home);
  if (installedVersion(home) === version) {
    return { entry, dir, version, installed: false };
  }
  mkdir(dir);
  log(`Installing ${CLI_PACKAGE}@${version} under ${dir} (no global install, no sudo)…`);
  // --prefix keeps it a local install under $HOME; the quiet flags keep the
  // one-time setup output readable.
  await runInstall(['install', '--prefix', dir, '--no-audit', '--no-fund', `${CLI_PACKAGE}@${version}`], { cwd: dir });
  return { entry, dir, version, installed: true };
};

/**
 * The daemon-first one-paste: a stable install, then login → register → install
 * run AS the stable CLI so the service is pinned there (and the seats with it).
 * `runCli(entry, args)` runs the stable CLI once and rejects on a non-zero exit.
 */
export const orchestrateDaemonSetup = async ({
  version,
  instanceUrl,
  runCli,
  unsandboxed = false,
  nodeVersion = process.version,
  ensureStable = ensureStableCliInstall,
  home = homedir(),
  log = () => {},
}) => {
  const tooOld = nodeTooOld(nodeVersion);
  if (tooOld) throw new Error(tooOld);
  if (typeof runCli !== 'function') throw new Error('orchestrateDaemonSetup needs a runCli function');
  const { entry } = await ensureStable({ version, home, log });
  // One spelling for both steps: login saves the URL without trailing slashes,
  // so register must look it up the same way or it can't find the token.
  const instance = instanceUrl ? String(instanceUrl).replace(/\/+$/, '') : '';
  const instanceArgs = instance ? ['--instance', instance] : [];
  // Each step must land before the next: a failed login must not register, a
  // failed register must not install. runCli rejects on a non-zero exit.
  await runCli(entry, ['login', ...instanceArgs]);
  await runCli(entry, ['daemon', 'register', ...instanceArgs]);
  // --unsandboxed is forwarded to the install step (native Windows refuses
  // without it); that step runs its own refusal + opt-in check.
  const installArgs = ['daemon', 'install', ...(unsandboxed ? ['--unsandboxed'] : [])];
  try {
    await runCli(entry, installArgs);
  } catch (error) {
    // The computer is registered by now, so running setup again would ask for a
    // login and stop at the active registration. Name the one step left.
    throw new Error(`${error.message}. This computer is registered; after fixing the error above, `
      + `finish with: "${process.execPath}" "${entry}" ${installArgs.join(' ')}`);
  }
  log('This computer is set up: the daemon is running and starts when you log in. '
    + 'Add an agent to it from the web app and it comes online here.');
  return { entry };
};
