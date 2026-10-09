/**
 * ADR-026 D1: install-once service registration for the resident daemon.
 *
 * macOS gets a launchd LaunchAgent (KeepAlive — launchd itself restarts a
 * dead daemon), Linux a systemd user unit (Restart=always). Both run the
 * exact interpreter + CLI entry that executed `daemon install`, resolved at
 * install time — a PATH lookup at boot would race version managers and
 * silently run a different install than the one the user tested.
 *
 * Pure generators + injected side effects, same discipline as the
 * supervisor: the unit CONTENT is unit-testable without touching launchctl.
 */

import { randomBytes } from 'crypto';
import { renameSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';

export const LAUNCHD_LABEL = 'me.commonly.daemon';
export const SYSTEMD_UNIT = 'commonly-daemon.service';

export const daemonLogPath = (home = homedir()) => join(home, '.commonly', 'logs', 'daemon', 'daemon.log');

export const servicePaths = (platform = process.platform, home = homedir()) => (
  platform === 'darwin'
    ? { kind: 'launchd', file: join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`) }
    : { kind: 'systemd', file: join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT) }
);

const xmlEscape = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The systemd sink is NOT the plist sink, so escaping one is not escaping both.
// Inside `Environment="…"` a raw `"` closes the quote, and a raw newline ends
// the assignment so the remainder of the key lands in the unit as a directive.
// The adversary here is the operator's own environment, so severity is low —
// but correctness does not need an adversary: a provider key containing a `"`
// writes a unit that will not start, with nothing on screen to say why.
// systemd quoted values carry C-style escapes (systemd.syntax(7)), so both
// values are escaped and neither sink is trusted to be the harmless one. The
// last replacement is the least obvious: `Environment=` does NOT expand `$VAR`
// but DOES perform specifier expansion (systemd.exec(5), "Specifier expansion is
// performed"), and `systemd.unit(5)` gives the escape — `%%` in place of `%`.
// A key containing `%h` would otherwise be rewritten to the home directory: the
// unit parses, the daemon starts, the seat gets a key nobody exported, and it
// fails at the provider with nothing at daemon level naming the cause — the same
// failure class this code exists to remove, arriving through the escaping.
const systemdEscape = (value) => String(value)
  .replace(/%/g, '%%')
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\n/g, '\\n')
  .replace(/\r/g, '\\r')
  .replace(/\t/g, '\\t');

// PATH matters for the CHILDREN: the daemon spawns `commonly agent run`,
// which spawns the user's claude/codex CLI by name. launchd's default PATH
// has no /opt/homebrew/bin, so without this the daemon comes up and every
// seat dies at adapter detection.
const childPath = (nodePath) => [
  dirname(nodePath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
].filter((entry, index, all) => all.indexOf(entry) === index).join(':');

// TASK-049: PATH is not the only thing the children need.
//
// launchd and systemd both start the daemon from a CLEAN environment, so a
// seat's provider key that exists only in the operator's interactive shell is
// absent at boot — and the seat then dies inside its own adapter (`pi.js`
// throws `COMMONLY_LITELLM_KEY is not set`). That is the same defect the PATH
// line above fixes, one layer over, and it is fixed the same way: carry what
// the install could see. Installation is the ONLY moment the operator's shell is
// in reach, so the keys are captured there, and the ones that were missing are
// named at install time rather than discovered one crash-looping seat at a time.
//
// The values are secrets. The daemon's own credential is a 0600 file, so the
// service file is written 0600 too instead of being left at the umask default a
// PATH-only unit could safely keep.
//
// The mode is guaranteed BY CONSTRUCTION rather than by the order of two calls:
// the content is written to a sibling temp file CREATED 0600 and then renamed
// over the target. `writeFileSync`'s mode applies only at creation, so the
// obvious alternatives each leave a path open — a write straight to the target
// cannot narrow a file an EARLIER install left at 0644 (its mode survives the
// write, and a pre-existing 0644 service file is what every upgrade meets),
// and a chmod after the write closes the door the key already walked through.
// The rename also removes a second hazard, narrower than it first looks: systemd
// does NOT re-read a changed unit by itself — it reports the file as changed on
// disk and keeps the loaded copy until a `systemctl --user daemon-reload`. What
// is exposed is a reader CONCURRENT with the write, and that is not exotic here:
// an install ends by running `daemon-reload`, every other install on the machine
// can run one at the same moment, and `systemctl --user show` reads the file.
// After a rename each of them sees the old file or the new one, never a
// truncated unit.
//
// POSIX rename replaces the destination atomically, so this needs no
// chmod-if-exists dance and no cleanup of the old file.
//
// The temp NAME and the temp WRITE are each half of the same defence, and
// neither is sufficient on its own. A predictable name (`<file>.tmp-<pid>`) lets
// a process running as this user — which is every seat this repo spawns —
// pre-plant a symlink at that path and capture the key when the write follows
// it; `O_EXCL` is what actually refuses that, because it fails on a symlink at
// the final component instead of writing through it. The random suffix only
// removes the easy target, and the cleanup only deletes a temp this call made.
export const SERVICE_FILE_MODE = 0o600;

// Exported so the O_EXCL refusal is witnessed against a real symlink at a known
// path rather than assumed from the absence of a race.
export const serviceTempPath = (file, suffix = randomBytes(6).toString('hex')) => `${file}.tmp-${suffix}`;

export const writeServiceFile = (file, content, { suffix } = {}) => {
  const tmp = serviceTempPath(file, suffix);
  let created = false;
  try {
    // `wx` = O_CREAT|O_EXCL: the write either creates the temp itself or does not
    // happen at all, so a planted path is refused rather than followed.
    writeFileSync(tmp, content, { encoding: 'utf8', mode: SERVICE_FILE_MODE, flag: 'wx' });
    created = true;
    renameSync(tmp, file);
  } catch (error) {
    // Only the temp this call created is ours to remove. After a refused write
    // the path belongs to whoever planted it.
    if (created) {
      try {
        unlinkSync(tmp);
      } catch {
        // Nothing to clean up; the original error is the one that matters.
      }
    }
    throw error;
  }
};
export const providerEnvPairs = ({ names = [], env = process.env } = {}) => names
  .filter((name) => env[name])
  .map((name) => [name, String(env[name])]);

export const missingProviderKeys = ({ names = [], env = process.env } = {}) => names
  .filter((name) => !env[name]);

const plistEnvPairs = (pairs) => pairs
  .map(([name, value]) => `\t\t<key>${xmlEscape(name)}</key>\n\t\t<string>${xmlEscape(value)}</string>\n`)
  .join('');

export const launchdPlist = ({ nodePath, cliPath, home = homedir(), providerEnv = [] }) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCHD_LABEL}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${xmlEscape(childPath(nodePath))}</string>
\t\t<key>HOME</key>
\t\t<string>${xmlEscape(home)}</string>
${plistEnvPairs(providerEnv)}\t</dict>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xmlEscape(nodePath)}</string>
\t\t<string>${xmlEscape(cliPath)}</string>
\t\t<string>daemon</string>
\t\t<string>run</string>
\t\t<string>--foreground</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(daemonLogPath(home))}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(daemonLogPath(home))}</string>
</dict>
</plist>
`;

export const systemdUnit = ({ nodePath, cliPath, providerEnv = [] }) => {
  const providerLines = providerEnv.length
    ? `\n${providerEnv.map(([name, value]) => `Environment="${systemdEscape(`${name}=${value}`)}"`).join('\n')}`
    : '';
  return `[Unit]
Description=Commonly local agent daemon (ADR-026)
After=network-online.target

[Service]
ExecStart=${nodePath} ${cliPath} daemon run --foreground
Restart=always
RestartSec=5
Environment=PATH=${childPath(nodePath)}${providerLines}

[Install]
WantedBy=default.target
`;
};

export const installDaemonService = async ({
  platform = process.platform,
  home = homedir(),
  nodePath = process.execPath,
  cliPath = resolve(process.argv[1]),
  // The provider keys the seats' adapters declare (adapters/index.js).
  providerKeyEnvNames = [],
  env = process.env,
  writeFile = writeServiceFile,
  mkdirp,
  execCmd, // async (argv: string[]) => void — throws on failure
  chmod = () => {},
  ensureFile,
  log = () => {},
  warn = log,
}) => {
  const target = servicePaths(platform, home);
  mkdirp(dirname(target.file));
  mkdirp(dirname(daemonLogPath(home)));
  chmod(dirname(daemonLogPath(home)), 0o700);
  if (ensureFile) {
    ensureFile(daemonLogPath(home));
    chmod(daemonLogPath(home), 0o600);
  }

  const providerEnv = providerEnvPairs({ names: providerKeyEnvNames, env });
  const missing = missingProviderKeys({ names: providerKeyEnvNames, env });

  if (target.kind === 'launchd') {
    // The mode and the atomicity are the WRITER's, not an ordering rule here:
    // `writeServiceFile` creates a 0600 sibling and renames it over the target,
    // so no chmod is needed on this path and no half-written unit is ever
    // visible to launchd (see the writer for why neither half could cover both).
    writeFile(target.file, launchdPlist({ nodePath, cliPath, home, providerEnv }));
    // Reload cleanly if a previous version is loaded; the unload of an
    // unknown label fails by design and is ignored.
    await execCmd(['launchctl', 'unload', target.file]).catch(() => {});
    await execCmd(['launchctl', 'load', '-w', target.file]);
  } else {
    writeFile(target.file, systemdUnit({ nodePath, cliPath, providerEnv }));
    await execCmd(['systemctl', '--user', 'daemon-reload']);
    await execCmd(['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT]);
  }
  for (const name of missing) {
    warn(`${name} is not set in this shell, so it is NOT in the service file. A seat whose adapter needs it will fail to start; export it and re-run: commonly daemon install (docs/agents/daemon-service-environment.md)`);
  }
  log(`Installed ${target.kind} service (${target.file}). Logs: ${daemonLogPath(home)}`);
  return target;
};

export const uninstallDaemonService = async ({
  platform = process.platform,
  home = homedir(),
  existsFile,
  removeFile,
  execCmd,
  log = () => {},
}) => {
  const target = servicePaths(platform, home);
  if (!existsFile(target.file)) {
    log('No installed daemon service found.');
    return null;
  }
  if (target.kind === 'launchd') {
    await execCmd(['launchctl', 'unload', '-w', target.file]).catch(() => {});
  } else {
    await execCmd(['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT]).catch(() => {});
  }
  removeFile(target.file);
  log(`Removed ${target.kind} service (${target.file}).`);
  return target;
};

const serviceAction = async ({
  action,
  platform = process.platform,
  home = homedir(),
  execCmd,
}) => {
  const target = servicePaths(platform, home);
  if (target.kind === 'launchd') {
    if (action === 'start') {
      // `install` already loads the plist. A second `start` should be
      // idempotent rather than failing with "already loaded".
      await execCmd(['launchctl', 'load', '-w', target.file]).catch(async () => {
        await execCmd(['launchctl', 'start', LAUNCHD_LABEL]);
      });
    }
    else if (action === 'stop') await execCmd(['launchctl', 'unload', '-w', target.file]);
    else {
      await execCmd(['launchctl', 'unload', '-w', target.file]).catch(() => {});
      await execCmd(['launchctl', 'load', '-w', target.file]);
    }
  } else {
    await execCmd(['systemctl', '--user', action, SYSTEMD_UNIT]);
  }
  return target;
};

export const startDaemonService = (options) => serviceAction({ ...options, action: 'start' });
export const stopDaemonService = (options) => serviceAction({ ...options, action: 'stop' });
export const restartDaemonService = (options) => serviceAction({ ...options, action: 'restart' });
