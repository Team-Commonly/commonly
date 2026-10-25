/**
 * Honour the seats supervisor's cancel in an adapter's child process.
 *
 * Under COMMONLY_SUPERVISE_RUNS=1 the supervisor passes `ctx.signal` and aborts
 * it when a turn is stuck or past its wall-clock backstop. Without this the
 * adapters ignored the abort, so every supervisor cancel waited out the grace
 * window and ended in the supervisor's SIGKILL of the direct child, skipping
 * the CLI's own shutdown (which is what closes its MCP servers). An abort now
 * sends the child the same SIGTERM the adapter's own timeout sends. The SIGKILL
 * for a child that ignores it stays the supervisor's (cancelGraceMs).
 *
 * On the plain path no signal is passed and this is a no-op.
 * Returns a function that detaches the listener; call it when the child settles.
 */
const NOOP = () => {};

export const honourAbort = (proc, signal) => {
  if (!signal || typeof signal.addEventListener !== 'function') return NOOP;
  const onAbort = () => {
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  };
  if (signal.aborted) {
    onAbort();
    return NOOP;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
};
