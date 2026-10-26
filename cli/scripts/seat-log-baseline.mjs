#!/usr/bin/env node
/**
 * Offline baseline of a seat's turns, from its wrapper log
 * (~/.commonly/logs/<seat>.log), for the window before the seats canary
 * switch, to compare against ~/.commonly/state/seats-canary/<seat>.jsonl.
 *
 *   node cli/scripts/seat-log-baseline.mjs <seat> [--until <ISO>] [--hours 48]
 *        [--log <path>] [--timeout-ms 2700000] [--json]
 *
 * Reads only timestamps and the wrapper's own fixed phrases. It never prints a
 * line's free text: a failure line's tail (the CLI's stderr) is reduced to a
 * name (adapter_timeout | adapter_exit <code> | adapter_error), and lines with
 * no timestamp (raw stderr, HTML error pages) are counted, not shown.
 *
 * A turn opens at "[<event>] spawning <adapter>" and closes at the first of:
 *   - "spawn credential revoked"  (the spawn returned; the outcome line follows)
 *   - "processing failed"         (the spawn threw; failed)
 *   - a restart ("stopping after the current turn" / "polling … for events")
 *     or the next "spawning"       (no close seen; counted as unclosed)
 * A turn still open at the end of the window is "open", not a hang.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const LIMITS = [
  'exit codes and signals of turns that succeeded (the log names a code only when a turn failed)',
  'whether a kill fired, and whether a child outlived its turn (the old path logs neither)',
  'quiet gaps inside a turn: the log has no mid-turn liveness, so a stall cannot be told from long work; only the 45-minute timeout shows',
  'in-band provider refusals the CLI swallowed (refusal_dropped): an exit 0 with an empty or refused reply reads as an ordinary turn',
  'turns cut by a restart: the end time is the restart, not the child\'s exit, and the outcome is unknown',
  'whether "posted via tool" posted the right thing, or why a NO_REPLY was chosen',
  'anything before the log was rotated or after it stopped being written',
];

const LINE_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) \[([^\]]+)\] (.*)$/;
const SPAWN_RE = /^\[([A-Za-z0-9._-]{1,40})\] spawning ([a-z0-9-]{1,32})$/;

const outcomeOf = (msg) => {
  if (/no wrapper-post \(NO_REPLY\)/.test(msg)) return 'no_reply';
  if (/no wrapper-post \(empty output\)/.test(msg)) return 'empty_output';
  if (/agent posted via tool/.test(msg) || /posted via tool, then/.test(msg)) return 'posted_via_tool';
  if (/\bposted \d+ bytes\b/.test(msg)) return 'wrapper_posted';
  if (/routed private response/.test(msg)) return 'private_response';
  if (/server skipped the post/.test(msg)) return 'server_skipped';
  if (/wrapper delivery refused/.test(msg)) return 'delivery_refused';
  return null;
};

const failureOf = (msg) => {
  const timeout = /\btimed out after (\d+)ms\b/.exec(msg);
  if (timeout) return { name: 'adapter_timeout', timeoutMs: Number(timeout[1]) };
  const exit = /\bexited with code (-?\d+)\b/.exec(msg);
  if (exit) return { name: 'adapter_exit', exitCode: Number(exit[1]) };
  return { name: 'adapter_error' };
};

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);

export const baseline = (text, { seat, untilMs = Date.now(), hours = 48, timeoutMs = 2_700_000 } = {}) => {
  const fromMs = untilMs - hours * 3_600_000;
  const turns = [];
  let open = null;
  const counts = { untimestamped: 0, pollErrors: 0, restarts: 0, otherSeatLines: 0 };
  const close = (turn, fields) => { Object.assign(turn, fields); turns.push(turn); };

  for (const line of text.split('\n')) {
    if (!line) continue;
    const m = LINE_RE.exec(line);
    if (!m) { counts.untimestamped += 1; continue; }
    const [, ts, who, msg] = m;
    const at = Date.parse(ts);
    if (seat && who !== seat) { counts.otherSeatLines += 1; continue; }
    if (at < fromMs || at > untilMs) {
      // A turn that opened inside the window may close just past it; let it.
      if (!(open && at > untilMs)) continue;
    }
    const spawn = SPAWN_RE.exec(msg);
    if (spawn) {
      if (open) close(open, { endMs: at, ended: 'unclosed' });
      if (at > untilMs) { open = null; break; }
      open = { startMs: at, eventType: spawn[1], adapter: spawn[2] };
      continue;
    }
    if (/^stopping after the current turn/.test(msg) || /^polling \S+ for events/.test(msg)) {
      if (at <= untilMs) counts.restarts += /^polling/.test(msg) ? 1 : 0;
      if (open) { close(open, { endMs: at, ended: 'restart' }); open = null; }
      continue;
    }
    if (/^(fetch failed|poll failed|HTTP \d{3}\b)/.test(msg)) { if (at <= untilMs) counts.pollErrors += 1; continue; }
    if (!open) continue;
    if (/processing failed/.test(msg)) {
      close(open, { endMs: at, ended: 'failed', ...failureOf(msg) });
      open = null;
      continue;
    }
    // The child's end, when the turn minted a credential. A seat-token turn
    // mints none and logs neither line, so its outcome line is its end.
    if (/^spawn credential (revoked|revoke failed)\b/.test(msg)) { open.revokedMs = at; continue; }
    const outcome = outcomeOf(msg);
    if (outcome) {
      close(open, { endMs: open.revokedMs ?? at, ended: 'ok', outcome });
      open = null;
    }
  }
  if (open) {
    if (open.revokedMs !== undefined) close(open, { endMs: open.revokedMs, ended: 'ok', outcome: 'unknown' });
    else close(open, { endMs: null, ended: 'open' });
  }

  const byAdapter = {};
  for (const t of turns) {
    const a = (byAdapter[t.adapter] ||= {
      turns: 0, ok: 0, failed: 0, timeouts: 0, exits: {}, errors: 0, unclosed: 0, cutByRestart: 0, open: 0,
      atOrOverTimeout: 0, outcomes: {}, durations: [],
    });
    a.turns += 1;
    if (t.endMs !== null) t.durationMs = t.endMs - t.startMs;
    if (t.ended === 'ok') { a.ok += 1; a.outcomes[t.outcome] = (a.outcomes[t.outcome] || 0) + 1; }
    if (t.ended === 'failed') {
      a.failed += 1;
      if (t.name === 'adapter_timeout') a.timeouts += 1;
      else if (t.name === 'adapter_exit') a.exits[t.exitCode] = (a.exits[t.exitCode] || 0) + 1;
      else a.errors += 1;
    }
    if (t.ended === 'unclosed') a.unclosed += 1;
    if (t.ended === 'restart') a.cutByRestart += 1;
    if (t.ended === 'open') a.open += 1;
    if (t.durationMs !== undefined) {
      a.durations.push(t.durationMs);
      if (t.durationMs >= timeoutMs) a.atOrOverTimeout += 1;
    }
  }
  for (const a of Object.values(byAdapter)) {
    const d = a.durations.sort((x, y) => x - y);
    a.durationMs = d.length ? { p50: pct(d, 50), p90: pct(d, 90), p99: pct(d, 99), max: d[d.length - 1], n: d.length } : null;
    delete a.durations;
  }
  return {
    seat: seat || null,
    window: { from: new Date(fromMs).toISOString(), until: new Date(untilMs).toISOString(), hours },
    turnTimeoutMs: timeoutMs,
    byAdapter,
    counts,
    cannotTell: LIMITS,
  };
};

const fmtMs = (ms) => (ms === null || ms === undefined ? '-' : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`);

export const render = (r) => {
  const out = [`seat ${r.seat}: ${r.window.from} → ${r.window.until} (${r.window.hours}h), turn budget ${fmtMs(r.turnTimeoutMs)}`];
  const adapters = Object.entries(r.byAdapter);
  if (!adapters.length) out.push('  no turns in the window');
  for (const [name, a] of adapters) {
    out.push(`  ${name}: ${a.turns} turns, ${a.ok} ok, ${a.failed} failed`
      + ` (${a.timeouts} timed out, exits ${JSON.stringify(a.exits)}, ${a.errors} other)`
      + `, ${a.cutByRestart} cut by restart, ${a.unclosed} unclosed, ${a.open} still open at the window end`);
    out.push(`    reached the turn budget: ${a.atOrOverTimeout}`);
    if (a.durationMs) out.push(`    duration p50 ${fmtMs(a.durationMs.p50)} p90 ${fmtMs(a.durationMs.p90)} p99 ${fmtMs(a.durationMs.p99)} max ${fmtMs(a.durationMs.max)} (n=${a.durationMs.n})`);
    out.push(`    outcomes ${JSON.stringify(a.outcomes)}`);
  }
  out.push(`  restarts ${r.counts.restarts}, poll errors ${r.counts.pollErrors}, untimestamped lines (whole log) ${r.counts.untimestamped}`);
  out.push('  the log cannot tell:');
  for (const l of r.cannotTell) out.push(`    - ${l}`);
  return out.join('\n');
};

export const main = (argv, { stdout = process.stdout, stderr = process.stderr } = {}) => {
  const args = [...argv];
  const seat = args.shift();
  if (!seat || seat.startsWith('-')) {
    stderr.write('usage: seat-log-baseline.mjs <seat> [--until <ISO>] [--hours 48] [--log <path>] [--timeout-ms 2700000] [--json]\n');
    return 2;
  }
  // A malformed option is a usage error (status 2), never a stack trace or a
  // report computed from NaN.
  const usage = (message) => { stderr.write(`${message}\n`); return 2; };
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    const value = args[i + 1];
    return value === undefined || value.startsWith('--') ? null : value;
  };
  const num = (name, fallback) => {
    const value = opt(name, fallback);
    const n = value === null ? NaN : Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const until = opt('--until');
  if (until === null) return usage('--until needs a value');
  const untilMs = until === undefined ? Date.now() : Date.parse(until);
  if (Number.isNaN(untilMs)) return usage('--until is not a date');
  const logPath = opt('--log', path.join(os.homedir(), '.commonly', 'logs', `${seat}.log`));
  if (logPath === null) return usage('--log needs a value');
  const hours = num('--hours', 48);
  if (hours === null) return usage('--hours must be a positive number');
  const timeoutMs = num('--timeout-ms', 2_700_000);
  if (timeoutMs === null) return usage('--timeout-ms must be a positive number');
  const result = baseline(fs.readFileSync(logPath, 'utf8'), { seat, untilMs, hours, timeoutMs });
  stdout.write(`${args.includes('--json') ? JSON.stringify(result, null, 2) : render(result)}\n`);
  return 0;
};

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
