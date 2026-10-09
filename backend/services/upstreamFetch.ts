/**
 * The deadline every outbound vendor call on the hosted-MCP path carries.
 *
 * Without one, a vendor that accepts a connection and then stops answering
 * leaves `fetch` waiting on the socket's own timeout — minutes — while the
 * caller is either a browser sitting on the callback or a seat's tool call that
 * has already been handed a tool it cannot use. A bounded failure is worth more
 * than a long wait: every one of these call sites already maps a transport
 * failure onto a named state, so the deadline needs no new error surface.
 *
 * `timeoutMs` is a parameter so the mechanism is measurable without waiting out
 * the shipped deadline; every caller takes the default.
 */
export const UPSTREAM_TIMEOUT_MS = 15 * 1000;

/**
 * `AbortSignal.timeout` rejects with `TimeoutError`, which is how a call site
 * tells a deadline apart from a vendor that refused to connect.
 */
export const isTimeoutError = (error: unknown): boolean => (
  typeof error === 'object' && error !== null && (error as Error).name === 'TimeoutError'
);

/**
 * A bounded fetch.
 *
 * A caller's own signal is COMPOSED with the deadline rather than replaced: the
 * two are independent reasons to stop, and `{ ...init, signal: deadline }` reads
 * as though `init` were honoured while silently dropping the one field in it that
 * cancels (Vera, on #2006). No caller passes one today — all three call sites take
 * the default — so this is the difference between a wrapper that is bounded and a
 * wrapper that is bounded *and* cancellable, and the composition costs nothing.
 */
export const upstreamFetch = (
  input: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<Response> => {
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetchImpl(input, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
};
