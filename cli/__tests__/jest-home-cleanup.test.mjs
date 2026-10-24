import { expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const homePrefix = 'commonly-mcp-home-jest-';

test('a Jest run leaves no isolated MCP homes behind', () => {
  const isolatedTemp = mkdtempSync(join(tmpdir(), 'commonly-jest-cleanup-check-'));

  try {
    const run = spawnSync(process.execPath, [
      '--experimental-vm-modules',
      join(cliDir, 'node_modules/jest/bin/jest.js'),
      '--runInBand',
      '--runTestsByPath',
      join(cliDir, '__tests__/jest-home-cleanup.fixture.mjs'),
    ], {
      cwd: cliDir,
      env: { ...process.env, TMPDIR: isolatedTemp, TMP: isolatedTemp, TEMP: isolatedTemp },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(run.error).toBeUndefined();
    expect(`${run.stdout}\n${run.stderr}`).toContain('Test Suites: 1 passed');
    expect(run.status).toBe(0);
    expect(readdirSync(isolatedTemp).filter((name) => name.startsWith(homePrefix))).toEqual([]);
  } finally {
    rmSync(isolatedTemp, { recursive: true, force: true });
  }
});
