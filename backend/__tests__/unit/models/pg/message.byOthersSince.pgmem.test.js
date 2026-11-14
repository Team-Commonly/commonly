// F503: the digest's teammate read runs this model's real SQL on pg-mem. The
// digest test stubs the read, so it would pass whatever the query returned.
const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();

jest.mock('../../../../config/db-pg', () => ({ pool: mockPool }));

const PGMessage = require('../../../../models/pg/Message');

const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();

beforeAll(async () => {
  await mockPool.query(`CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    pod_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    content TEXT,
    message_type VARCHAR(50) DEFAULT 'text',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`);
  const rows = [
    ['shared', 'mate', 'older', 'text', at(5)],
    ['shared', 'mate', 'newer', 'text', at(1)],
    ['shared', 'me', 'my own words', 'text', at(1)],
    ['shared', 'agent', 'is not connected yet', 'system', at(1)],
    ['shared', 'mate', '', 'text', at(1)],
    ['shared', 'mate', 'before the window', 'text', at(30)],
    ['elsewhere', 'mate', 'another pod', 'text', at(1)],
  ];
  for (const [pod, user, content, type, created] of rows) {
    // eslint-disable-next-line no-await-in-loop
    await mockPool.query(
      'INSERT INTO messages (pod_id, user_id, content, message_type, created_at) VALUES ($1, $2, $3, $4, $5)',
      [pod, user, content, type, created],
    );
  }
});

test("returns other people's words in the given pods since the window opened, newest first", async () => {
  const rows = await PGMessage.findByOthersSince(['shared'], 'me', new Date(Date.now() - 24 * 3600000));
  expect(rows.map((r) => [r.podId, r.userId, r.content])).toEqual([
    ['shared', 'mate', 'newer'],
    ['shared', 'mate', 'older'],
  ]);
});

test('no pods means no query and no rows', async () => {
  expect(await PGMessage.findByOthersSince([], 'me', new Date(0))).toEqual([]);
});
