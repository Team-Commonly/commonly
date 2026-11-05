// How a tool write ended when no answer came back. A request that went out and
// got no answer may still have landed, so it is neither a success nor a failure
// the owner can safely approve again.
//
// The line sits at what the provider told us. No response at all means unknown:
// a deadline, a reset, a dropped socket. A 502 or 504 is unknown too, because a
// gateway answered and the write behind it may have landed. So is a hosted reply
// that broke or wasn't JSON once its session was open. Anything else from
// the provider is its answer, so a 500, a 503 and a 4xx stay ordinary failures,
// as does an error that shows the request never left.
//
// The code also lands on an approved call whose outcome nobody recorded: no
// ending on the row and no trail row.
export const APPROVAL_OUTCOME_UNKNOWN = 'approval_outcome_unknown';

const WRITE_UNKNOWN = Symbol.for('commonly.broker.writeUnknown');
const DEADLINE_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED']);
const DEADLINE_NAMES = new Set(['AbortError', 'TimeoutError', 'CanceledError']);
export const GATEWAY_STATUSES = new Set([502, 504]);
// Failed before any request bytes could reach the provider.
const NEVER_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH']);
const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|EPROTO$|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_)/;

// A mark, not a wrapper: the error keeps the shape the callers already read.
export const markWriteUnknown = <T>(error: T): T => {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, WRITE_UNKNOWN, { value: true });
  }
  return error;
};

export const isWriteUnknown = (error: unknown): boolean => (
  Boolean(error) && typeof error === 'object'
  && (error as Record<symbol, unknown>)[WRITE_UNKNOWN] === true
);

const sentWithoutAnswer = (error: unknown): boolean => {
  const { code, name, request, response } = (error || {}) as {
    code?: unknown; name?: unknown; request?: unknown; response?: { status?: unknown };
  };
  if (response) return GATEWAY_STATUSES.has(Number(response.status));
  if (DEADLINE_CODES.has(String(code)) || DEADLINE_NAMES.has(String(name))) return true;
  return Boolean(request) && !NEVER_SENT_CODES.has(String(code)) && !TLS_CODE.test(String(code));
};

/**
 * Run a step that has written, or is writing, at the provider. Only the write
 * belongs inside: minting a token first sends nothing, so it stays outside
 * until an earlier write has already gone out.
 */
export const sendWrite = async <T>(send: () => Promise<T>): Promise<T> => {
  try {
    return await send();
  } catch (error) {
    if (sentWithoutAnswer(error)) markWriteUnknown(error);
    throw error;
  }
};
