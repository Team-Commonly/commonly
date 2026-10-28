/**
 * Process exit codes for a standalone run: one per outcome and one per
 * failure kind, so a script can branch on `$?` without parsing stderr.
 *
 * A code is a contract, like the kind it names. Never renumber one; a new
 * FAILURE_KINDS key takes the next unused code below 126, and the test in
 * test/exit-codes.test.js fails until it has one. 126 and 127 are the
 * shell's own (not executable, not found), and 128+n means "killed by signal
 * n", so `cancelled` takes 130, the code a shell reports for Ctrl-C.
 */
import { FAILURE_KINDS, failureKindOf } from './failures.js';

export const EXIT_OK = 0;
/** The run failed, and nothing named the failure (an adapter threw a bare Error). */
export const EXIT_FAILED = 1;
/** The command line itself was wrong; no run was started. */
export const EXIT_USAGE = 2;

export const FAILURE_EXIT_CODES = Object.freeze({
  stuck: 10,
  timeout: 11,
  exited: 12,
  protocol: 13,
  refusal: 14,
  refusal_dropped: 15,
  refusal_retry_loop: 16,
  provider_unavailable: 17,
  max_tokens: 18,
  max_turn_requests: 19,
  credential_denied: 20,
  unsupported: 21,
  not_installed: 22,
  not_authenticated: 23,
  quota: 24,
  provider_unsupported: 25,
  capacity: 26,
  cancelled: 130,
});

export const UNNAMED_FAILURE = Object.freeze({
  name: 'failed',
  meaning: 'the run failed and its adapter named no failure kind',
});

/** The exit code for a failure kind, or EXIT_FAILED for none or an unknown one. */
export const exitCodeForKind = (kind) => (kind && Object.hasOwn(FAILURE_EXIT_CODES, kind)
  ? FAILURE_EXIT_CODES[kind] : EXIT_FAILED);

/**
 * The exit code for a settled run: superviseRun's result, or anything with
 * `outcome` and a `failure` that is a RunFailure or a recorded {kind}.
 */
export const exitCodeOf = ({ outcome, failure } = {}) => {
  if (outcome === 'ok') return EXIT_OK;
  return exitCodeForKind(failureKindOf(failure) ?? failure?.kind ?? null);
};

/** The last stderr line of a failed run: `jellymoon: <kind>: <meaning>`. */
export const failureLine = (kind, { prog = 'jellymoon' } = {}) => {
  const named = kind && Object.hasOwn(FAILURE_KINDS, kind);
  return named
    ? `${prog}: ${kind}: ${FAILURE_KINDS[kind].meaning}`
    : `${prog}: ${UNNAMED_FAILURE.name}: ${UNNAMED_FAILURE.meaning}`;
};

/** Every code with its name and meaning, in code order: the documented table. */
export const exitCodeTable = () => [
  { code: EXIT_OK, name: 'ok', meaning: 'the turn finished and its reply is on stdout' },
  { code: EXIT_FAILED, name: UNNAMED_FAILURE.name, meaning: UNNAMED_FAILURE.meaning },
  { code: EXIT_USAGE, name: 'usage', meaning: 'the command line was wrong; no run was started' },
  ...Object.entries(FAILURE_EXIT_CODES).map(([name, code]) => ({
    code, name, meaning: FAILURE_KINDS[name]?.meaning ?? '',
  })),
].sort((a, b) => a.code - b.code);
