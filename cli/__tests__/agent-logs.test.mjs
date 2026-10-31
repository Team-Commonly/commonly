import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
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

test('agent logs --pod without an owner login fails with the login hint and no token line', () => {
  const home = mkdtempSync(join(tmpdir(), 'commonly-agent-logs-'));
  const result = runLogs(home, ['ghost', '--pod', '6a692a1be833c668acdb84cf']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Not logged in. Run: commonly login');
});

test('agent logs without a local log or --pod names the flag that reads server activity', () => {
  const home = mkdtempSync(join(tmpdir(), 'commonly-agent-logs-'));
  const result = runLogs(home, ['ghost']);
  expect(result.stderr).toContain('Pass --pod <podId>');
});

test('agent logs --pod takes the server path even when a local log exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'commonly-agent-logs-'));
  const path = daemonSeatLogPath('forge', home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'local line\n');
  const result = runLogs(home, ['forge', '--pod', '6a692a1be833c668acdb84cf']);
  expect(result.stdout).not.toContain('local line');
  expect(result.stderr).toContain('Not logged in. Run: commonly login');
});

test('agent logs rejects a non-numeric --lines with one line', () => {
  const home = mkdtempSync(join(tmpdir(), 'commonly-agent-logs-'));
  const result = runLogs(home, ['forge', '--lines', 'abc']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--lines must be a positive integer, got 'abc'");
});

test('agent logs --follow with --pod is refused before any network call', () => {
  const home = mkdtempSync(join(tmpdir(), 'commonly-agent-logs-'));
  const result = runLogs(home, ['forge', '--pod', '6a692a1be833c668acdb84cf', '--follow']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--follow needs a local seat log');
  expect(result.stderr).not.toContain('Not logged in');
});

// Runs `commonly agent logs` without blocking, so an in-process server can answer it.
const runLogsAsync = (home, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cliEntry, 'agent', 'logs', ...args], {
    env: { ...process.env, HOME: home, COMMONLY_AGENT_TOKEN: '', COMMONLY_API_URL: '', COMMONLY_TOKEN: '' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('agent logs --pod sends the owner bearer token and prints the server activity', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: new URL(req.url, 'http://127.0.0.1'), auth: req.headers.authorization });
    const authorized = req.headers.authorization === 'Bearer owner-token';
    res.writeHead(authorized ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(authorized
      ? {
        events: [{ type: 'chat.mention', status: 'delivered', createdAt: '2026-10-31T22:00:00Z', outcome: 'posted' }],
        runs: [{ trigger: 'mention', status: 'completed', startedAt: '2026-10-31T22:00:01Z', totalTokens: 812 }],
      }
      : { message: 'Unauthorized' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const home = mkdtempSync(join(tmpdir(), 'commonly-agent-logs-'));
    mkdirSync(join(home, '.commonly'), { recursive: true });
    writeFileSync(join(home, '.commonly', 'config.json'), JSON.stringify({
      active: 'local',
      instances: { local: { url: `http://127.0.0.1:${server.address().port}`, token: 'owner-token', userId: 'u1', username: 'owner' } },
    }));
    const result = await runLogsAsync(home, ['forge', '--pod', '6a692a1be833c668acdb84cf']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('chat.mention');
    expect(result.stdout).toContain('run mention');
    expect(result.stdout).not.toContain('owner-token');
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe('Bearer owner-token');
    expect(seen[0].url.pathname).toBe('/api/agents/seat-activity');
    expect(seen[0].url.searchParams.get('podId')).toBe('6a692a1be833c668acdb84cf');
    expect(seen[0].url.searchParams.get('agentName')).toBe('forge');
  } finally {
    server.close();
  }
});
