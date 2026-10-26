import { baseline, render } from '../scripts/seat-log-baseline.mjs';

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
    outcomes: { posted_via_tool: 1 },
  });
  expect(r.byAdapter.codex.durationMs).toEqual({ p50: 30_000, p90: 2_700_100, p99: 2_700_100, max: 2_700_100, n: 3 });
  expect(r.byAdapter.claude).toMatchObject({ turns: 1, cutByRestart: 1 });
  expect(r.counts).toMatchObject({ untimestamped: 1, pollErrors: 1, restarts: 1, otherSeatLines: 1 });
  const out = `${render(r)}\n${JSON.stringify(r)}`;
  expect(out).not.toMatch(/SECRET/);
  expect(out).toMatch(/the log cannot tell/);
});

test('the window bounds which turns count', () => {
  const r = baseline(LOG, { seat: 'nib', untilMs: Date.parse('2026-10-24T02:30:00Z'), hours: 2 });
  expect(r.byAdapter.codex.turns).toBe(2);
  expect(r.byAdapter.codex.ok).toBe(1);
  // the 02:00 turn closes past the window end, as a failure, and still counts
  expect(r.byAdapter.codex.timeouts).toBe(1);
});
