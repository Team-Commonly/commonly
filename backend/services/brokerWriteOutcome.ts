// How a tool write ended when no answer came back. A request that hit its own
// deadline after it went out may still have landed, so it is neither a success
// nor a failure the owner can safely approve again. A request the provider
// answered, and one that never left, stay ordinary failures.
//
// The code also lands on an approved call whose outcome nobody recorded: no
// ending on the row and no trail row.
export const APPROVAL_OUTCOME_UNKNOWN = 'approval_outcome_unknown';

const WRITE_UNKNOWN = Symbol.for('commonly.broker.writeUnknown');
const DEADLINE_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED']);
const DEADLINE_NAMES = new Set(['AbortError', 'TimeoutError', 'CanceledError']);

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

export const isRequestDeadline = (error: unknown): boolean => {
  const { code, name } = (error || {}) as { code?: unknown; name?: unknown };
  return DEADLINE_CODES.has(String(code)) || DEADLINE_NAMES.has(String(name));
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
    if (isRequestDeadline(error)) markWriteUnknown(error);
    throw error;
  }
};
