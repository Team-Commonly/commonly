// A pod-wide read watermark, recorded only after a successful current-tail read.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Cursor = require('../models/AgentPodReadCursor');
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
const cursorId = (agentUserId: unknown, podId: unknown): string => `${String(agentUserId)}:${String(podId)}`;

async function recordRead(agentUserId: unknown, podId: unknown, start: ReadStart): Promise<void> {
  // A slow earlier read must not roll a newer read's watermark backwards.
  const filter = { _id: cursorId(agentUserId, podId) };
  const maximum = {
    readAt: start.at,
    ...(start.revision === undefined ? {} : { readRevision: start.revision }),
  };
  try {
    await Cursor.updateOne(filter, { $max: maximum, $setOnInsert: { agentUserId, podId } }, { upsert: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    // Two first reads can race on the deterministic _id; the loser still
    // advances the winner's cursor without ever replacing a later timestamp.
    await Cursor.updateOne(filter, { $max: maximum });
  }
}

async function unseenMessages(agentUserId: unknown, podId: unknown): Promise<Hold> {
  const cursor = await Cursor.findOne({ _id: cursorId(agentUserId, podId) }).select('readAt readRevision').lean();
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
  return {
    code: 'unseen_messages',
    unseenCount,
    messages,
    message: `There are ${unseenCount} unseen messages. Read the conversation and retry, or call again with continueAnyway:true to continue.`,
  };
}

async function unseenFromMongo(podId: unknown, ownId: string, after: Date): Promise<{ unseenCount: number; messages: Preview[] }> {
  const query = {
    podId,
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
    MongoMessage.find(query).sort({ createdAt: -1, _id: -1 }).limit(3)
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

module.exports = { readStart, recordRead, unseenMessages };
export {};
