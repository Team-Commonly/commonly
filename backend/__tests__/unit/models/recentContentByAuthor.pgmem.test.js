/**
 * `recentContentByAuthor`, EXECUTED against pg-mem. The handoff cue
 * (agentMentionService) asks it whether an agent recently @mentioned another;
 * the service suite mocks it, so only this file proves the WHERE clause
 * discriminates by pod, author, window and row type.
 */

const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();

jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const PGMessage = require('../../../models/pg/Message');

const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OTHER_POD = 'aaaaaaaaaaaaaaaaaaaaaa02';
const CODEX = 'cccccccccccccccccccccc01';
const CLAUDE = 'cccccccccccccccccccccc02';
const NOW = new Date('2026-10-20T20:00:00Z');
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60 * 1000);
const SINCE = minutesAgo(30);

const insert = (podId, userId, content, createdAt, type = 'text') => mockPool.query(
  'INSERT INTO messages (pod_id, user_id, content, message_type, created_at) VALUES ($1, $2, $3, $4, $5)',
  [podId, userId, content, type, createdAt],
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
  await insert(POD, CODEX, 'older than the window @claude', minutesAgo(45));
  await insert(POD, CODEX, 'first in the window', minutesAgo(20));
  await insert(OTHER_POD, CODEX, 'another pod @claude', minutesAgo(10));
  await insert(POD, CLAUDE, 'another author @codex', minutesAgo(8));
  await insert(POD, CODEX, 'joined the pod', minutesAgo(6), 'system');
  await insert(POD, CODEX, 'done, @claude', minutesAgo(5));
});

describe('recentContentByAuthor', () => {
  test("returns this author's rows in this pod inside the window, newest first", async () => {
    await expect(PGMessage.recentContentByAuthor(POD, CODEX, SINCE))
      .resolves.toEqual(['done, @claude', 'first in the window']);
  });

  test("another author's rows are not this author's", async () => {
    await expect(PGMessage.recentContentByAuthor(POD, CLAUDE, SINCE)).resolves.toEqual(['another author @codex']);
  });

  test('another pod is never read', async () => {
    await expect(PGMessage.recentContentByAuthor(OTHER_POD, CLAUDE, SINCE)).resolves.toEqual([]);
    await expect(PGMessage.recentContentByAuthor(OTHER_POD, CODEX, SINCE)).resolves.toEqual(['another pod @claude']);
  });

  test('rows before the window are not returned', async () => {
    const all = await PGMessage.recentContentByAuthor(POD, CODEX, minutesAgo(60));
    expect(all).toContain('older than the window @claude');
    await expect(PGMessage.recentContentByAuthor(POD, CODEX, SINCE))
      .resolves.not.toContain('older than the window @claude');
  });

  test('system rows are not what the author said', async () => {
    await expect(PGMessage.recentContentByAuthor(POD, CODEX, minutesAgo(60)))
      .resolves.not.toContain('joined the pod');
  });

  test('the row cap keeps the newest', async () => {
    await expect(PGMessage.recentContentByAuthor(POD, CODEX, minutesAgo(60), 1)).resolves.toEqual(['done, @claude']);
  });

  test('accepts ObjectId-like values and refuses blanks', async () => {
    await expect(PGMessage.recentContentByAuthor({ toString: () => POD }, { toString: () => CLAUDE }, SINCE))
      .resolves.toEqual(['another author @codex']);
    await expect(PGMessage.recentContentByAuthor('', CODEX, SINCE)).resolves.toEqual([]);
    await expect(PGMessage.recentContentByAuthor(POD, null, SINCE)).resolves.toEqual([]);
  });
});
