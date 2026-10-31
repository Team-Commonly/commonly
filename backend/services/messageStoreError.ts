/**
 * PostgreSQL is the only message store once configured (TASK-503). Any failed
 * read or write on it surfaces as this retryable error, never the driver's own
 * message: that text can carry the database host and port, and agent tool
 * results put an error's message straight into a model's context.
 */
export type MessageStoreUnavailable = Error & { code: 'MESSAGE_STORE_UNAVAILABLE'; statusCode: 503 };

export function messageStoreUnavailable(op: string, cause: unknown): MessageStoreUnavailable {
  console.error(`[message-store] PostgreSQL message ${op} failed:`, (cause as Error)?.message);
  return Object.assign(
    new Error('Messages are temporarily unavailable. Please try again shortly.'),
    { code: 'MESSAGE_STORE_UNAVAILABLE' as const, statusCode: 503 as const, cause },
  );
}
