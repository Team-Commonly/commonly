// claudeRuntimeInventory on Windows (#2141): a bare `claude --help` is ENOENT
// against an npm `claude.cmd`, which emptied the effort menu. The resolver's
// platform/env/fs are injected, so this runs the same on macOS and Linux CI.

import { jest } from '@jest/globals';

import { claudeRuntimeInventory } from '../src/lib/native-runtime-inventory.js';
import { currentJsShim, fakeFs } from './fixtures/windows-shims.cjs';

const NPM = 'C:\\Users\\ada\\AppData\\Roaming\\npm';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const CLAUDE_JS = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
const HELP = '  --effort <level> Effort\n    (low, medium, high, xhigh)\n  --model <m> Model';

test('win32: `claude --help` runs as node + cli.js from the npm shim, without a shell', async () => {
  const spawnSyncImpl = jest.fn(() => ({ status: 0, stdout: HELP }));
  const env = { Path: NPM };
  const result = await claudeRuntimeInventory({
    spawnSyncImpl,
    env,
    commandResolution: {
      platform: 'win32',
      execPath: NODE,
      ...fakeFs({ [`${NPM}\\claude.cmd`]: currentJsShim('node_modules\\@anthropic-ai\\claude-code\\cli.js'), [CLAUDE_JS]: '' }),
    },
  });
  expect(result).toEqual({ models: null, efforts: ['low', 'medium', 'high', 'xhigh'] });
  const [cmd, args, opts] = spawnSyncImpl.mock.calls[0];
  expect([cmd, args]).toEqual([NODE, [CLAUDE_JS, '--help']]);
  expect(opts.shell).toBeUndefined();
  expect(opts.env).toBe(env);
});

test('win32: an unresolvable claude gives an empty inventory and spawns nothing', async () => {
  const spawnSyncImpl = jest.fn();
  expect(await claudeRuntimeInventory({
    spawnSyncImpl, env: { Path: NPM }, commandResolution: { platform: 'win32', ...fakeFs({}) },
  })).toEqual({ models: null, efforts: [] });
  expect(spawnSyncImpl).not.toHaveBeenCalled();
});

test.each(['darwin', 'linux'])('%s: still the bare `claude --help`', async (platform) => {
  const spawnSyncImpl = jest.fn(() => ({ status: 0, stdout: HELP }));
  await claudeRuntimeInventory({ spawnSyncImpl, env: { PATH: '/usr/bin' }, commandResolution: { platform } });
  expect(spawnSyncImpl.mock.calls[0].slice(0, 2)).toEqual(['claude', ['--help']]);
});
