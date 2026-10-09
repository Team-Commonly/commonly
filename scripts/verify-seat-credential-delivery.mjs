#!/usr/bin/env node
/**
 * verify-seat-credential-delivery.mjs — check whether the runtime token is
 * actually withheld from a seat's spawned child.
 *
 * This is the acceptance instrument for the credential-delivery change (#1801):
 * the daemon hands the runtime token to an adapter through a declared channel
 * (a file or a pipe) instead of exporting `COMMONLY_AGENT_TOKEN` into the
 * child's environment. Proving that at the process tree means reading a live
 * child's environment — and that read can silently return nothing.
 *
 * Measured 2026-09-20 with a positive control on the same command: the read is
 * **per process**. The codex adapter child read 8606 bytes with `PATH=` present
 * and its MCP child 2166 bytes, while `/bin/sleep`, `/bin/bash -c`,
 * `/usr/bin/tail`, the `npm exec` shim and the live pi adapter child returned
 * argv only (75-96 bytes, no `PATH=`) — and `sudo` changed none of it. A check
 * that reads `token not found ⇒ withheld` therefore reports the desired answer
 * from an instrument that saw nothing, and blind and withheld are identical in
 * its own output.
 *
 * So every read is positive-controlled: a verdict of `withheld` requires the
 * control variable (`PATH` by default) in the same output, and an empty read is
 * reported as `UNREADABLE` — which is a statement about the instrument, not
 * about the credential. See scripts/lib/credential-env-read.js for the rule and
 * its unit test.
 *
 * Usage:
 *   node scripts/verify-seat-credential-delivery.mjs                 # route 1: seats spawned after this cli install
 *   node scripts/verify-seat-credential-delivery.mjs --all           # route 1: every seat supervisor
 *   node scripts/verify-seat-credential-delivery.mjs --seat otto     # route 1: one seat
 *   node scripts/verify-seat-credential-delivery.mjs --seat otto --self-report   # route 2, labelled with the seat you ran it in
 *
 * Route 2 prints pid, ppid and the parent argv chain, because a self-report is
 * evidence about *some* process and `--seat` is a label the reporter never
 * verifies (wren 70593): the chain is what lets a reader see that the probe sat
 * under the adapter child rather than under the supervisor, and the label is then
 * checked against the chain instead of asserted.
 *   node scripts/verify-seat-credential-delivery.mjs --self-test     # classifier fixtures, no process tree
 *
 * `--self-report` is route 2 (wren 70567/70575): run it from inside the seat's own
 * sandbox and it reports that process's own environment. It is the route that works
 * where route 1 is blind, and the acceptance record must name which route it used —
 * "route 1" is a read proven live by a control variable, "route 2" is the child
 * reporting itself. Route 2's withheld verdict is not gated on the control, because
 * a process reading itself cannot read nothing.
 *
 * `--self-test` exercises the verdict rule on fixtures so the trap is caught on
 * a machine where nothing is spawned, and exits non-zero if the rule regresses.
 *
 * Exit codes — 2 on a bad invocation.
 * Route 1: 0 when every read produced a verdict, 1 when any read was UNREADABLE
 * (this host cannot answer the question for that process).
 * Route 2: 0 when the token is withheld AND the report is placed (the `--seat` label
 * is the seat argument of an ancestor, i.e. `commonly agent run <seat>`); 1 when this
 * run cannot answer — the label is unverified, matches only as text, or no label was
 * given; 3 when the token is present. A withheld verdict about a process nobody
 * located is a non-answer, not a pass (wren 70600).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyEnvRead, classifySelfReport, describeVerdict, describeSelfReport, isPlaced, selfReportExit,
} = require('./lib/credential-env-read.js');

const KNOWN_FLAGS = new Set(['--all', '--seat', '--cli-pkg', '--self-test', '--self-report']);

function parseArgs(argv) {
  const out = { all: false, seat: null, cliPkg: '/opt/homebrew/lib/node_modules/@commonlyai/cli', selfTest: false, selfReport: false, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!KNOWN_FLAGS.has(flag)) { out.unknown.push(flag); continue; }
    if (flag === '--all') out.all = true;
    else if (flag === '--self-test') out.selfTest = true;
    else if (flag === '--self-report') out.selfReport = true;
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) { out.unknown.push(`${flag} (missing value)`); continue; }
      i += 1;
      if (flag === '--seat') out.seat = value;
      else out.cliPkg = value;
    }
  }
  return out;
}

function ps(args) {
  return execFileSync('ps', args, { encoding: 'utf8' });
}

/** Every `commonly agent run <seat>` supervisor, with its start time. */
function seatSupervisors() {
  const rows = [];
  for (const line of ps(['-ww', '-A', '-o', 'pid,ppid,args']).split('\n').slice(1)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, args] = m;
    const seat = args.match(/commonly agent run (\S+)/);
    if (!seat) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), seat: seat[1], startedAt: startTime(pid) });
  }
  return rows;
}

function startTime(pid) {
  try {
    return Math.round(new Date(ps(['-o', 'lstart=', '-p', String(pid)]).trim()).getTime() / 1000);
  } catch { return 0; }
}

function children(pid) {
  const rows = [];
  for (const line of ps(['-ww', '-A', '-o', 'pid,ppid,args']).split('\n').slice(1)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    if (Number(m[2]) !== pid) continue;
    if (/commonly agent run/.test(m[3]) || m[3].trim().startsWith('/bin/bash')) continue;
    rows.push({ pid: Number(m[1]), args: m[3], startedAt: startTime(m[1]) });
  }
  return rows;
}

function envOf(pid) {
  try { return ps(['eww', '-p', String(pid)]); } catch { return ''; }
}

/**
 * The caller's own ancestry, as argv rather than as a claim: entry 0 is this
 * process. `ps -o ppid=,args=` prints argv without the environment, so this read
 * is unaffected by the per-process env-read behaviour described above.
 */
function ancestryOf(pid, limit = 6) {
  const chain = [];
  let cur = Number(pid);
  for (let i = 0; i < limit && cur > 1; i += 1) {
    let out = '';
    try {
      out = execFileSync('ps', ['-o', 'ppid=,args=', '-p', String(cur)], { encoding: 'utf8' }).trim();
    } catch { break; }
    const m = out.match(/^(\d+)\s+([\s\S]*)$/);
    if (!m) break;
    chain.push({ pid: cur, ppid: Number(m[1]), args: m[2].replace(/\s+/g, ' ').trim() });
    cur = Number(m[1]);
  }
  return chain;
}

function adapterOf(seat) {
  const file = path.join(os.homedir(), '.commonly', 'tokens', `${seat}.json`);
  if (!existsSync(file)) return '?';
  try { return JSON.parse(readFileSync(file, 'utf8')).adapter || '?'; } catch { return '?'; }
}

function selfTest() {
  const cases = [
    { name: 'empty read is unreadable', raw: '  PID TTY TIME CMD\n58178   ??  S   0:02.45 pi', want: 'unreadable' },
    { name: 'live read with no token is withheld', raw: 'PATH=/usr/bin:/bin HOME=/Users/x', want: 'token_withheld' },
    { name: 'token present', raw: 'PATH=/bin COMMONLY_AGENT_TOKEN=cm_agent_x', want: 'token_present' },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = classifyEnvRead(c.raw).verdict;
    const ok = got === c.want;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: want=${c.want} got=${got}`);
  }
  return failed === 0 ? 0 : 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length) {
    console.error(`refusing: unknown flag/argument ${args.unknown.join(', ')}`);
    console.error(`known flags: ${[...KNOWN_FLAGS].join(' ')}`);
    process.exit(2);
  }
  if (args.selfTest) process.exit(selfTest());
  if (args.selfReport) {
    if (args.all) {
      console.error('refusing: --self-report reports THIS process and cannot be combined with --all');
      process.exit(2);
    }
    const seat = args.seat || null;
    const ancestry = ancestryOf(process.pid);
    console.log(describeSelfReport({
      seat: seat || 'this seat',
      adapter: seat ? adapterOf(seat) : '?',
      env: process.env,
      ancestry,
    }));
    // Route 2 only answers when it is placed: a withheld verdict about a process
    // nobody located is the same shape of non-answer as route 1's blind read, so it
    // exits non-zero and says why (wren 70600).
    const code = selfReportExit({ verdict: classifySelfReport(process.env).verdict, placed: isPlaced({ seat, ancestry }) });
    if (code === 1) {
      console.log('  UNPLACED: this report cannot say which seat it came from — re-run with --seat <name> from inside that seat (exit 1).');
    }
    process.exit(code);
  }

  let installTime = 0;
  try { installTime = Math.round(statSync(args.cliPkg).mtimeMs / 1000); } catch { installTime = 0; }
  console.log(`cli package: ${args.cliPkg}${installTime ? ` (mtime ${new Date(installTime * 1000).toISOString()})` : ' (not found — pass --cli-pkg)'}`);

  let unreadable = 0;
  for (const sup of seatSupervisors()) {
    if (args.seat && sup.seat !== args.seat) continue;
    if (!args.all && installTime && sup.startedAt < installTime) continue;
    const kids = children(sup.pid);
    if (!kids.length) {
      console.log(`${sup.seat} (${adapterOf(sup.seat)}) supervisor=${sup.pid}: IDLE — no live child, nothing to read`);
      continue;
    }
    for (const kid of kids) {
      const raw = envOf(kid.pid);
      const line = describeVerdict({
        seat: sup.seat, adapter: adapterOf(sup.seat), pid: kid.pid,
        startedAt: kid.startedAt ? new Date(kid.startedAt * 1000).toISOString() : null, raw,
      });
      if (classifyEnvRead(raw).verdict === 'unreadable') unreadable += 1;
      console.log(line);
    }
  }
  if (unreadable) {
    console.log(`\n${unreadable} read(s) UNREADABLE: the read returned no environment for those processes, so this route cannot answer for them. Not evidence of withholding — use --self-report from inside that seat.`);
    process.exit(1);
  }
  process.exit(0);
}

main();
