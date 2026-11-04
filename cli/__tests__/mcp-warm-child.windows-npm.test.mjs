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

  test('off Windows the name is spawned as given', async () => {
    const res = await runCommand('npm', ['view', '@commonlyai/mcp'], { resolution: { platform: 'linux' } });
    expect(res.ok).toBe(true);
    expect(spawnMock.mock.calls[0].slice(0, 2)).toEqual(['npm', ['view', '@commonlyai/mcp']]);
  });
});
