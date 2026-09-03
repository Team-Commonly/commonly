/**
 * Materialize AttentionItem rows for facts written before TASK-112.
 *
 * Run once per deployed environment after the AttentionItem model and source
 * writers are live:
 *
 *   npm run backfill:attention-items -- --apply
 *
 * The source/recipient unique index makes a retry safe. The script directly
 * queries source stores; after it succeeds, Activity's old reconstructed
 * readers must stay deleted.
 */
/* eslint-disable no-console */
const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const DecisionRequest = require('../models/DecisionRequest');
const Message = require('../models/Message');
const Task = require('../models/Task');
const User = require('../models/User');
const {
  recordApproval, recordDecision, recordMentionedUsers, recordTaskAttention, TASK_HANDOFF_RE,
} = require('../services/attentionItemService');

const APPLY = process.argv.includes('--apply');
const MENTION_CUTOFF_DAYS = 14;

type PgPool = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
};

const legacyAcknowledgements = async (): Promise<Map<string, Set<string>>> => {
  // This retired field is deliberately absent from the current User schema.
  // Use the raw collection so Mongoose cannot omit it from the projection.
  const users = await User.collection.find(
    { 'activityQueue.acknowledgedMentionIds.0': { $exists: true } },
    { projection: { _id: 1, activityQueue: 1 } },
  ).toArray();
  return new Map(users.map((user: any) => [
    String(user._id),
    new Set((user.activityQueue?.acknowledgedMentionIds || []).map(String)),
  ]));
};

export const main = async (): Promise<void> => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  // eslint-disable-next-line global-require
  const { pool } = require('../config/db-pg') as { pool: PgPool | null };

  await mongoose.connect(process.env.MONGO_URI);
  try {
    const cutoff = new Date(Date.now() - MENTION_CUTOFF_DAYS * 24 * 60 * 60 * 1000);
    const [approvals, decisions, tasks, acknowledgements, mongoMessages] = await Promise.all([
      Activity.find({ type: 'approval_needed', 'approval.status': 'pending', deleted: { $ne: true } }).lean(),
      DecisionRequest.find({ status: 'pending' }).lean(),
      Task.find({
        $or: [{ status: 'blocked' }, { 'updates.text': { $regex: TASK_HANDOFF_RE } }],
      }).select('podId taskId title status notes updates updatedAt').lean(),
      legacyAcknowledgements(),
      Message.find({ createdAt: { $gte: cutoff } }).lean(),
    ]);

    const pgMessages = pool
      ? (await pool.query(
        'SELECT m.id, m.pod_id, m.user_id, m.content, m.created_at, m.thread_root_id, u.username '
        + 'FROM messages m LEFT JOIN users u ON u._id = m.user_id '
        + "WHERE m.created_at >= now() - ($1::int * interval '1 day') ORDER BY m.created_at ASC",
        [MENTION_CUTOFF_DAYS],
      )).rows
      : [];
    const messages = [...pgMessages, ...mongoMessages];

    console.log(JSON.stringify({
      approvals: approvals.length,
      decisions: decisions.length,
      tasks: tasks.length,
      recentPgMessages: pgMessages.length,
      recentMongoFallbackMessages: mongoMessages.length,
      apply: APPLY,
    }));
    if (!APPLY) {
      console.log('DRY RUN — no AttentionItems written. Re-run with --apply after deploy.');
      return;
    }

    for (const approval of approvals) await recordApproval(approval);
    for (const decision of decisions) await recordDecision(decision);
    for (const task of tasks) await recordTaskAttention(task, { includeBlocked: true });
    for (const message of messages) {
      await recordMentionedUsers(message, {
        isAlreadyAcknowledged: (recipientUserId: unknown, legacyMentionId: string) => (
          acknowledgements.get(String(recipientUserId))?.has(legacyMentionId) || false
        ),
      });
    }
    console.log('APPLIED — source facts materialized. A retry is safe because recipient/source is unique.');
  } finally {
    await mongoose.disconnect();
    if (pool) await pool.end();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error('attention-item backfill failed:', error);
    process.exit(1);
  });
}
