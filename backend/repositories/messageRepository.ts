/**
 * Pod message reads (TASK-503). PostgreSQL is the message store; MongoDB holds
 * only legacy rows and the `pgFallback` rows written while PG was down.
 *
 * Every read that pages a pod's messages goes through `listPodMessages`, so the
 * Mongo fallback lives here and nowhere else. Removing it once the 30-day
 * trigger check clears is a change to this file only; a PG failure then
 * surfaces as an error instead of a silent read from the other store.
 *
 * Callers get one row shape whichever store answered: the shape of
 * `models/pg/Message` `findByPodId`, oldest first.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PGMessage = require('../models/pg/Message');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MongoMessage = require('../models/Message');

export type PodMessageAuthor = { _id: string; username: string; profilePicture?: string; isBot?: boolean };

export interface PodMessage {
  id: string;
  _id: string;
  /**
   * The PG row id. Reactions are keyed by it. A MongoDB row carries its
   * reconciled PG id, or '' if it was never copied to PG.
   */
  pgId: string;
  pod_id: string;
  user_id: string;
  content: string;
  text: string;
  message_type: string;
  messageType: string;
  author_kind: 'kernel' | null;
  payload?: unknown;
  created_at: unknown;
  createdAt: unknown;
  updated_at?: unknown;
  username?: string;
  profile_picture?: string;
  is_bot?: boolean;
  userId: PodMessageAuthor | string;
  replyTo: { id: string; content: string; username: string; userId: string } | null;
  [key: string]: unknown;
}

export interface ListPodMessagesOptions {
  limit?: number;
  /** ISO timestamp; only messages created strictly before it. */
  before?: string | null;
}

/** Same clamp as the PG read, so the fallback can never page more rows. */
const clampLimit = (limit: unknown): number => Math.min(200, Math.max(1, Number.parseInt(String(limit), 10) || 50));

type MongoAuthor = { _id?: { toString(): string }; username?: string; profilePicture?: string; isBot?: boolean };

/** A MongoDB message document in the PG read's row shape. */
export const toPodMessage = (doc: Record<string, unknown>): PodMessage => {
  const raw = doc.userId as MongoAuthor | { toString(): string } | null | undefined;
  const populated = raw && typeof raw === 'object' && '_id' in raw && (raw as MongoAuthor)._id
    ? raw as MongoAuthor
    : null;
  const userIdString = populated ? String(populated._id) : (raw ? String(raw) : '');
  const id = String(doc._id);
  const content = String(doc.content ?? '');
  const messageType = String(doc.messageType || 'text');
  return {
    id,
    _id: id,
    pgId: doc.reconciledPgId != null ? String(doc.reconciledPgId) : '',
    pod_id: String(doc.podId ?? ''),
    user_id: userIdString,
    content,
    text: content,
    message_type: messageType,
    messageType,
    author_kind: doc.authorKind === 'kernel' || doc.author_kind === 'kernel' ? 'kernel' : null,
    ...(doc.payload != null ? { payload: doc.payload } : {}),
    created_at: doc.createdAt,
    createdAt: doc.createdAt,
    updated_at: doc.updatedAt,
    ...(populated ? {
      username: populated.username,
      profile_picture: populated.profilePicture,
      ...(typeof populated.isBot === 'boolean' ? { is_bot: populated.isBot } : {}),
    } : {}),
    userId: populated?.username
      ? {
        _id: userIdString,
        username: populated.username,
        profilePicture: populated.profilePicture,
        isBot: populated.isBot === true,
      }
      : userIdString,
    replyTo: null,
  };
};

/** The pod's newest `limit` messages before `before`, oldest first. */
export async function listPodMessages(
  podId: string,
  { limit = 50, before = null }: ListPodMessagesOptions = {},
): Promise<PodMessage[]> {
  const safeLimit = clampLimit(limit);
  try {
    return await PGMessage.findByPodId(podId, safeLimit, before || null) as PodMessage[];
  } catch (pgError) {
    console.warn('[messages] PG read failed, falling back to MongoDB:', (pgError as Error).message);
  }
  const query: Record<string, unknown> = { podId };
  if (before) query.createdAt = { $lt: new Date(before) };
  const docs = await MongoMessage.find(query)
    .populate('userId', 'username profilePicture isBot')
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .lean() as Array<Record<string, unknown>>;
  return docs.slice().reverse().map(toPodMessage);
}
