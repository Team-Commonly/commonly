import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { baseline, main, render } from '../scripts/seat-log-baseline.mjs';

const L = (ts, msg, seat = 'nib') => `2026-10-24T${ts}Z [${seat}] ${msg}`;
const LOG = [
  L('00:00:00.000', 'polling https://api.commonly.me for events (ctrl+c to stop)'),
  L('01:00:00.000', '[inbox.batch] spawning codex'),
  L('01:00:00.400', 'spawn credential minted (6adbd35b8522fc8abce9b7b6, granted 9 tools)'),
  L('01:00:30.000', 'spawn credential revoked (6adbd35b8522fc8abce9b7b6)'),
  L('01:00:30.300', '[inbox.batch] agent posted via tool this turn — not echoing CLI output'),
  L('02:00:00.000', '[inbox.batch] spawning codex'),
  L('02:45:00.000', 'spawn credential revoked (6adbd35b8522fc8abce9b7b7)'),
  L('02:45:00.100', 'inbox batch processing failed (runtime; 1 consecutive) — 1 events remain unacked; retry scheduled, next probe in 5.6s: codex timed out after 2700000ms SECRET-STDERR-TEXT'),
  '<!DOCTYPE html> SECRET-HTML',
  L('03:00:00.000', '[chat.mention] spawning codex'),
  L('03:00:05.000', 'inbox batch processing failed (runtime; 1 consecutive) — 1 events remain unacked: codex exited with code 7: SECRET-STDERR-TEXT'),
  L('04:00:00.000', '[inbox.batch] spawning claude'),
  L('04:01:00.000', 'stopping after the current turn...'),
  L('04:02:00.000', 'fetch failed'),
  L('05:00:00.000', '[inbox.batch] spawning claude', 'quire'),
  L('06:00:00.000', '[inbox.batch] spawning codex'),
].join('\n');

test('turns, durations, timeouts, exits, restarts, and an open turn, from timestamps and fixed phrases', () => {
  const r = baseline(LOG, { seat: 'nib', untilMs: Date.parse('2026-10-24T07:00:00Z'), hours: 48 });
  expect(r.byAdapter.codex).toMatchObject({
    turns: 4, ok: 1, failed: 2, timeouts: 1, exits: { 7: 1 }, errors: 0, open: 1, atOrOverTimeout: 1,
    outcomes: { delivered: 1, failed: 2 },
  });
  expect(r.byAdapter.codex.durationMs).toEqual({ p50: 30_000, p90: 2_700_100, p99: 2_700_100, max: 2_700_100, n: 3 });
  expect(r.byAdapter.claude).toMatchObject({ turns: 1, cutByRestart: 1 });
  expect(r.counts).toMatchObject({ untimestamped: 1, pollErrors: 1, restarts: 0, otherSeatLines: 1 });
  const out = `${render(r)}\n${JSON.stringify(r)}`;
  expect(out).not.toMatch(/SECRET/);
  expect(out).toMatch(/the log cannot tell/);
});

test('ask outcomes close a turn, and a refused spawn credential is not a turn', () => {
  const log = [
    L('01:00:00.000', '[agent.ask] spawning codex'),
    L('01:00:10.000', '[agent.ask] routed private response (42 bytes)'),
    L('02:00:00.000', '[agent.ask] spawning codex'),
    L('02:00:10.000', '[agent.ask] response already routed by agent tool'),
    L('03:00:00.000', '[agent.ask] spawning codex'),
    L('03:00:10.000', '[agent.ask] no private response (empty output)'),
    L('04:00:00.000', '[inbox.batch] spawning codex'),
    L('04:00:00.300', 'spawn credential refused (HTTP 403) — not spawning'),
    L('05:00:00.000', '[inbox.batch] spawning codex'),
    L('05:00:20.000', '[inbox.batch] no wrapper-post (NO_REPLY)'),
  ].join('\n');
  const r = baseline(log, { seat: 'nib', untilMs: Date.parse('2026-10-24T06:00:00Z'), hours: 8 });
  expect(r.byAdapter.codex).toMatchObject({
    turns: 4, ok: 4, open: 0, unclosed: 0, outcomes: { delivered: 2, silent: 2 },
  });
  expect(r.counts.spawnRefused).toBe(1);
  expect(render(r)).toMatch(/spawns refused a credential 1/);
});

test('a first start is not a restart, a failed lease is not a turn, and a lost reply is not an adapter error', () => {
  const log = [
    L('00:00:00.000', 'polling https://api.commonly.me for events (ctrl+c to stop)'),
    L('01:00:00.000', '[inbox.batch] spawning codex'),
    L('01:00:00.200', 'spawn credential lease failed (socket hang up) — not spawning'),
    L('01:00:00.300', 'inbox batch processing failed (runtime; 1 consecutive) — 1 events remain unacked: socket hang up'),
    L('02:00:00.000', '[chat.mention] spawning codex'),
    L('02:00:30.000', '[chat.mention] ERROR reply NOT delivered to pod p1 — 120 bytes lost, 1 event left unacked for retry: HTTP 502'),
    L('02:00:30.100', 'chat.mention processing failed (runtime; 1 consecutive): HTTP 502'),
    L('03:00:00.000', 'polling https://api.commonly.me for events (ctrl+c to stop)'),
  ].join('\n');
  const inWindow = baseline(log, { seat: 'nib', untilMs: Date.parse('2026-10-24T04:00:00Z'), hours: 8 });
  expect(inWindow.counts).toMatchObject({ restarts: 1, leaseFailed: 1, spawnRefused: 0 });
  // The model answered, so the spawn did not fail; the turn is still not ok.
  expect(inWindow.byAdapter.codex).toMatchObject({ turns: 1, ok: 0, failed: 0, errors: 0, outcomes: { reply_lost: 1 } });
  // The start before the window still makes the 03:00 line a restart.
  const late = baseline(log, { seat: 'nib', untilMs: Date.parse('2026-10-24T04:00:00Z'), hours: 1.5 });
  expect(late.counts.restarts).toBe(1);
});

test('a turn is ok only when it was delivered or silent: a lost claim, a skip, a refusal and a refused route are not', () => {
  const log = [
    L('01:00:00.000', '[chat.mention] spawning codex'),
    L('01:00:05.000', '[chat.mention] claim on message 42 lost mid-turn to peer — standing down at post time'),
    L('01:00:10.000', '[chat.mention] stood down — claim lost mid-turn to peer; reply suppressed (120 bytes not posted)'),
    L('02:00:00.000', '[chat.mention] spawning codex'),
    L('02:00:10.000', '[chat.mention] upstream refused 429 — nothing posted this turn'),
    L('03:00:00.000', '[agent.ask] spawning codex'),
    L('03:00:10.000', '[agent.ask] upstream refused 403: route closed — no private response'),
    L('04:00:00.000', '[chat.mention] spawning codex'),
    L('04:00:10.000', '[chat.mention] server skipped the post: duplicate (10 min window) — nothing reached the pod'),
    L('05:00:00.000', '[chat.mention] spawning codex'),
    L('05:00:10.000', '[chat.mention] wrapper delivery refused after 0/1 message (run_cap): stop'),
    L('06:00:00.000', '[chat.mention] spawning codex'),
    L('06:00:10.000', '[chat.mention] posted 120 bytes as 1 message (single)'),
  ].join('\n');
  const r = baseline(log, { seat: 'nib', untilMs: Date.parse('2026-10-24T07:00:00Z'), hours: 8 });
  expect(r.byAdapter.codex).toMatchObject({
    turns: 6,
    ok: 1,
    failed: 0,
    outcomes: { claim_lost: 1, upstream_refused: 2, server_skipped: 1, server_refused: 1, delivered: 1 },
  });
});

test('the window bounds which turns count', () => {
  const r = baseline(LOG, { seat: 'nib', untilMs: Date.parse('2026-10-24T02:30:00Z'), hours: 2 });
  expect(r.byAdapter.codex.turns).toBe(2);
  expect(r.byAdapter.codex.ok).toBe(1);
  // the 02:00 turn closes past the window end, as a failure, and still counts
  expect(r.byAdapter.codex.timeouts).toBe(1);
});

test('a turn on the seat token, and one whose revoke failed, still close as ok', () => {
  const log = [
    L('01:00:00.000', '[inbox.batch] spawning codex'),
    L('01:00:00.200', 'spawn credential unavailable (HTTP 503) — spawning with the seat token'),
    L('01:00:20.000', '[inbox.batch] agent posted via tool this turn — not echoing CLI output'),
    L('02:00:00.000', '[inbox.batch] spawning codex'),
    L('02:00:40.000', 'spawn credential revoke failed (6adbd35b8522fc8abce9b7b8, 503) — the boot sweep will collect it'),
    L('02:00:40.500', '[inbox.batch] no wrapper-post (NO_REPLY)'),
  ].join('\n');
  const r = baseline(log, { seat: 'nib', untilMs: Date.parse('2026-10-24T03:00:00Z'), hours: 4 });
  expect(r.byAdapter.codex).toMatchObject({ turns: 2, ok: 2, open: 0, outcomes: { delivered: 1, silent: 1 } });
  expect(r.byAdapter.codex.durationMs.max).toBe(40_000);
});

test('a malformed option is a usage error, not a stack trace or a NaN report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-log-baseline-'));
  try {
    const log = join(dir, 'nib.log');
    writeFileSync(log, LOG);
    const run = (...args) => {
      const out = [];
      const err = [];
      const status = main(['nib', ...args], { stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) } });
      return { status, out: out.join(''), err: err.join('') };
    };
    for (const [args, message] of [
      [['--log'], '--log needs a value'],
      [['--log', '--json'], '--log needs a value'],
      [['--log', log, '--hours'], '--hours must be a positive number'],
      [['--log', log, '--hours', 'abc'], '--hours must be a positive number'],
      [['--log', log, '--timeout-ms', 'x'], '--timeout-ms must be a positive number'],
      [['--log', log, '--until'], '--until needs a value'],
      [['--log', log, '--until', 'yesterday'], '--until is not an ISO date'],
      [['--log', log, '--until', 'Oct 24 2026'], '--until is not an ISO date'],
      [['--log', log, '--until', '2026-02-31T00:00:00Z'], '--until is not an ISO date'],
      // No zone: Date.parse would read it as host-local time.
      [['--log', log, '--until', '2026-10-24T07:00:00'], '--until is not an ISO date'],
      [['--log', log, '--hours', '1000000000000'], '--hours puts the window start outside the supported date range'],
    ]) {
      expect(run(...args)).toEqual({ status: 2, out: '', err: `${message}\n` });
    }
    const ok = run('--log', log, '--until', '2026-10-24T07:00:00Z', '--hours', '48', '--json');
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.out).byAdapter.codex.turns).toBe(4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run as a script, it reads the log it is given and prints no free text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-log-baseline-'));
  try {
    const log = join(dir, 'nib.log');
    writeFileSync(log, LOG);
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'seat-log-baseline.mjs');
    const args = ['nib', '--log', log, '--until', '2026-10-24T07:00:00Z', '--hours', '48'];
    const json = spawnSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8' });
    expect({ status: json.status, stderr: json.stderr }).toEqual({ status: 0, stderr: '' });
    const r = JSON.parse(json.stdout);
    expect(r.seat).toBe('nib');
    expect(r.byAdapter.codex).toMatchObject({ turns: 4, ok: 1, failed: 2 });
    expect(r.counts).toMatchObject({ untimestamped: 1, otherSeatLines: 1 });
    const text = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    expect(text.status).toBe(0);
    expect(text.stdout).toMatch(/codex: 4 turns, 1 ok \(delivered or silent\), 2 spawns failed/);
    expect(`${json.stdout}${text.stdout}`).not.toMatch(/SECRET/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
