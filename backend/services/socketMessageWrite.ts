/**
 * The socket `sendMessage` store write when PostgreSQL is configured
 * (TASK-503). PostgreSQL is the only message store then: a failed write is a
 * failed send the client can retry, never a MongoDB row that pod chat (which
 * reads PG) cannot show.
 *
 * Before this, server.ts wrote MongoDB whenever PG had not finished booting
 * (every rollout until onMounted) and whenever the PG insert threw. Neither
 * row carried `pgFallback`, so the reconciler never moved them into PG.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PGMessage = require('../models/pg/Message');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PGPod = require('../models/pg/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { syncPodFromMongo } = require('./pgPodSyncService');

export const MESSAGE_STORE_UNAVAILABLE = {
  message: 'Messages are temporarily unavailable. Please try again shortly.',
  code: 'MESSAGE_STORE_UNAVAILABLE',
} as const;

// A refused send goes to the sender on its own event, not the generic socket
// `error`: the client treats `error` as a broken connection and stops sending
// until a reload. The payload names the send so the client can drop its
// optimistic copy and tell the person.
export const MESSAGE_SEND_FAILED_EVENT = 'messageSendFailed';

export interface MessageSendFailure {
  podId: string;
  content: string;
  messageType: string;
  message: string;
  code: string;
}

export interface SocketMessageWriteInput {
  pgReady: boolean;
  podId: string;
  userId: string;
  content: string;
  messageType: string;
  replyToMessageId?: string | null;
}

export type SocketMessageWriteResult =
  | { ok: true; message: Record<string, unknown> }
  | { ok: false; error: MessageSendFailure };

export async function writeSocketMessage({
  pgReady, podId, userId, content, messageType, replyToMessageId = null,
}: SocketMessageWriteInput): Promise<SocketMessageWriteResult> {
  const failed = (): SocketMessageWriteResult => ({
    ok: false,
    error: { ...MESSAGE_STORE_UNAVAILABLE, podId, content, messageType },
  });
  if (!pgReady) return failed();

  let created: Record<string, unknown>;
  try {
    // Best-effort heal for a pod that exists only in MongoDB, as the HTTP
    // and agent paths do; without it the insert FK-fails.
    try {
      if (!await PGPod.findById(podId)) await syncPodFromMongo(podId, userId);
    } catch (syncErr) {
      console.warn('[socket] PG pod backfill skipped:', (syncErr as Error).message);
    }
    created = await PGMessage.create(podId, userId, content, messageType, replyToMessageId);
  } catch (writeErr) {
    console.error('[socket] PG message write failed:', (writeErr as Error).message);
    return failed();
  }

  // The joined re-read only adds author fields. Its failure must not fail
  // (or duplicate) a message that is already stored.
  let joined: Record<string, unknown> | null = null;
  try {
    joined = await PGMessage.findById(created.id);
  } catch (readErr) {
    console.warn('[socket] PG post-write read failed:', (readErr as Error).message);
  }
  return { ok: true, message: joined || created };
}

export default { writeSocketMessage, MESSAGE_STORE_UNAVAILABLE, MESSAGE_SEND_FAILED_EVENT };
