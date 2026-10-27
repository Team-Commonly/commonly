// A pod-wide read watermark, recorded only after a successful current-tail read.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Cursor = require('../repositories/agentPodReadCursorRepository');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MongoMessage = require('../models/Message');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pool } = require('../config/db-pg');

type Preview = { id: string; author: string; content: string; createdAt: unknown };
type Hold = { code: 'unseen_messages'; unseenCount: number; messages: Preview[]; message: string } | null;

type ReadStart = { at: Date; revision?: number };

async function readStart(podId: unknown): Promise<ReadStart> {
  const at = new Date(Date.now() - 1);
  if (pool && process.env.PG_HOST) {
    // Read the committed revision BEFORE fetching the tail. An insert still
    // in flight cannot advance this value until its message is visible too.
    const result = await pool.query(
      'SELECT revision FROM pod_message_revisions WHERE pod_id = $1',
      [String(podId)],
    );
    return { at, revision: Number(result.rows[0]?.revision || 0) };
  }
  const mongo = MongoMessage.db?.db;
  if (!mongo) throw new Error('MongoDB unavailable for freshness read');
  const hello = await mongo.admin().command({ hello: 1 });
  if (!(hello.localTime instanceof Date)) throw new Error('MongoDB did not return a freshness clock');
  return { at: hello.localTime };
}

async function recordRead(
  agentUserId: unknown, podId: unknown, start: ReadStart, observedIds: string[],
): Promise<void> {
  if (!Array.isArray(observedIds)) throw new Error('Read acknowledgement needs returned message IDs');
  const previous = await Cursor.getReadWatermark(agentUserId, podId);
  // The first read also needs evidence: a truncated tail cannot acknowledge
  // older history just because no cursor existed yet.
  if (await omittedMessages(
    agentUserId, podId, previous || { readAt: new Date(0), readRevision: -1 }, start, observedIds,
  )) return;
  await advanceCursor(agentUserId, podId, start);
}

async function advanceCursor(agentUserId: unknown, podId: unknown, start: ReadStart): Promise<void> {
  await Cursor.advanceReadWatermark(agentUserId, podId, {
    readAt: start.at,
    ...(start.revision === undefined ? {} : { readRevision: start.revision }),
  });
}

async function omittedMessages(
  agentUserId: unknown,
  podId: unknown,
  previous: { readAt?: Date; readRevision?: number },
  start: ReadStart,
  observedIds: string[],
  count = false,
): Promise<number> {
  const ownId = String(agentUserId);
  if (pool && process.env.PG_HOST) {
    if (start.revision === undefined) throw new Error('PostgreSQL read revision missing');
    const ids = observedIds.filter((id) => /^\d+$/.test(id)).map(Number);
    const result = await pool.query(`
      SELECT ${count ? 'COUNT(*)::integer AS skipped_count' : '1'} FROM messages m
      WHERE m.pod_id = $1 AND m.freshness_revision > $2 AND m.freshness_revision <= $3
        AND (m.user_id IS DISTINCT FROM $4 OR m.author_kind = 'kernel')
        AND NOT (m.message_type = 'system' AND COALESCE(m.payload->>'kind', '') = 'system-action')
        AND NOT (m.id = ANY($5::int[]))
      ${count ? '' : 'LIMIT 1'}
    `, [String(podId), previous.readRevision ?? -1, start.revision, ownId, ids]);
    return count ? Number(result.rows[0]?.skipped_count || 0) : result.rows.length;
  }
  const observed = observedIds.filter((id) => /^[a-f\d]{24}$/i.test(id));
  const query = {
    podId,
    $nor: [{ messageType: 'system', 'payload.kind': 'system-action' }],
    _id: { $nin: observed },
    $and: [
      { $or: [{ userId: { $ne: ownId } }, { authorKind: 'kernel' }] },
      { $or: [
        { freshnessCommittedAt: { $gte: previous.readAt || new Date(0), $lte: start.at } },
        {
          freshnessPending: { $exists: false },
          freshnessCommittedAt: { $exists: false },
          createdAt: { $gt: previous.readAt || new Date(0), $lte: start.at },
        },
      ] },
    ],
  };
  return count ? MongoMessage.countDocuments(query) : Number(Boolean(await MongoMessage.exists(query)));
}

// Only the explicit catch-up endpoint may acknowledge omitted history. Its
// snapshot precedes the tail fetch, so later commits remain send-time holds.
async function recordCatchUp(
  agentUserId: unknown, podId: unknown, start: ReadStart, observedIds: string[],
): Promise<{ skippedCount: number }> {
  const previous = await Cursor.getReadWatermark(agentUserId, podId);
  const skippedCount = await omittedMessages(
    agentUserId, podId, previous || { readAt: new Date(0), readRevision: -1 }, start, observedIds, true,
  );
  await advanceCursor(agentUserId, podId, start);
  return { skippedCount };
}

async function unseenMessages(agentUserId: unknown, podId: unknown): Promise<Hold> {
  const cursor = await Cursor.getReadWatermark(agentUserId, podId);
  const after = cursor?.readAt || new Date(0);
  const afterRevision = cursor?.readRevision ?? -1;
  const ownId = String(agentUserId);
  let unseenCount: number;
  let messages: Preview[];

  if (pool && process.env.PG_HOST) {
    const result = await pool.query(`
        SELECT m.id, m.content, m.created_at, COALESCE(u.username, 'Unknown') AS author,
          COUNT(*) OVER ()::integer AS unseen_count
        FROM messages m LEFT JOIN users u ON u._id = m.user_id
        WHERE m.pod_id = $1 AND m.freshness_revision > $2
          AND (m.user_id IS DISTINCT FROM $3 OR m.author_kind = 'kernel')
          AND NOT (m.message_type = 'system' AND COALESCE(m.payload->>'kind', '') = 'system-action')
        ORDER BY m.freshness_revision DESC, m.id DESC LIMIT 3
      `, [String(podId), afterRevision, ownId]);
    unseenCount = Number(result.rows[0]?.unseen_count || 0);
    messages = result.rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      author: String(row.author),
      content: String(row.content || '').slice(0, 500),
      createdAt: row.created_at,
    }));
  } else {
    ({ unseenCount, messages } = await unseenFromMongo(podId, ownId, after));
  }

  if (!unseenCount) return null;
  const countSentence = unseenCount === 1
    ? 'There is 1 unseen message.'
    : `There are ${unseenCount} unseen messages.`;
  return {
    code: 'unseen_messages',
    unseenCount,
    messages,
    message: `${countSentence} Read the conversation and retry, or call again with continueAnyway:true to continue.`,
  };
}

async function unseenFromMongo(podId: unknown, ownId: string, after: Date): Promise<{ unseenCount: number; messages: Preview[] }> {
  const query = {
    podId,
    $nor: [{ messageType: 'system', 'payload.kind': 'system-action' }],
    $and: [
      { $or: [{ userId: { $ne: ownId } }, { authorKind: 'kernel' }] },
      { $or: [
        { freshnessPending: true },
        // Server clocks are millisecond-granular; equality is a hold, not an
        // acknowledgement of a message that may have committed later.
        { freshnessCommittedAt: { $gte: after } },
        // Rows written before this marker existed retain the old date rule.
        { freshnessPending: { $exists: false }, freshnessCommittedAt: { $exists: false }, createdAt: { $gt: after } },
      ] },
    ],
  };
  const [unseenCount, rows] = await Promise.all([
    MongoMessage.countDocuments(query),
    MongoMessage.find(query).sort({ freshnessPending: -1, freshnessCommittedAt: -1, createdAt: -1, _id: -1 }).limit(3)
      .populate('userId', 'username').lean(),
  ]);
  return {
    unseenCount,
    messages: rows.map((row: Record<string, any>) => ({
      id: String(row._id),
      author: row.userId?.username || 'Unknown',
      content: String(row.content || '').slice(0, 500),
      createdAt: row.createdAt,
    })),
  };
}

module.exports = { readStart, recordRead, recordCatchUp, unseenMessages };
export {};
