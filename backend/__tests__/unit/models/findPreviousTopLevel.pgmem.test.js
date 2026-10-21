/**
 * ADR-018 D6.4: `findPreviousTopLevel`, EXECUTED against pg-mem.
 *
 * The SQL is the contract for "the message just before this one in the room":
 * `WHERE pod_id = $1 AND id < $2 AND thread_root_id IS NULL AND created_at > $3
 * ORDER BY id DESC LIMIT 1`. The agentMentionService suites mock the model, so
 * they prove the rule is plumbed and never that the query picks the right row:
 * sprint-review (on #2359) dropped the pod bound, the thread filter, the window
 * and the ordering one at a time, and every suite stayed green. Two of those
 * are wrong-agent delivery: a room message addressed to whoever last spoke
 * inside a thread, or to an agent in another pod. Same harness as
 * callerSpoke.pgmem.test.js.
 */

const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();

jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const PGMessage = require('../../../models/pg/Message');

const AGENT = 'cccccccccccccccccccccc01';
const OTHER_AGENT = 'cccccccccccccccccccccc02';
const PERSON = 'bbbbbbbbbbbbbbbbbbbbbb01';
const NOW = new Date('2026-10-20T03:00:23Z');
const ago = (seconds) => new Date(NOW.getTime() - seconds * 1000);
const WINDOW_START = ago(30 * 60);

const insert = async (podId, userId, at, { type = 'text', threadRoot = null } = {}) => {
  const { rows } = await mockPool.query(
    `INSERT INTO messages (pod_id, user_id, content, message_type, thread_root_id, created_at)
     VALUES ($1, $2, 'x', $3, $4, $5) RETURNING id`,
    [podId, userId, type, threadRoot, at],
  );
  return rows[0].id;
};

const previous = async (podId, beforeId) => {
  const row = await PGMessage.findPreviousTopLevel(podId, String(beforeId), WINDOW_START);
  return row ? { id: row.id, user_id: row.user_id, message_type: row.message_type } : null;
};

beforeAll(async () => {
  await mockPool.query(`CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    pod_id VARCHAR(24) NOT NULL,
    user_id VARCHAR(24) NOT NULL,
    content TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text' NOT NULL,
    thread_root_id INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`);
});

describe('findPreviousTopLevel (ADR-018 D6.4)', () => {
  test('returns the message immediately before, not an earlier one', async () => {
    const pod = 'aaaaaaaaaaaaaaaaaaaaaa01';
    await insert(pod, OTHER_AGENT, ago(120));
    const latest = await insert(pod, AGENT, ago(51));
    const reply = await insert(pod, PERSON, NOW);
    await expect(previous(pod, reply)).resolves.toEqual({ id: latest, user_id: AGENT, message_type: 'text' });
  });

  test('skips replies inside a thread, and a thread root stays adjacent to the room', async () => {
    const pod = 'aaaaaaaaaaaaaaaaaaaaaa02';
    const greeting = await insert(pod, AGENT, ago(90));
    await insert(pod, OTHER_AGENT, ago(30), { threadRoot: greeting });
    const reply = await insert(pod, PERSON, NOW);
    await expect(previous(pod, reply)).resolves.toEqual({ id: greeting, user_id: AGENT, message_type: 'text' });
  });

  test("never returns another pod's message, however recent", async () => {
    const pod = 'aaaaaaaaaaaaaaaaaaaaaa03';
    const elsewhere = 'aaaaaaaaaaaaaaaaaaaaaa13';
    const own = await insert(pod, AGENT, ago(300));
    await insert(elsewhere, OTHER_AGENT, ago(10));
    const reply = await insert(pod, PERSON, NOW);
    await expect(previous(pod, reply)).resolves.toEqual({ id: own, user_id: AGENT, message_type: 'text' });
  });

  test('returns nothing when the previous message is outside the window', async () => {
    const pod = 'aaaaaaaaaaaaaaaaaaaaaa04';
    await insert(pod, AGENT, ago(40 * 60));
    const reply = await insert(pod, PERSON, NOW);
    await expect(previous(pod, reply)).resolves.toBeNull();
  });

  test('returns a system row as it is, for the caller to refuse', async () => {
    const pod = 'aaaaaaaaaaaaaaaaaaaaaa05';
    const notice = await insert(pod, AGENT, ago(5), { type: 'system' });
    const reply = await insert(pod, PERSON, NOW);
    await expect(previous(pod, reply)).resolves.toEqual({ id: notice, user_id: AGENT, message_type: 'system' });
  });

  test("returns nothing for a pod's first message", async () => {
    const pod = 'aaaaaaaaaaaaaaaaaaaaaa06';
    const first = await insert(pod, PERSON, NOW);
    await expect(previous(pod, first)).resolves.toBeNull();
  });
});
