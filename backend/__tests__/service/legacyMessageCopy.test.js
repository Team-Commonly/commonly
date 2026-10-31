/**
 * TASK-503 — a legacy MongoDB message copied into PostgreSQL by `copyOne`.
 *
 * Runs against real PostgreSQL and real MongoDB (Tier 1). The claims need a
 * database that enforces them: ON CONFLICT on a unique index, a foreign key
 * from messages.pod_id to pods(id), and two concurrent copies racing on the
 * same row. pg-mem can do none of that faithfully. The cases that tested the
 * removed background reconciler's pass (batching, deferral, poison rows) went
 * with it; the backfill script's own suite covers the operator run.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Pool } = require('pg');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const RUN = process.env.INTEGRATION_TEST === 'true';
const d = RUN ? describe : describe.skip;
const MARKER = 'tier1-reconcile-313';

let pool;
let MongoMessage;
let copyOne;
let ensureLegacyIdIndex;
let PGMessage;
let MessageReaction;

const POD = new mongoose.Types.ObjectId().toHexString();
const USER = new mongoose.Types.ObjectId().toHexString();

const connect = () => new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: false,
});

const insertFallback = (content, extra = {}) => MongoMessage.create({
  pgFallback: true,
  podId: POD,
  userId: USER,
  content: `${MARKER} ${content}`,
  messageType: 'text',
  createdAt: new Date(),
  ...extra,
});

const pgRowsFor = async (mongoId) => (await pool.query(
  'SELECT id, content, created_at, payload, author_kind FROM messages WHERE legacy_mongo_id = $1',
  [String(mongoId)],
)).rows;

d('TASK-503: copy a legacy Mongo message into PostgreSQL', () => {
  beforeAll(async () => {
    pool = connect();
    await pool.query(fs.readFileSync(path.join(__dirname, '../../config/schema.sql'), 'utf8'));
    await pool.query(
      `INSERT INTO pods (id, name, type, created_by) VALUES ($1, $2, 'chat', $3)
       ON CONFLICT (id) DO NOTHING`,
      [POD, 'reconcile-313', USER],
    );
    await setupMongoDb();
    // The app's own pool and models: this is the code under test.
    // eslint-disable-next-line global-require
    MongoMessage = require('../../models/Message');
    // eslint-disable-next-line global-require
    ({ copyOne, ensureLegacyIdIndex } = require('../../services/legacyMessageCopy'));
    // eslint-disable-next-line global-require
    PGMessage = require('../../models/pg/Message');
    // eslint-disable-next-line global-require
    MessageReaction = require('../../models/pg/MessageReaction').default;
    await ensureLegacyIdIndex();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM messages WHERE content LIKE $1', [`${MARKER}%`]);
    await clearMongoDb();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM messages WHERE content LIKE $1', [`${MARKER}%`]);
    await pool.query('DELETE FROM pods WHERE id = $1', [POD]);
    await pool.end();
    await closeMongoDb();
    // The app's pool is module-scoped; close it so Jest does not hold the process.
    // eslint-disable-next-line global-require
    const { pool: appPool } = require('../../config/db-pg');
    if (appPool?.end) await appPool.end();
  });

  test('moves a fallback message once and keeps its Mongo id as the legacy id', async () => {
    const doc = await insertFallback('a');

    expect(await copyOne(doc)).toBe('moved');
    const rows = await pgRowsFor(doc._id);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(`${MARKER} a`);
    expect(new Date(rows[0].created_at).getTime()).toBe(doc.createdAt.getTime());
    const after = await MongoMessage.findById(doc._id).lean();
    expect(after.reconciledAt).toBeInstanceOf(Date);
    expect(after.reconciledPgId).toBe(Number(rows[0].id));
  });

  test('each message appears once in the Postgres read after a copy, and a second copy moves nothing', async () => {
    await insertFallback('b1');
    await insertFallback('b2');

    const docs = await MongoMessage.find({ content: { $regex: `^${MARKER} b` } });
    expect(docs).toHaveLength(2);
    for (const doc of docs) await copyOne(doc);
    for (const doc of docs) expect(await copyOne(doc)).toBe('present');

    const listed = await PGMessage.findByPodId(POD, 50);
    const ours = listed.filter((m) => String(m.content).startsWith(`${MARKER} b`));
    expect(ours).toHaveLength(2);
    expect(new Set(ours.map((m) => m._id)).size).toBe(2);
  });

  test('two concurrent copies leave exactly one Postgres row per message', async () => {
    const doc = await insertFallback('c');

    const [x, y] = await Promise.all([copyOne(doc), copyOne(doc)]);

    expect([x, y].filter((outcome) => outcome === 'moved')).toHaveLength(1);
    expect(await pgRowsFor(doc._id)).toHaveLength(1);
    const stamped = await MongoMessage.findById(doc._id).lean();
    expect(stamped.reconciledAt).toBeInstanceOf(Date);
  });

  test('a second copy leaves the first reconciledAt and pgId unchanged', async () => {
    const doc = await insertFallback('set-once');
    await copyOne(doc);
    const first = await MongoMessage.findById(doc._id).lean();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await copyOne(doc);
    const second = await MongoMessage.findById(doc._id).lean();
    expect(second.reconciledAt).toEqual(first.reconciledAt);
    expect(second.reconciledPgId).toBe(first.reconciledPgId);
    expect(await pgRowsFor(doc._id)).toHaveLength(1);
  });

  test('a conflict row deleted before lookup is not stamped with a NaN pgId', async () => {
    const doc = await insertFallback('deleted-during-copy');
    const { pool: appPool } = require('../../config/db-pg');
    const spy = jest.spyOn(appPool, 'query').mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(copyOne(doc)).rejects.toThrow('disappeared');
    spy.mockRestore();
    const after = await MongoMessage.findById(doc._id).lean();
    expect(after.reconciledAt).toBeUndefined();
    expect(after.reconciledPgId).toBeUndefined();
  });

  test('card payload and kernel authorship survive the copy', async () => {
    const payload = { type: 'decision', options: ['continue'] };
    const doc = await insertFallback('card', { messageType: 'card', payload, authorKind: 'kernel' });
    await copyOne(doc);
    expect((await pgRowsFor(doc._id))[0]).toMatchObject({ payload, author_kind: 'kernel' });
  });

  test('copied IDs work as replies and thread roots and reject missing or cross-pod targets', async () => {
    const doc = await insertFallback('thread-root');
    await copyOne(doc);
    const { resolveThreadRoot, assertReplyTargetInPod } = require('../../services/threadRootResolver');
    const root = await resolveThreadRoot({ podId: POD, threadRootId: String(doc._id) });
    await expect(assertReplyTargetInPod({ podId: POD, replyToMessageId: String(doc._id) })).resolves.toBeUndefined();
    const reply = await PGMessage.create(POD, USER, `${MARKER} reply`, 'text', String(doc._id));
    expect(Number(reply.reply_to_message_id)).toBe(root);
    expect(Number(reply.thread_root_id)).toBe(root);
    await expect(resolveThreadRoot({ podId: POD, threadRootId: new mongoose.Types.ObjectId().toHexString() })).rejects.toMatchObject({ code: 'thread_root_invalid' });
    await expect(assertReplyTargetInPod({ podId: new mongoose.Types.ObjectId().toHexString(), replyToMessageId: String(doc._id) })).rejects.toMatchObject({ code: 'reply_target_unavailable' });
  });

  test('all-digit ObjectIds resolve as Mongo IDs rather than PG integers', async () => {
    const doc = await insertFallback('digit-id', { _id: new mongoose.Types.ObjectId('123456789012345678901234') });
    await copyOne(doc);
    expect(await PGMessage.resolveId(String(doc._id))).toBe(String((await pgRowsFor(doc._id))[0].id));
  });

  test('a moved message resolves its Mongo id for delete', async () => {
    const doc = await insertFallback('f');
    await copyOne(doc);
    const pgId = await PGMessage.resolveId(String(doc._id));
    expect(pgId).toBe(String((await pgRowsFor(doc._id))[0].id));

    await PGMessage.delete(String(doc._id));

    expect(await pgRowsFor(doc._id)).toHaveLength(0);
  });

  test.each(['mongo', 'pg'])('delete by %s ID removes the unstamped Mongo copy too', async (idKind) => {
    const doc = await insertFallback('crashed-stamp-delete');
    await copyOne(doc);
    const pgId = await PGMessage.resolveId(String(doc._id));
    await MongoMessage.updateOne({ _id: doc._id }, { $unset: { reconciledAt: 1, reconciledPgId: 1 } });
    const controller = require('../../controllers/messageController');
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.deleteMessage({ params: { id: idKind === 'mongo' ? String(doc._id) : pgId }, userId: USER }, res);
    expect(res.json).toHaveBeenCalledWith({ msg: 'Message deleted' });
    expect(await MongoMessage.findById(doc._id).lean()).toBeNull();
    expect(await pgRowsFor(doc._id)).toHaveLength(0);
    expect(await pgRowsFor(doc._id)).toHaveLength(0);
  });

  test('a moved message resolves its Mongo id for reactions', async () => {
    const doc = await insertFallback('g');
    await copyOne(doc);
    const pgId = await PGMessage.resolveId(String(doc._id));

    await MessageReaction.add(pgId, USER, '👍');

    const summaries = await MessageReaction.listForMessage(pgId, USER);
    expect(summaries.map((s) => s.emoji)).toEqual(['👍']);
  });
});
