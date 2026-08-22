/**
 * Resolve and validate a message's thread root (W-T, TASK-029).
 *
 * @ux-lead's amendment (pod 56879) settles how a message joins a thread. The
 * re-targeted composer does NOT set `reply_to` for an ordinary in-thread post —
 * that would make every threaded reply `isRouted`, ping the root's author, and
 * put the ambient path out of reach from the UI. Instead the client sends
 * `thread_root_id` explicitly.
 *
 * So two shapes coexist and this is the one place that reconciles them:
 *
 *   explicit  — the client names the root. Ordinary in-thread posts.
 *   derived   — COALESCE(parent.thread_root_id, parent.id) from `reply_to`.
 *               Explicit replies, and the backfill over pre-threading history.
 *
 * Precedence: explicit wins when present, derivation fills when absent, and a
 * MISMATCH between the two is a 400 rather than a silent preference. A caller
 * that says "reply to X" and "this belongs to thread Y" where X is not in Y
 * holds a wrong belief about the conversation; picking one and proceeding hides
 * that from them.
 */
/* eslint-disable @typescript-eslint/no-require-imports, global-require */
const { pool } = require('../config/db-pg');

interface PgPool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
}

/** Thrown for anything a caller can fix by sending different input — always a 400. */
export class ThreadRootError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ThreadRootError';
    this.code = code;
  }
}

/**
 * Returns the thread root to store, or null for a message that starts no
 * thread. Throws ThreadRootError for caller-fixable problems.
 *
 * Validation is deliberately about the ROOT, not the poster: whether they may
 * write here is the pod membership question, already answered upstream.
 */
export async function resolveThreadRoot({
  podId,
  replyToMessageId,
  threadRootId,
}: {
  podId: string;
  replyToMessageId?: number | string | null;
  threadRootId?: number | string | null;
}): Promise<number | null> {
  const explicit = threadRootId == null || threadRootId === '' ? null : Number(threadRootId);
  if (explicit !== null && (!Number.isInteger(explicit) || explicit <= 0)) {
    throw new ThreadRootError('thread_root_invalid', 'threadRootId must be a positive integer');
  }

  const parentId = replyToMessageId == null || replyToMessageId === ''
    ? null : Number(replyToMessageId);

  // Derive first when there is a reply edge — needed both as the answer (no
  // explicit root) and as the cross-check (explicit root present).
  let derived: number | null = null;
  if (parentId !== null) {
    const { rows } = await (pool as PgPool).query(
      `SELECT COALESCE(parent.thread_root_id, parent.id)::int AS root
         FROM messages parent WHERE parent.id = $1::int`,
      [parentId],
    );
    derived = rows[0]?.root ?? null;
  }

  if (explicit === null) return derived;

  // The explicit root must be a real message in THIS pod. Cross-pod would let
  // a caller attach a message to a conversation they may not even be able to
  // read, and the wake set is computed from the thread, not from the pod.
  const { rows } = await (pool as PgPool).query(
    'SELECT pod_id, thread_root_id FROM messages WHERE id = $1::int',
    [explicit],
  );
  const root = rows[0];
  if (!root) {
    throw new ThreadRootError('thread_root_not_found', `thread root ${explicit} does not exist`);
  }
  if (String(root.pod_id) !== String(podId)) {
    throw new ThreadRootError('thread_root_wrong_pod', `thread root ${explicit} is in another pod`);
  }
  // No nesting: a root is a message with no root of its own. Allowing a reply
  // to be named as a root would create two ids for one conversation, and every
  // consumer that groups by root would split it.
  if (root.thread_root_id !== null && root.thread_root_id !== undefined) {
    throw new ThreadRootError(
      'thread_root_not_a_root',
      `message ${explicit} is inside a thread, not a root — use ${root.thread_root_id}`,
    );
  }

  // Both shapes present and disagreeing: the caller's two statements about the
  // same message cannot both be true. 400 rather than picking a winner.
  if (derived !== null && derived !== explicit) {
    throw new ThreadRootError(
      'thread_root_mismatch',
      `replyToMessageId ${parentId} belongs to thread ${derived}, not ${explicit}`,
    );
  }

  return explicit;
}

module.exports = { resolveThreadRoot, ThreadRootError };
Object.assign(module.exports, exports);
