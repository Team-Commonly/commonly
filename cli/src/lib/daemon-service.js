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

// PATH matters for the CHILDREN: the daemon spawns `commonly agent run`,
// which spawns the user's claude/codex CLI by name. launchd's default PATH
// has no /opt/homebrew/bin, so without this the daemon comes up and every
// seat dies at adapter detection.
const childPath = (nodePath) => [
  dirname(nodePath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
].filter((entry, index, all) => all.indexOf(entry) === index).join(':');

export const launchdPlist = ({ nodePath, cliPath, home = homedir() }) => `<?xml version="1.0" encoding="UTF-8"?>
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
\t</dict>
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

export const systemdUnit = ({ nodePath, cliPath }) => `[Unit]
Description=Commonly local agent daemon (ADR-026)
After=network-online.target

[Service]
ExecStart=${nodePath} ${cliPath} daemon run --foreground
Restart=always
RestartSec=5
Environment=PATH=${childPath(nodePath)}

[Install]
WantedBy=default.target
`;

export const installDaemonService = async ({
  platform = process.platform,
  home = homedir(),
  nodePath = process.execPath,
  cliPath = resolve(process.argv[1]),
  writeFile,
  mkdirp,
  execCmd, // async (argv: string[]) => void — throws on failure
  chmod = () => {},
  ensureFile,
  log = () => {},
}) => {
  const target = servicePaths(platform, home);
  mkdirp(dirname(target.file));
  mkdirp(dirname(daemonLogPath(home)));
  chmod(dirname(daemonLogPath(home)), 0o700);
  if (ensureFile) {
    ensureFile(daemonLogPath(home));
    chmod(daemonLogPath(home), 0o600);
  }

  if (target.kind === 'launchd') {
    writeFile(target.file, launchdPlist({ nodePath, cliPath, home }));
    // Reload cleanly if a previous version is loaded; the unload of an
    // unknown label fails by design and is ignored.
    await execCmd(['launchctl', 'unload', target.file]).catch(() => {});
    await execCmd(['launchctl', 'load', '-w', target.file]);
  } else {
    writeFile(target.file, systemdUnit({ nodePath, cliPath }));
    await execCmd(['systemctl', '--user', 'daemon-reload']);
    await execCmd(['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT]);
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
