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
 *   node scripts/verify-seat-credential-delivery.mjs                 # seats spawned after this cli install
 *   node scripts/verify-seat-credential-delivery.mjs --all           # every seat supervisor
 *   node scripts/verify-seat-credential-delivery.mjs --seat otto     # one seat
 *   node scripts/verify-seat-credential-delivery.mjs --self-test     # classifier fixtures, no process tree
 *
 * `--self-test` exercises the verdict rule on fixtures so the trap is caught on
 * a machine where nothing is spawned, and exits non-zero if the rule regresses.
 *
 * Exit code: 0 when every read produced a verdict, 1 when any read was
 * UNREADABLE (i.e. this host cannot answer the question for that process), 2 on
 * a bad invocation.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyEnvRead, describeVerdict } = require('./lib/credential-env-read.js');

const KNOWN_FLAGS = new Set(['--all', '--seat', '--cli-pkg', '--self-test']);

function parseArgs(argv) {
  const out = { all: false, seat: null, cliPkg: '/opt/homebrew/lib/node_modules/@commonlyai/cli', selfTest: false, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!KNOWN_FLAGS.has(flag)) { out.unknown.push(flag); continue; }
    if (flag === '--all') out.all = true;
    else if (flag === '--self-test') out.selfTest = true;
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
    console.log(`\n${unreadable} read(s) UNREADABLE: this host cannot answer for those processes (sandboxed environment). Not evidence of withholding.`);
    process.exit(1);
  }
  process.exit(0);
}

main();
