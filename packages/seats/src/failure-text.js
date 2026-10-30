/**
 * Reading a failure kind out of the text an agent CLI left behind.
 *
 * An adapter that knows why its run failed throws a RunFailure. Many still
 * throw a bare Error carrying the CLI's own words (`adapterFailure` in
 * upstream-refusal.js), and two callers need to read those words the same
 * way: the run loop's retry classes (cli/src/lib/spawn-retry.js) and the
 * standalone runner (standalone.js), which names the failure for an exit code.
 * The wordings live here once so the two cannot drift.
 */

// Measured 2026-10-16 from a codex seat (gpt-6-astra over the ChatGPT login),
// on a security-gate request carrying SSRF/exfil/ReDoS test cases: "codex turn
// failed: This content was flagged for possible cybersecurity risk. If this
// seems wrong, try rephrasing your request. If you're doing authorized security
// work … apply for Daybreak access …". Classed as `runtime`, it was re-sent on
// backoff 5 times in 52 minutes, every one refused, and the seat handled
// nothing else until the kernel retired the event. Only the refusal wordings
// themselves are matched, so an ordinary failure that mentions a flag is not.
export const CONTENT_REFUSED_RE = /(?:flagged for possible cybersecurity risk|this content was flagged|content[_ ]policy[_ ]violation|cyber[_ ]policy)/i;

// A CLI that is not signed in, or whose provider rejected the credential. The
// run loop's `configuration` class is this pattern plus a missing binary; the
// two halves are split so a standalone run can tell the user which one to fix.
export const NOT_AUTHENTICATED_RE = /(?:login required|not logged in|invalid api key|authentication failed|unauthori[sz]ed|forbidden|\b40[13]\b)/i;

// The binary half of the run loop's `configuration` class. Read as text it is
// loose (an ENOENT for any file matches), which is fine for a retry class and
// too loose to tell a user "install the CLI", so `kindOfAdapterError` does not
// use it; it uses the spawn error's own code instead.
export const MISSING_BINARY_RE = /(?:ENOENT|command not found|not on PATH)/i;

// The adapters' own wall-clock timers: "claude timed out after 900000ms",
// "goose adapter: timed out after 900000ms".
const ADAPTER_TIMEOUT_RE = /\btimed out after \d+ ?ms\b/i;

/** The text an adapter's bare Error carries: its message and the fields the CLI filled. */
export const errorText = (error) => [
  error?.message,
  error?.stderr,
  error?.body?.error,
  error?.body?.message,
]
  .filter(Boolean)
  .map(String)
  .join('\n');

/** True when the error is the OS failing to start the binary itself. */
export const isMissingBinary = (error) => error?.code === 'ENOENT'
  && typeof error?.syscall === 'string' && error.syscall.startsWith('spawn');

/**
 * The failure kind a bare adapter Error names, or null when its text names
 * none. Order matters: a refusal is never read as anything retryable, and an
 * auth wording is read before the provider's status and the timer's.
 */
export const kindOfAdapterError = (error) => {
  if (!error) return null;
  if (isMissingBinary(error)) return 'not_installed';
  const text = errorText(error);
  if (CONTENT_REFUSED_RE.test(text)) return 'refusal';
  if (error.status === 401 || error.status === 403 || NOT_AUTHENTICATED_RE.test(text)) return 'not_authenticated';
  // The status `adapterFailure` read off the provider's reply. Any other 4xx
  // stays unnamed: it is the request that was wrong, and its words carry why.
  if (error.status >= 500 || error.status === 408 || error.status === 429) return 'provider_unavailable';
  if (ADAPTER_TIMEOUT_RE.test(text)) return 'timeout';
  return null;
};
