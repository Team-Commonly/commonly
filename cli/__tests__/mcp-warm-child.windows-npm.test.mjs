// D164: preparing Commonly's tools on native Windows. The warm runs `npm view`
// and `npm install`, and on Windows `npm` is npm.cmd, which Node cannot spawn
// without a shell (ENOENT). So the warm never finished there, and a public
// seat refused every turn with public_mcp_unavailable: the page's Windows
// lines never answered an @mention. Simulated here: the resolver's platform,
// env and filesystem are injected, and child_process is mocked, so nothing is
// launched. The real host is walked by .github/workflows/byo-windows.yml.

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

import { fakeFs, NPM_NPM_CMD } from './fixtures/windows-shims.cjs';

const spawnMock = jest.fn();
await jest.unstable_mockModule('child_process', () => ({ spawn: spawnMock, spawnSync: jest.fn() }));
await jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock, spawnSync: jest.fn() }));

const { runCommand } = await import('../src/lib/mcp-warm-child.mjs');

const NODEJS = 'C:\\Program Files\\nodejs';
const NODE = `${NODEJS}\\node.exe`;
const NPM_CLI = `${NODEJS}\\node_modules\\npm\\bin\\npm-cli.js`;
const windows = (files = { [`${NODEJS}\\npm.cmd`]: NPM_NPM_CMD, [NODE]: 'MZ', [NPM_CLI]: '' }) => ({
  platform: 'win32',
  env: { Path: `C:\\Windows\\System32;${NODEJS}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
  execPath: NODE,
  ...fakeFs(files),
});

const fakeChild = (stdout) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  }, 0);
  return proc;
};

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild('"0.3.20"'));
});

describe('the warm runs npm on Windows', () => {
  test('npm.cmd is run as node.exe npm-cli.js, with no shell', async () => {
    const res = await runCommand('npm', ['view', '@commonlyai/mcp', 'version', '--json'], { resolution: windows() });
    expect(res).toEqual(expect.objectContaining({ ok: true, stdout: '"0.3.20"' }));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect([cmd, args]).toEqual([NODE, [NPM_CLI, 'view', '@commonlyai/mcp', 'version', '--json']]);
    expect(opts.shell).toBeUndefined();
  });

  test('no npm on PATH is a failed result with the reason, and nothing is spawned', async () => {
    const res = await runCommand('npm', ['view', '@commonlyai/mcp'], { resolution: windows({}) });
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/cannot launch npm on Windows without a shell: npm was not found on PATH/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // A relative PATH entry (`.`) names a folder relative to the child's working
  // directory, which is where Windows itself would look when spawning it there.
  // Read against this process's directory instead, an `npm.cmd` planted in the
  // folder Commonly was started from would run with the agent token in its env.
  test('a relative PATH entry is read in the child\'s cwd, not this process\'s', async () => {
    const home = 'C:\\Users\\me\\.commonly';
    const resolution = windows({
      'npm.cmd': NPM_NPM_CMD, // relative: what this process's cwd would hold
      [`${NODEJS}\\npm.cmd`]: NPM_NPM_CMD,
      [NODE]: 'MZ',
      [NPM_CLI]: '',
    });
    resolution.env.Path = `.;${NODEJS}`;
    await runCommand('npm', ['view', '@commonlyai/mcp'], { cwd: home, resolution });
    expect(spawnMock.mock.calls[0].slice(0, 2)).toEqual([NODE, [NPM_CLI, 'view', '@commonlyai/mcp']]);
    expect(spawnMock.mock.calls[0][2].cwd).toBe(home);
  });

  test('a relative PATH entry finds npm in the child\'s cwd', async () => {
    const home = 'C:\\Users\\me\\.commonly';
    const resolution = windows({
      [`${home}\\npm.cmd`]: NPM_NPM_CMD,
      [`${home}\\node_modules\\npm\\bin\\npm-cli.js`]: '',
      [NODE]: 'MZ',
    });
    resolution.env.Path = '.';
    await runCommand('npm', ['view', '@commonlyai/mcp'], { cwd: home, resolution });
    expect(spawnMock.mock.calls[0][1][0]).toBe(`${home}\\node_modules\\npm\\bin\\npm-cli.js`);
  });

  // TASK-775 (CodeRabbit on #3437): npm.cmd asks npm for its global prefix
  // and runs the npm there, so the warm must too. An npm left in
  // %APPDATA%\npm is not the one a configured prefix names.
  test('the warm runs the npm in npm\'s configured prefix, not one left in %APPDATA%\\npm', async () => {
    const home = 'C:\\Users\\me\\.commonly';
    const appData = 'C:\\Users\\me\\AppData\\Roaming';
    const configured = 'D:\\npm-global\\node_modules\\npm\\bin\\npm-cli.js';
    const prefixJs = `${NODEJS}\\node_modules\\npm\\bin\\npm-prefix.js`;
    const resolution = windows({
      [`${NODEJS}\\npm.cmd`]: NPM_NPM_CMD,
      [NODE]: 'MZ',
      [NPM_CLI]: '',
      [prefixJs]: '',
      [`${appData}\\npm\\node_modules\\npm\\bin\\npm-cli.js`]: '',
      [configured]: '',
    });
    resolution.env.APPDATA = appData;
    resolution.spawnSync = jest.fn(() => ({ status: 0, stdout: 'D:\\npm-global\r\n' }));
    await runCommand('npm', ['view', '@commonlyai/mcp'], { cwd: home, resolution });
    expect(resolution.spawnSync.mock.calls[0].slice(0, 2)).toEqual([NODE, [prefixJs]]);
    expect(resolution.spawnSync.mock.calls[0][2].cwd).toBe(home);
    expect(spawnMock.mock.calls[0].slice(0, 2)).toEqual([NODE, [configured, 'view', '@commonlyai/mcp']]);
  });

  test('off Windows the name is spawned as given', async () => {
    const res = await runCommand('npm', ['view', '@commonlyai/mcp'], { resolution: { platform: 'linux' } });
    expect(res.ok).toBe(true);
    expect(spawnMock.mock.calls[0].slice(0, 2)).toEqual(['npm', ['view', '@commonlyai/mcp']]);
  });
});
