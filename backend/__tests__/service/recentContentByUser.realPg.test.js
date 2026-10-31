/**
 * `recentContentByUser` on real PostgreSQL. The pg-mem arm
 * (unit/models/recentContentByUser.pgmem.test.js) proves the ordering only in
 * pg-mem's own planner. Here the same rules run on the real schema: the TASK-503
 * history copy gives months-old rows high ids, created_at is nullable, and DESC
 * sorts NULL first unless the query says NULLS LAST.
 */
const { setupPgDb, closePgDb } = require('../utils/testUtils');

const { pool } = require('../../config/db-pg');
const PGMessage = require('../../models/pg/Message');

const d = process.env.INTEGRATION_TEST === 'true' && process.env.PG_HOST ? describe : describe.skip;
const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const LIN = 'cccccccccccccccccccccc01';

const insert = (content, createdAt) => pool.query(
  'INSERT INTO messages (pod_id, user_id, content, message_type, created_at) VALUES ($1, $2, $3, $4, $5)',
  [POD, LIN, content, 'text', createdAt],
);

d('recentContentByUser on real PostgreSQL', () => {
  beforeAll(async () => {
    await setupPgDb();
    await pool.query("INSERT INTO pods (id, name, type, created_by) VALUES ($1, 'History', 'chat', $2)", [POD, LIN]);
    await insert('written live this week', new Date('2026-10-28T10:00:00Z'));
    await insert('copied from months ago', new Date('2026-06-01T10:00:00Z'));
    // Two rows at the same instant: the later insert (higher id) comes first.
    await insert('same instant, lower id', new Date('2026-05-01T10:00:00Z'));
    await insert('same instant, higher id', new Date('2026-05-01T10:00:00Z'));
    await insert('undated, highest id', null);
  });
  afterAll(async () => {
    await pool.query('TRUNCATE TABLE messages, pods RESTART IDENTITY CASCADE');
    await closePgDb();
    await pool.end();
  });

  test('orders by created_at, ties by id, and puts an undated row last', async () => {
    await expect(PGMessage.recentContentByUser(LIN)).resolves.toEqual([
      'written live this week',
      'copied from months ago',
      'same instant, higher id',
      'same instant, lower id',
      'undated, highest id',
    ]);
  });

  test('the row cap keeps the newest dated rows', async () => {
    await expect(PGMessage.recentContentByUser(LIN, 1)).resolves.toEqual(['written live this week']);
  });
});
