/**
 * Reading a process environment out of `ps` output — and refusing to call an
 * empty read a withholding.
 *
 * Split out of `scripts/verify-seat-credential-delivery.mjs` so the verdict rule
 * has a witness that needs no process tree: this module imports nothing, so a
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
 * So: a verdict of ABSENT is only allowed when the same output proves the read
 * was live — a control variable that must be present (`PATH` by default). An
 * empty read is `unreadable`, never `withheld`. A *present* token needs no
 * control: finding the variable is itself proof the read reached the block, and
 * it is the outcome nobody is hoping to see.
 *
 * The shape is not macOS-specific: any negative assertion (`absent`, `empty`,
 * `unchanged`) over a read that can silently return nothing has this failure
 * mode.
 */

const CONTROL_VAR = 'PATH';

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

/**
 * Classify one `ps eww` read.
 *
 * @param {string} raw output of the process read
 * @param {{tokenVar?: string, fileVar?: string, controlVar?: string}} [opts]
 * @returns {{readable: boolean, controlPresent: boolean, tokenPresent: boolean,
 *   filePresent: boolean, verdict: 'token_present'|'token_withheld'|'unreadable'}}
 */
function classifyEnvRead(raw, opts = {}) {
  const tokenVar = opts.tokenVar || 'COMMONLY_AGENT_TOKEN';
  const fileVar = opts.fileVar || 'COMMONLY_TOKEN_FILE';
  const controlVar = opts.controlVar || CONTROL_VAR;

  const entries = envEntries(raw);
  const controlPresent = entries.has(controlVar);
  const tokenPresent = entries.has(tokenVar);
  const filePresent = entries.has(fileVar);

  let verdict;
  if (tokenPresent) verdict = 'token_present';
  else if (!controlPresent) verdict = 'unreadable';
  else verdict = 'token_withheld';

  return {
    readable: controlPresent || tokenPresent,
    controlPresent,
    tokenPresent,
    filePresent,
    verdict,
  };
}

/** One line per process, saying what was measured and what it does not prove. */
function describeVerdict({ seat, adapter, pid, startedAt, raw, opts = {} }) {
  const r = classifyEnvRead(raw, opts);
  const who = `${seat}${adapter ? ` (${adapter})` : ''} pid=${pid}${startedAt ? ` started=${startedAt}` : ''}`;
  if (r.verdict === 'token_present') {
    return `${who}: TOKEN PRESENT in the child environment${r.filePresent ? ' (and the declared file variable is set)' : ''} — withholding did not reach this process`;
  }
  if (r.verdict === 'unreadable') {
    return `${who}: UNREADABLE — no ${opts.controlVar || CONTROL_VAR} in the same read, so an empty environment is the sandbox and NOT a withheld token`;
  }
  return `${who}: token withheld (read proven live by ${opts.controlVar || CONTROL_VAR}${r.filePresent ? '; declared file variable present' : '; declared file variable NOT present'})`;
}

module.exports = {
  CONTROL_VAR,
  envEntries,
  classifyEnvRead,
  describeVerdict,
};
