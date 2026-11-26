/**
 * Log a failed outbound call without its request.
 *
 * An AxiosError carries `config` (request headers, so `Authorization: Bot ...`
 * and API keys, plus the URL with any key in its query string, plus a request
 * body that can hold an `api_key`), `request` and `response` (which can echo the
 * body or headers). `console.error(label, err)` prints all of it into the logs.
 * This reads only message, status, code and name, and nothing else ever leaves
 * the error object.
 *
 * `extra` is for a caller that knows a provider's response body carries no
 * credential and wants it kept; it is passed through untouched, so the caller
 * names the exact field (`err?.response?.data`), never the whole error.
 */
export interface ErrorSummary {
  message: string;
  status?: number;
  code?: string;
  name?: string;
  stack?: string;
}

export const describeError = (err: unknown): ErrorSummary => {
  try {
    const e = (err ?? {}) as {
      message?: unknown;
      name?: unknown;
      stack?: unknown;
      code?: unknown;
      response?: { status?: unknown };
    };
    let message = 'unknown error';
    if (typeof err === 'string') message = err;
    else if (typeof e.message === 'string') message = e.message;
    const summary: ErrorSummary = { message };
    if (typeof e.response?.status === 'number') summary.status = e.response.status;
    if (typeof e.code === 'string' || typeof e.code === 'number') summary.code = String(e.code);
    if (typeof e.name === 'string') summary.name = e.name;
    // `name: message` plus frame paths: the same exposure as message, and the
    // stack never includes the request config or headers.
    if (typeof e.stack === 'string') summary.stack = e.stack;
    return summary;
  } catch {
    // A hostile getter on the error must not turn a log line into a throw.
    return { message: 'unknown error' };
  }
};

export const logOutboundFailure = (label: string, err: unknown, ...extra: unknown[]): void => {
  console.error('%s', label, describeError(err), ...extra);
};

export const warnOutboundFailure = (label: string, err: unknown, ...extra: unknown[]): void => {
  console.warn('%s', label, describeError(err), ...extra);
};

/**
 * SMTP2GO's failure reason, and nothing else of its response. The request body
 * carries `api_key`, and a provider response can echo it, so the whole
 * `response.data` is never logged. Returns undefined when the error has no
 * response (a network error), so a caller passes the extra argument only when
 * there is something to show.
 */
export const smtp2goReason = (err: unknown): { error_code?: unknown; error?: unknown } | undefined => {
  try {
    const e = err as { response?: { data?: { data?: { error_code?: unknown; error?: unknown } } } } | null;
    if (!e?.response) return undefined;
    const error_code = e.response.data?.data?.error_code;
    const error = e.response.data?.data?.error;
    // An HTML 502 has neither: undefined lets a caller fall back to the message.
    if (error_code === undefined && error === undefined) return undefined;
    return { error_code, error };
  } catch {
    return undefined;
  }
};

/**
 * The text of an error we threw on purpose, or a fixed fallback for anything
 * else. A route that answers 500 from a catch-all must never echo a driver or
 * a remote message (hosts, SQL, constraint names, a provider response text),
 * but a few of its own throws are written for the person to read. Those are
 * named exactly, or by a prefix for the few that embed a value we validated
 * (`Unknown query type: <type>`). Anything else gets the fallback.
 */
export const ownErrorMessage = (
  err: unknown,
  ownMessages: readonly string[],
  fallback: string,
  ownPrefixes: readonly string[] = [],
): string => {
  const message = describeError(err).message;
  const own = ownMessages.includes(message) || ownPrefixes.some((prefix) => message.startsWith(prefix));
  return own ? message : fallback;
};
