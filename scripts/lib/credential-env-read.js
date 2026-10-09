/**
 * Reading a process environment for the credential-delivery acceptance — and
 * refusing to call an empty read a withholding.
 *
 * Split out of `scripts/verify-seat-credential-delivery.mjs` so the verdict rules
 * have a witness that needs no process tree: this module imports nothing, so a
 * unit test can call it directly.
 *
 * The defect this exists for (2026-09-20, TASK-083 / #1801 acceptance):
 * the acceptance for the credential-withholding change is "read the spawned
 * adapter child's environment and confirm the runtime token is not in it".
 * `ps eww` does not always return an environment, and it does not say so when it
 * doesn't. Measured on this box with a positive control on the same command, the
 * read is **per process**: the codex adapter child read 8606 bytes with `PATH=`
 * present and its MCP child 2166 bytes, `/opt/homebrew/bin/node` and
 * `/usr/bin/python3` read in full, while `/bin/sleep` (75 bytes), `/bin/bash -c`
 * (70), `/usr/bin/tail` (88), the `npm exec` shim (96) and the live pi adapter
 * child (86) returned argv only — including a `sleep` spawned *by* the readable
 * `python3`, so the spawner is not the discriminator. `sudo` changes none of it.
 * **The cause is not established** — an earlier draft of this note blamed the
 * seatbelt sandbox, which the codex read on the same host contradicts. What
 * matters is that an empty read is indistinguishable from a withheld token in
 * its own output, and the empty read is the one that looks like success.
 *
 * Two routes produce the same three verdict words, and the acceptance record
 * names which one it used (wren 70567/70575):
 *
 * - **route 1 — `classifyEnvRead`**: an outside read of another process, which can
 *   be blind, so a verdict of `token_withheld` requires a control variable in the
 *   same output and an empty read is `unreadable`.
 * - **route 2 — `classifySelfReport`**: the child reporting its own environment.
 *   That read is live by construction (a process reading itself needs no proof),
 *   so `token_withheld` is not gated on the control, which is reported as context.
 *
 * The criterion in both routes is the one written down — *no `cm_agent_` value in
 * any adapter child's environment* — so a `cm_agent_` value under an unexpected
 * variable name is a finding too, not just the declared token variable. The
 * declared credential *file* variable is expected to be present: it names a path,
 * not a secret.
 *
 * The shape is not macOS-specific: any negative assertion (`absent`, `empty`,
 * `unchanged`) over a read that can silently return nothing has this failure mode.
 */

const CONTROL_VAR = 'PATH';
const TOKEN_PREFIX = 'cm_agent_';

/**
 * `ps eww` prints the environment as whitespace-separated `KEY=value` pairs.
 * Values can contain spaces, so a naive "split on whitespace and expect KEY="
 * works for presence checks (which is all this needs) as long as a value is not
 * itself shaped like a variable assignment.
 */
function envEntries(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const out = new Map();
  for (const token of text.split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (!out.has(key)) out.set(key, token.slice(eq + 1));
  }
  return out;
}

/** An object (a process's own `env`) into the same shape as a `ps eww` read. */
function entriesFromObject(env) {
  const out = new Map();
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined || value === null) continue;
    if (!out.has(key)) out.set(key, String(value));
  }
  return out;
}

/** Names of variables whose VALUE carries a credential, whatever they are called. */
function credentialValueVars(entries) {
  const names = [];
  for (const [key, value] of entries) {
    if (typeof value === 'string' && value.startsWith(TOKEN_PREFIX)) names.push(key);
  }
  return names.sort();
}

/**
 * Route 1: classify one `ps eww` read of another process.
 *
 * @param {string} raw output of the process read
 * @param {{tokenVar?: string, fileVar?: string, controlVar?: string}} [opts]
 * @returns {{readable: boolean, controlPresent: boolean, tokenPresent: boolean,
 *   filePresent: boolean, credentialValueVars: string[],
 *   verdict: 'token_present'|'token_withheld'|'unreadable'}}
 */
function classifyEnvRead(raw, opts = {}) {
  const tokenVar = opts.tokenVar || 'COMMONLY_AGENT_TOKEN';
  const fileVar = opts.fileVar || 'COMMONLY_TOKEN_FILE';
  const controlVar = opts.controlVar || CONTROL_VAR;

  const entries = envEntries(raw);
  const controlPresent = entries.has(controlVar);
  const tokenPresent = entries.has(tokenVar);
  const filePresent = entries.has(fileVar);
  const vars = credentialValueVars(entries);

  let verdict;
  if (tokenPresent || vars.length) verdict = 'token_present';
  else if (!controlPresent) verdict = 'unreadable';
  else verdict = 'token_withheld';

  return {
    readable: controlPresent || tokenPresent || vars.length > 0,
    controlPresent,
    tokenPresent,
    filePresent,
    credentialValueVars: vars,
    verdict,
  };
}

/**
 * Route 2: classify the child's own environment (an object or a `KEY=value` string).
 * The read is live by construction, so the control is context, never a gate.
 */
function classifySelfReport(env, opts = {}) {
  const tokenVar = opts.tokenVar || 'COMMONLY_AGENT_TOKEN';
  const fileVar = opts.fileVar || 'COMMONLY_TOKEN_FILE';
  const controlVar = opts.controlVar || CONTROL_VAR;

  const entries = env && typeof env === 'object' ? entriesFromObject(env) : envEntries(env);
  const tokenPresent = entries.has(tokenVar);
  const filePresent = entries.has(fileVar);
  const controlPresent = entries.has(controlVar);
  const vars = credentialValueVars(entries);

  return {
    controlPresent,
    tokenPresent,
    filePresent,
    credentialValueVars: vars,
    totalVars: entries.size,
    verdict: tokenPresent || vars.length ? 'token_present' : 'token_withheld',
  };
}

/** One line per process read from outside, saying what it does and does not prove. */
function describeVerdict({ seat, adapter, pid, startedAt, raw, opts = {} }) {
  const r = classifyEnvRead(raw, opts);
  const who = `${seat}${adapter ? ` (${adapter})` : ''} pid=${pid}${startedAt ? ` started=${startedAt}` : ''}`;
  if (r.verdict === 'token_present') {
    const where = r.credentialValueVars.length ? ` under ${r.credentialValueVars.join(', ')}` : '';
    return `${who}: route 1 — TOKEN PRESENT in the child environment${where} — withholding did not reach this process`;
  }
  if (r.verdict === 'unreadable') {
    return `${who}: route 1 — UNREADABLE (no ${opts.controlVar || CONTROL_VAR} in the same read): an empty environment is a blind read, NOT a withheld token — use route 2 (--self-report) for this seat`;
  }
  return `${who}: route 1 — token withheld (read proven live by ${opts.controlVar || CONTROL_VAR}${r.filePresent ? '; declared file variable present' : '; declared file variable NOT present'})`;
}

/** One line for a seat reporting its own environment (route 2).
 *
 * `ancestry` (from the walker's `ps -o ppid=,args=`) is what makes a route-2 line
 * worth something: the verdict is about *some* process, and `--seat` is a label the
 * reporter never verifies. Printing pid, ppid and the argv chain lets a reader see
 * whether the probe sat under the adapter child or somewhere else entirely
 * (wren 70593). The seat label is then checked against the chain rather than
 * asserted.
 */
function describeSelfReport({ seat, adapter, env, ancestry = [], opts = {} }) {
  const r = classifySelfReport(env, opts);
  const who = `${seat}${adapter ? ` (${adapter})` : ''}`;
  const where = r.credentialValueVars.length ? ` under ${r.credentialValueVars.join(', ')}` : '';
  const context = `${r.totalVars} vars; control ${opts.controlVar || CONTROL_VAR} ${r.controlPresent ? 'present' : 'absent'}; declared file variable ${r.filePresent ? 'present' : 'absent'}`;
  const place = describeAncestry({ seat, ancestry });
  const verdict = r.verdict === 'token_present'
    ? `${who}: route 2 (self-report) — TOKEN PRESENT${where} — withholding did not reach this process (${context})`
    : `${who}: route 2 (self-report) — token withheld, no ${TOKEN_PREFIX}* value in any variable (${context})`;
  return place ? `${verdict}\n${place}` : verdict;
}

/**
 * How strongly an ancestor's argv names this seat.
 *
 * `args.includes(seat)` — the first draft — confirms labels that are wrong: run
 * `--seat commonly`, `--seat run` or `--seat node` and the supervisor's own command
 * line (`…/bin/node …/bin/commonly agent run kai`) matches all three by substring
 * (vera 70596, reproduced). A standalone-token match is better and still not the
 * seat: `pi` matches the pi adapter binary, which is named after the adapter, not
 * after the seat. So the only confirmation is the seat-argument shape the launcher
 * itself uses — `agent run <seat>` — and anything weaker is reported as exactly
 * that instead of as a pass. A name inside a path never matches, because a path is
 * one whitespace-delimited token.
 *
 * @returns {'seat-argument'|'token'|null}
 */
function seatEvidence(args, seat) {
  if (typeof args !== 'string' || !seat) return null;
  const tokens = args.split(/\s+/).filter(Boolean);
  for (let i = 3; i < tokens.length; i += 1) {
    const cli = tokens[i - 3];
    const sequence = tokens[i] === seat && tokens[i - 1] === 'run'
      && tokens[i - 2] === 'agent' && (cli === 'commonly' || cli.endsWith('/commonly'));
    if (!sequence) continue;
    // The same four tokens can sit inside a prompt: a claude seat's ancestor is
    // `claude -p <whole prompt>`, so pod text that quotes the launcher is enough to
    // fake this shape. A prompt-bearing argv is therefore never the launcher
    // (wren 70599), however convincing its tokens look. The trade-off is a false
    // negative for a launcher that itself uses `exec` in its argv — the safe
    // direction, since it delays a pass rather than fabricating one.
    return /(^|\s)(-p|--print|exec)(\s|$)/.test(args) ? 'prompt-lookalike' : 'seat-argument';
  }
  return tokens.includes(seat) ? 'token' : null;
}

/**
 * Where this report came from, as a strength rather than a yes/no.
 * `seat-argument` is the launcher's own invocation and the only confirmation;
 * everything else is reported for what it is.
 */
function placementOf({ seat, ancestry = [] }) {
  if (!ancestry.length) return { strength: 'unknown' };
  const self = ancestry[0];
  const candidates = ancestry.filter((a) => a.pid !== self.pid && !isInvocation(a.args));
  for (const strength of ['seat-argument', 'prompt-lookalike', 'token']) {
    const hit = candidates.find((a) => seatEvidence(a.args, seat) === strength);
    if (hit) return { strength, pid: hit.pid, args: hit.args };
  }
  return { strength: seat ? 'none' : 'unlabelled' };
}

/** True only for the launcher's own invocation: `commonly agent run <seat>`. */
function isPlaced({ seat, ancestry = [] }) {
  return placementOf({ seat, ancestry }).strength === 'seat-argument';
}

/**
 * Route 2's exit code, in one place so the CLI and its test agree.
 * 3 = the credential is present (a finding), 1 = this run cannot answer (the label
 * is unverified, matched only as text, or the report carries no label), 0 = withheld
 * and placed.
 */
function selfReportExit({ verdict, placed }) {
  if (verdict === 'token_present') return 3;
  return placed ? 0 : 1;
}

/**
 * True for the ancestors that merely ran this script. Without it, a labelled run
 * matches its own command line — `--seat kai` sitting in the argv — and the label
 * check confirms itself, which is the vacuous shape the check exists to avoid.
 */
function isInvocation(args) {
  return typeof args === 'string' && args.includes('verify-seat-credential-delivery.mjs');
}

/**
 * Where a route-2 report was made, and whether its label matches that place: the
 * pid/ppid + argv chain, then the label verdict. A weak match says so and says it is
 * not a confirmation, rather than being rendered as one.
 */
function describeAncestry({ seat, ancestry = [] }) {
  if (!ancestry.length) return '';
  const self = ancestry[0];
  const chain = ancestry
    .map((a) => `${a.pid}${a.username ? ` ${a.username}` : ''} ${shorten(a.args)}`)
    .join(' <- ');
  const p = placementOf({ seat, ancestry });
  let label;
  if (!seat) label = 'seat label: none given';
  else if (p.strength === 'seat-argument') label = `seat label "${seat}" is the seat argument of ancestor pid ${p.pid} (${shorten(p.args, 70)})`;
  else if (p.strength === 'prompt-lookalike') label = `seat label "${seat}" appears as \`commonly agent run ${seat}\` inside a PROMPT-BEARING argv (pid ${p.pid}) — that is a prompt quote, not the launcher, so the label is NOT confirmed`;
  else if (p.strength === 'token') label = `seat label "${seat}" appears only as a standalone token in ancestor pid ${p.pid} (${shorten(p.args, 70)}) — not the seat argument, so the label is NOT confirmed`;
  else label = `seat label "${seat}" does NOT appear in any ancestor argv — the label is unverified`;
  return `  pid=${self.pid} ppid=${self.ppid} started under: ${chain}\n  ${label}`;
}

function shorten(text, max = 110) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

module.exports = {
  CONTROL_VAR,
  TOKEN_PREFIX,
  envEntries,
  entriesFromObject,
  credentialValueVars,
  classifyEnvRead,
  classifySelfReport,
  describeVerdict,
  describeSelfReport,
  describeAncestry,
  seatEvidence,
  placementOf,
  isPlaced,
  selfReportExit,
};
