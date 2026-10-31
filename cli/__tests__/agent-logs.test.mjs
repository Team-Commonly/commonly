import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { daemonSeatLogPath } from '../src/lib/daemon-logs.js';

const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

// Runs `commonly agent logs` against a throwaway HOME so no real seat log or
// token file on this machine can leak into the result.
const runLogs = (home, args) => spawnSync(process.execPath, [cliEntry, 'agent', 'logs', ...args], {
  env: { ...process.env, HOME: home, COMMONLY_AGENT_TOKEN: '', COMMONLY_API_URL: '' },
  encoding: 'utf8',
});

test('agent logs fails non-zero with one plain line when the seat has no local log', () => {
  const home = mkdtempSync(join(tmpdir(), 'commonly-agent-logs-'));
  const result = runLogs(home, ['ghost']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("No local log for 'ghost'");
  expect(result.stderr).not.toMatch(/Missing agent token|Not logged in/);
});

test('agent logs prints the trailing lines of a supervised seat log', () => {
  const home = mkdtempSync(join(tmpdir(), 'commonly-agent-logs-'));
  const path = daemonSeatLogPath('forge', home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'one\ntwo\nthree\nfour\n');
  const result = runLogs(home, ['forge', '--lines', '2']);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('three\nfour\n');
});
