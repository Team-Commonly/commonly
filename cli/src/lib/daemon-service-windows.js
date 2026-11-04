/**
 * D245: the Windows form of `commonly daemon install` (ADR-026 D1).
 *
 * macOS has launchd and Linux has systemd; Windows has Task Scheduler. A
 * per-user task needs no administrator, so the install stays a one-liner a
 * person can run in their own PowerShell. The shape mirrors the other two:
 *
 * - The task starts at this user's logon (a LogonTrigger naming the user; a
 *   trigger for ANY user's logon needs an administrator).
 * - Keep-alive lives in the launcher, a PowerShell script that loops on
 *   `node <cli> daemon run --foreground`: it restarts on every exit except 77
 *   and 78, the same codes `RestartPreventExitStatus=77 78` exempts on systemd
 *   (a revoked key and a bad local registration). Task Scheduler's own
 *   "restart on failure" fires when a task fails to START, not when its
 *   program exits non-zero, so it cannot be the keep-alive.
 * - A one-minute repeating trigger with `IgnoreNew` is the watchdog for the
 *   launcher itself: while the task runs it starts nothing, and if the
 *   launcher is killed the next minute brings it back.
 * - On 77/78 the launcher disables the task before it exits, so the watchdog
 *   does not restart a daemon that has been told to stop. That is launchd's
 *   "park on a successful exit" in Task Scheduler's terms; `daemon start` and
 *   `daemon restart` enable it again.
 *
 * A task cannot carry environment variables, so the provider keys the seats
 * need (TASK-049) go in a JSON file the launcher loads before it starts node.
 * The file is written through the same 0600-at-creation writer as the unit
 * files, and its ACL is then narrowed to this user (best effort; the profile
 * directory is already private by default).
 *
 * Windows has no Seatbelt or bwrap, so a daemon-run seat here is unconfined.
 * That is stated on the BYO page and in docs/agents/daemon-service-windows.md.
 */

import { join } from 'path';

export const WINDOWS_TASK_NAME = 'CommonlyDaemon';

export const windowsServicePaths = (home) => {
  const dir = join(home, '.commonly', 'daemon', 'service');
  return {
    kind: 'schtasks',
    // The task definition doubles as the "is it installed" record, the way the
    // plist and the unit file do on the other two platforms.
    file: join(dir, 'commonly-daemon-task.xml'),
    launcher: join(dir, 'commonly-daemon.ps1'),
    envFile: join(dir, 'service-env.json'),
    taskName: WINDOWS_TASK_NAME,
  };
};

const xmlEscape = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// A PowerShell single-quoted string ends at ANY of the four single-quote
// characters it recognises (' and the curly ‘ ’ ‚ ‛), and each is escaped by
// doubling. A user named O'Brien, or a path with a curly quote in it, would
// otherwise close the string and run the rest of the path as script.
export const psQuote = (value) => `'${String(value).replace(/['‘’‚‛]/g, (q) => q + q)}'`;

export const windowsLauncherScript = ({ nodePath, cliPath, logPath, envFile, taskName = WINDOWS_TASK_NAME }) => `# Commonly daemon launcher. Written by \`commonly daemon install\`; re-run that command instead of editing this file.
# It loads the service environment, then keeps \`commonly daemon run\` alive: every exit restarts it after 5 s,
# except 77 (this computer's key was revoked) and 78 (no valid local registration), which disable the task and stop.
$ErrorActionPreference = 'Continue'
$node = ${psQuote(nodePath)}
$cli = ${psQuote(cliPath)}
$log = ${psQuote(logPath)}
$envFile = ${psQuote(envFile)}
$task = ${psQuote(taskName)}
if (Test-Path -LiteralPath $envFile) {
  $cfg = Get-Content -LiteralPath $envFile -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($p in $cfg.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value, 'Process') }
}
$env:Path = (Split-Path -Parent $node) + ';' + $env:Path
while ($true) {
  & $node $cli daemon run --foreground 2>&1 | ForEach-Object { "$_" } | Add-Content -LiteralPath $log -Encoding UTF8
  $code = $LASTEXITCODE
  if ($code -eq 77 -or $code -eq 78) {
    & schtasks.exe /Change /TN $task /DISABLE | Out-Null
    exit $code
  }
  Start-Sleep -Seconds 5
}
`;

// UTF-8 with a BOM: Windows PowerShell 5.1 reads a BOM-less .ps1 in the ANSI
// code page, which would mangle a non-ASCII user name in any of the paths.
export const encodeLauncher = (script) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(script, 'utf8')]);

export const POWERSHELL = '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export const windowsTaskXml = ({ launcher, userId, home }) => `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Commonly local agent daemon (ADR-026). Installed by: commonly daemon install</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(POWERSHELL)}</Command>
      <Arguments>${xmlEscape(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcher}"`)}</Arguments>
      <WorkingDirectory>${xmlEscape(home)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;

// schtasks reads a task file as UTF-16; the declaration above says so, and the
// bytes must agree with it (little-endian, with the BOM).
export const encodeTaskXml = (xml) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);

// Task Scheduler names a user DOMAIN\user. A bare name resolves too, but the
// qualified one cannot be mistaken for a same-named account on the domain.
export const windowsUserId = ({ env = process.env, lookupUsername }) => {
  if (env.USERNAME) return env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
  return lookupUsername();
};

export const installWindowsService = async ({
  home, nodePath, cliPath, logPath, providerEnv, env, writeFile, execCmd, lookupUsername, warn,
}) => {
  const target = windowsServicePaths(home);
  const userId = windowsUserId({ env, lookupUsername });
  writeFile(target.envFile, `${JSON.stringify(Object.fromEntries(providerEnv), null, 2)}\n`);
  try {
    await execCmd(['icacls', target.envFile, '/inheritance:r', '/grant:r', `${userId}:F`]);
  } catch (error) {
    warn(`Could not narrow the permissions on ${target.envFile} (${error.message}). It holds your provider keys; it sits in your profile, which only you can read by default.`);
  }
  writeFile(target.launcher, encodeLauncher(windowsLauncherScript({ nodePath, cliPath, logPath, envFile: target.envFile })));
  writeFile(target.file, encodeTaskXml(windowsTaskXml({ launcher: target.launcher, userId, home })));
  // A running launcher keeps the environment it started with, so end it first
  // (an absent task fails by design) and start the new definition after.
  await execCmd(['schtasks', '/End', '/TN', target.taskName]).catch(() => {});
  await execCmd(['schtasks', '/Create', '/TN', target.taskName, '/XML', target.file, '/F']);
  await execCmd(['schtasks', '/Run', '/TN', target.taskName]);
  return target;
};

export const uninstallWindowsService = async ({ home, execCmd, removeFile, existsFile }) => {
  const target = windowsServicePaths(home);
  await execCmd(['schtasks', '/End', '/TN', target.taskName]).catch(() => {});
  await execCmd(['schtasks', '/Delete', '/TN', target.taskName, '/F']).catch(() => {});
  for (const file of [target.file, target.launcher, target.envFile]) {
    if (existsFile(file)) removeFile(file);
  }
  return target;
};

export const windowsServiceAction = async ({ action, home, execCmd }) => {
  const target = windowsServicePaths(home);
  const name = target.taskName;
  if (action === 'stop') {
    // Disabled first, so the one-minute watchdog cannot start it again.
    await execCmd(['schtasks', '/Change', '/TN', name, '/DISABLE']);
    await execCmd(['schtasks', '/End', '/TN', name]).catch(() => {});
    return target;
  }
  if (action === 'restart') await execCmd(['schtasks', '/End', '/TN', name]).catch(() => {});
  await execCmd(['schtasks', '/Change', '/TN', name, '/ENABLE']);
  await execCmd(['schtasks', '/Run', '/TN', name]);
  return target;
};
