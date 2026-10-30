/**
 * `recentContentByUser`, EXECUTED against pg-mem. firstContactService picks the
 * language of a person's first greeting from it. The TASK-503 history copy
 * inserts months-old rows into PostgreSQL with fresh, high ids, so "recent"
 * must mean newest by created_at, not newest by insert order.
 */

const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();

jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const PGMessage = require('../../../models/pg/Message');

const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const LIN = 'cccccccccccccccccccccc01';
const OTHER = 'cccccccccccccccccccccc02';

const insert = (userId, content, createdAt, type = 'text') => mockPool.query(
  'INSERT INTO messages (pod_id, user_id, content, message_type, created_at) VALUES ($1, $2, $3, $4, $5)',
  [POD, userId, content, type, createdAt],
);

beforeAll(async () => {
  await mockPool.query(`CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    pod_id VARCHAR(24) NOT NULL,
    user_id VARCHAR(24) NOT NULL,
    content TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text' NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`);
  // Written live, so its id is low.
  await insert(LIN, 'hello, this week in English', new Date('2026-10-28T10:00:00Z'));
  await insert(OTHER, 'someone else', new Date('2026-10-29T10:00:00Z'));
  await insert(LIN, 'joined the pod', new Date('2026-10-29T11:00:00Z'), 'system');
  // Copied from MongoDB afterwards: an old row with a higher id.
  await insert(LIN, '你好，这是几个月前的', new Date('2026-06-01T10:00:00Z'));
});

describe('recentContentByUser', () => {
  test('an old row with a higher id loses to a newer row with a lower id', async () => {
    await expect(PGMessage.recentContentByUser(LIN, 1)).resolves.toEqual(['hello, this week in English']);
    await expect(PGMessage.recentContentByUser(LIN))
      .resolves.toEqual(['hello, this week in English', '你好，这是几个月前的']);
  });

  test("returns only this person's text rows", async () => {
    await expect(PGMessage.recentContentByUser(OTHER)).resolves.toEqual(['someone else']);
    await expect(PGMessage.recentContentByUser(LIN)).resolves.not.toContain('joined the pod');
  });

  test('refuses a blank user', async () => {
    await expect(PGMessage.recentContentByUser('')).resolves.toEqual([]);
  });
});
