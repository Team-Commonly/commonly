// D245: the Windows form of `commonly daemon install`, a per-user Task
// Scheduler task. Side effects are injected (no schtasks here); the real
// register / kill / come-back proof is the windows-latest CI job
// (.github/workflows/daemon-windows.yml).
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { jest } from '@jest/globals';

import {
  installDaemonService,
  installSummary,
  restartDaemonService,
  servicePaths,
  startDaemonService,
  stopDaemonService,
  uninstallDaemonService,
  writeServiceFile,
} from '../src/lib/daemon-service.js';
import {
  POWERSHELL,
  WINDOWS_TASK_NAME,
  encodeLauncher,
  encodeTaskXml,
  psQuote,
  windowsLauncherScript,
  LAUNCHER_PID_ENV,
  watchWindowsLauncher,
  windowsTaskXml,
  windowsUserId,
} from '../src/lib/daemon-service-windows.js';

const home = 'C:\\Users\\Maya';
const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
const cliPath = 'C:\\Users\\Maya\\AppData\\Roaming\\npm\\node_modules\\@commonlyai\\cli\\src\\index.js';
const env = { USERNAME: 'Maya', USERDOMAIN: 'LAPTOP-7', COMMONLY_LITELLM_KEY: 'vk-secret' };

const makeDeps = () => ({
  writeFile: jest.fn(),
  mkdirp: jest.fn(),
  existsFile: jest.fn(() => true),
  removeFile: jest.fn(),
  execCmd: jest.fn(async () => {}),
  log: jest.fn(),
  warn: jest.fn(),
});

const written = (deps, file) => {
  const call = deps.writeFile.mock.calls.find(([path]) => path === file);
  return call && call[1];
};
const decodeXml = (buf) => buf.subarray(2).toString('utf16le');
const decodePs1 = (buf) => buf.subarray(3).toString('utf8');

describe('windows paths', () => {
  test('win32 installs a scheduled task whose definition lives in the profile', () => {
    const target = servicePaths('win32', home);
    expect(target.kind).toBe('schtasks');
    expect(target.taskName).toBe(WINDOWS_TASK_NAME);
    expect(target.file).toContain(join(home, '.commonly', 'daemon', 'service'));
    expect(target.launcher.endsWith('.ps1')).toBe(true);
    expect(target.envFile.endsWith('service-env.json')).toBe(true);
  });

  test('the user id is DOMAIN\\user, falling back to the bare name', () => {
    expect(windowsUserId({ env })).toBe('LAPTOP-7\\Maya');
    expect(windowsUserId({ env: { USERNAME: 'Maya' } })).toBe('Maya');
    expect(windowsUserId({ env: {}, lookupUsername: () => 'maya' })).toBe('maya');
  });
});

describe('the task definition', () => {
  const xml = windowsTaskXml({ launcher: 'C:\\Users\\Maya\\.commonly\\daemon\\service\\commonly-daemon.ps1', userId: 'LAPTOP-7\\Maya', home });

  test('starts at THIS user\'s logon, as that user, without elevation', () => {
    expect(xml).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>LAPTOP-7\\Maya<\/UserId>/);
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  test('a one-minute watchdog that never starts a second copy', () => {
    expect(xml).toMatch(/<TimeTrigger>[\s\S]*<Interval>PT1M<\/Interval>[\s\S]*<\/TimeTrigger>/);
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  });

  test('no run-time limit and no battery or idle stop (the default limit is 72 hours)', () => {
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(xml).toContain('<StopOnIdleEnd>false</StopOnIdleEnd>');
  });

  test('runs the launcher through Windows PowerShell, hidden, with no profile', () => {
    expect(xml).toContain(`<Command>${POWERSHELL}</Command>`);
    expect(xml).toContain('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File &quot;C:\\Users\\Maya\\.commonly\\daemon\\service\\commonly-daemon.ps1&quot;');
  });

  test('a user id cannot break the XML', () => {
    const odd = windowsTaskXml({ launcher: 'C:\\x.ps1', userId: 'A&B\\<Maya>', home });
    expect(odd).toContain('<UserId>A&amp;B\\&lt;Maya&gt;</UserId>');
    expect(odd).not.toContain('<Maya>');
  });

  test('the bytes are UTF-16LE with a BOM, as the declaration says', () => {
    const buf = encodeTaskXml(xml);
    expect([...buf.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(decodeXml(buf)).toBe(xml);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
  });
});

describe('the launcher', () => {
  const script = windowsLauncherScript({
    nodePath, cliPath, logPath: 'C:\\Users\\Maya\\.commonly\\logs\\daemon\\daemon.log', envFile: 'C:\\Users\\Maya\\.commonly\\daemon\\service\\service-env.json',
  });

  test('runs the exact interpreter and entry the install ran from', () => {
    expect(script).toContain(`$node = '${nodePath}'`);
    expect(script).toContain(`$cli = '${cliPath}'`);
    expect(script).toContain('& $node $cli daemon run --foreground');
  });

  test('restarts on every exit except 77 and 78, which disable the task and stop (systemd: RestartPreventExitStatus=77 78)', () => {
    expect(script).toContain('while ($true)');
    expect(script).toMatch(/if \(\$code -eq 77 -or \$code -eq 78\) \{\s*& schtasks\.exe \/Change \/TN \$task \/DISABLE \| Out-Null\s*if \(\$LASTEXITCODE -eq 0\) \{ exit \$code \}/);
    // N8: a park whose disable failed sleeps instead of exiting into the watchdog.
    expect(script).toMatch(/could not be disabled; parked[^\n]*\n\s*while \(\$true\) \{ Start-Sleep -Seconds 3600 \}/);
    expect(script).toContain('Start-Sleep -Seconds 5');
    // No other exit: a clean 0 restarts too, as Restart=always does.
    expect(script.match(/\bexit \$code\b/g)).toHaveLength(1);
    expect(script.match(/^\s*exit\b/gm)).toBeNull();
  });

  test('loads the service environment before node starts, and appends the log', () => {
    expect(script.indexOf('ConvertFrom-Json')).toBeLessThan(script.indexOf('& $node'));
    expect(script).toContain("[Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value, 'Process')");
    expect(script).toContain('Add-Content -LiteralPath $log -Encoding UTF8');
  });

  test('hands node its own pid (so ending the task ends the daemon) and reads node as UTF-8', () => {
    expect(script).toContain(`$env:${LAUNCHER_PID_ENV} = "$PID"`);
    expect(script).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8');
    expect(script.indexOf(LAUNCHER_PID_ENV)).toBeLessThan(script.indexOf('& $node'));
  });

  test('a quote in a path cannot close the string, including the curly ones PowerShell also accepts', () => {
    expect(psQuote("C:\\Users\\O'Brien")).toBe("'C:\\Users\\O''Brien'");
    expect(psQuote('C:\\Users\\O\u2019Brien')).toBe("'C:\\Users\\O\u2019\u2019Brien'");
    const odd = windowsLauncherScript({ nodePath, cliPath: "C:\\Users\\O'Brien\\cli.js'; Remove-Item C:\\ #", logPath: 'l', envFile: 'e' });
    expect(odd).toContain("$cli = 'C:\\Users\\O''Brien\\cli.js''; Remove-Item C:\\ #'");
  });

  test('the file is UTF-8 with a BOM, so Windows PowerShell 5.1 reads a non-ASCII user name correctly', () => {
    const buf = encodeLauncher(windowsLauncherScript({ nodePath, cliPath: 'C:\\Users\\张三\\cli.js', logPath: 'l', envFile: 'e' }));
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(decodePs1(buf)).toContain('张三');
  });
});

describe('windows install', () => {
  test('writes the env file, the launcher and the task, narrows the env file, replaces any running copy, and starts it', async () => {
    const deps = makeDeps();
    const target = await installDaemonService({
      platform: 'win32', home, nodePath, cliPath, env, providerKeyEnvNames: ['COMMONLY_LITELLM_KEY'], ...deps,
    });
    expect(target.kind).toBe('schtasks');
    expect(JSON.parse(written(deps, target.envFile))).toEqual({ COMMONLY_LITELLM_KEY: 'vk-secret' });
    expect(decodePs1(written(deps, target.launcher))).toContain(`$envFile = '${target.envFile}'`);
    expect(decodeXml(written(deps, target.file))).toContain(target.launcher);
    expect(deps.execCmd.mock.calls.map(([argv]) => argv)).toEqual([
      ['icacls', target.envFile, '/inheritance:r', '/grant:r', 'LAPTOP-7\\Maya:F'],
      ['schtasks', '/End', '/TN', WINDOWS_TASK_NAME],
      ['schtasks', '/Create', '/TN', WINDOWS_TASK_NAME, '/XML', target.file, '/F'],
      ['schtasks', '/Run', '/TN', WINDOWS_TASK_NAME],
    ]);
    expect(target.startsAtBoot).toBe(false);
    expect(installSummary(target)).toContain('starts at login');
  });

  test('a first install (no task to end) and a refused icacls still install, and the icacls refusal is said', async () => {
    const deps = makeDeps();
    deps.execCmd
      .mockRejectedValueOnce(new Error('icacls exited 5'))
      .mockRejectedValueOnce(new Error('schtasks /End exited 1'));
    await installDaemonService({ platform: 'win32', home, nodePath, cliPath, env, ...deps });
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('Could not narrow the permissions'));
    expect(deps.execCmd).toHaveBeenLastCalledWith(['schtasks', '/Run', '/TN', WINDOWS_TASK_NAME]);
  });

  test('a refused task registration surfaces instead of reporting success', async () => {
    const deps = makeDeps();
    deps.execCmd.mockImplementation(async (argv) => {
      if (argv[1] === '/Create') throw new Error('schtasks /Create exited 1');
    });
    await expect(installDaemonService({ platform: 'win32', home, nodePath, cliPath, env, ...deps })).rejects.toThrow('/Create');
    expect(deps.execCmd).not.toHaveBeenCalledWith(['schtasks', '/Run', '/TN', WINDOWS_TASK_NAME]);
  });

  test('a missing provider key is named, and is not in the env file', async () => {
    const deps = makeDeps();
    const target = await installDaemonService({
      platform: 'win32', home, nodePath, cliPath, env: { USERNAME: 'Maya' }, providerKeyEnvNames: ['COMMONLY_LITELLM_KEY'], ...deps,
    });
    expect(JSON.parse(written(deps, target.envFile))).toEqual({});
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('COMMONLY_LITELLM_KEY is not set'));
  });

  test('the env file goes through the 0600-at-creation writer (real file)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-env-'));
    try {
      const file = join(dir, 'service-env.json');
      writeServiceFile(file, '{"K":"v"}\n');
      expect(readFileSync(file, 'utf8')).toBe('{"K":"v"}\n');
      writeServiceFile(file, encodeTaskXml('<x/>'));
      expect(decodeXml(readFileSync(file))).toBe('<x/>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('windows uninstall and controls', () => {
  test('uninstall ends and deletes the task, then removes its three files', async () => {
    const deps = makeDeps();
    deps.execCmd.mockRejectedValueOnce(new Error('not running'));
    const target = await uninstallDaemonService({ platform: 'win32', home, ...deps });
    expect(deps.execCmd.mock.calls.map(([argv]) => argv)).toEqual([
      ['schtasks', '/End', '/TN', WINDOWS_TASK_NAME],
      ['schtasks', '/Delete', '/TN', WINDOWS_TASK_NAME, '/F'],
    ]);
    expect(deps.removeFile.mock.calls.map(([file]) => file).sort()).toEqual([target.envFile, target.file, target.launcher].sort());
  });

  test('stop disables BEFORE ending, so the watchdog cannot bring it back', async () => {
    const execCmd = jest.fn(async () => {});
    await stopDaemonService({ platform: 'win32', home, execCmd });
    expect(execCmd.mock.calls.map(([argv]) => argv)).toEqual([
      ['schtasks', '/Change', '/TN', WINDOWS_TASK_NAME, '/DISABLE'],
      ['schtasks', '/End', '/TN', WINDOWS_TASK_NAME],
    ]);
  });

  test('start enables (undoing a stop or a 77/78 park) and runs; restart ends first', async () => {
    const start = jest.fn(async () => {});
    await startDaemonService({ platform: 'win32', home, execCmd: start });
    expect(start.mock.calls.map(([argv]) => argv)).toEqual([
      ['schtasks', '/Change', '/TN', WINDOWS_TASK_NAME, '/ENABLE'],
      ['schtasks', '/Run', '/TN', WINDOWS_TASK_NAME],
    ]);
    const restart = jest.fn(async () => {});
    await restartDaemonService({ platform: 'win32', home, execCmd: restart });
    expect(restart.mock.calls[0][0]).toEqual(['schtasks', '/End', '/TN', WINDOWS_TASK_NAME]);
    expect(restart.mock.calls.slice(1).map(([argv]) => argv)).toEqual(start.mock.calls.map(([argv]) => argv));
  });
});

describe('the daemon follows its launcher (schtasks /End kills the launcher only; seen on windows-latest)', () => {
  const harness = (env, platform = 'win32') => {
    const ticks = [];
    const onGone = jest.fn();
    let alive = true;
    const stop = watchWindowsLauncher({
      env, platform, onGone, isAlive: () => alive,
      setIntervalFn: (fn) => { ticks.push(fn); return ticks.length; },
      clearIntervalFn: jest.fn(),
    });
    return { ticks, onGone, kill: () => { alive = false; }, stop };
  };

  test('shuts down once the launcher pid is gone, and only once', () => {
    const h = harness({ [LAUNCHER_PID_ENV]: '4242' });
    expect(h.ticks).toHaveLength(1);
    h.ticks[0]();
    expect(h.onGone).not.toHaveBeenCalled();
    h.kill();
    h.ticks[0]();
    expect(h.onGone).toHaveBeenCalledWith(4242);
  });

  test('does nothing for a daemon not started by the launcher, or off Windows', () => {
    expect(harness({}).ticks).toHaveLength(0);
    expect(harness({ [LAUNCHER_PID_ENV]: 'x' }).ticks).toHaveLength(0);
    expect(harness({ [LAUNCHER_PID_ENV]: '4242' }, 'linux').ticks).toHaveLength(0);
  });

  test('a lost pipe cannot end the daemon before it stops its seats: stream errors are swallowed from the start', async () => {
    const { EventEmitter } = await import('events');
    const out = new EventEmitter();
    const err = new EventEmitter();
    const ticks = [];
    watchWindowsLauncher({
      env: { [LAUNCHER_PID_ENV]: '4242' }, platform: 'win32', onGone: jest.fn(), isAlive: () => true,
      setIntervalFn: (fn) => { ticks.push(fn); return 1; }, clearIntervalFn: () => {},
      streams: [out, err],
    });
    // Armed before the first poll: a heartbeat log that hits EPIPE between the
    // launcher's exit and its detection no longer throws an unhandled error.
    expect(() => out.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    expect(() => err.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    // A daemon the launcher did not start keeps the default stream behaviour.
    const plain = new EventEmitter();
    watchWindowsLauncher({ env: {}, platform: 'win32', onGone: jest.fn(), streams: [plain] });
    expect(plain.listenerCount('error')).toBe(0);
  });

  test('the real liveness probe sees this process alive and a dead pid gone', () => {
    const onGone = jest.fn();
    const ticks = [];
    watchWindowsLauncher({
      env: { [LAUNCHER_PID_ENV]: String(process.pid) }, platform: 'win32', onGone,
      setIntervalFn: (fn) => { ticks.push(fn); return 1; }, clearIntervalFn: () => {},
    });
    ticks[0]();
    expect(onGone).not.toHaveBeenCalled();
    const dead = [];
    watchWindowsLauncher({
      env: { [LAUNCHER_PID_ENV]: '2147483646' }, platform: 'win32', onGone,
      setIntervalFn: (fn) => { dead.push(fn); return 1; }, clearIntervalFn: () => {},
    });
    // Already gone when armed: reported at once, and no poll is left running.
    expect(onGone).toHaveBeenCalledWith(2147483646);
    expect(dead).toHaveLength(0);
  });

  test('a launcher already gone when the watch is armed is reported at once, with the pipe guard in place', async () => {
    const { EventEmitter } = await import('events');
    const out = new EventEmitter();
    const ticks = [];
    const onGone = jest.fn(() => {
      // The shutdown logs; the guard is already listening when it does.
      expect(out.listenerCount('error')).toBe(1);
    });
    watchWindowsLauncher({
      env: { [LAUNCHER_PID_ENV]: '4242' }, platform: 'win32', onGone, isAlive: () => false,
      setIntervalFn: (fn) => { ticks.push(fn); return 1; }, clearIntervalFn: () => {},
      streams: [out],
    });
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(onGone).toHaveBeenCalledWith(4242);
    expect(ticks).toHaveLength(0);
  });
});
