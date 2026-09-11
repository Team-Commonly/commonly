/**
 * #1648 — `hasMessageByUserInPod`, EXECUTED against pg-mem.
 *
 * The SQL is the contract: "the caller's own message in this pod" lives in
 * `WHERE pod_id = $1 AND user_id = $2 AND message_type != 'system'`. The route
 * suite (registry.pod-agents-caller-spoke) mocks the model, so it proves the
 * field is plumbed and never that the query discriminates — @sprint-review
 * (67326) dropped `AND user_id = $2` and the route suite stayed green, which
 * is the #1648 bug itself: a seat's install intro closing "Say something to
 * it". These cases run the shipped query string, same harness as
 * threadRootDerivation.pgmem.test.js.
 */

const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();

jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const PGMessage = require('../../../models/pg/Message');

const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OTHER_POD = 'aaaaaaaaaaaaaaaaaaaaaa02';
const CALLER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const SEAT = 'cccccccccccccccccccccc01';

const insert = (podId, userId, content, type = 'text') => mockPool.query(
  'INSERT INTO messages (pod_id, user_id, content, message_type) VALUES ($1, $2, $3, $4)',
  [podId, userId, content, type],
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
});

describe('hasMessageByUserInPod (#1648)', () => {
  test('a seat that spoke first — its install intro — is not the caller speaking', async () => {
    await insert(POD, SEAT, 'Hi, I am Scout. Ask me how things work here.');
    await expect(PGMessage.hasMessageByUserInPod(POD, CALLER)).resolves.toBe(false);
  });

  test("a system row under the caller's id (join/leave) is not the caller speaking", async () => {
    await insert(POD, CALLER, 'joined the pod', 'system');
    await expect(PGMessage.hasMessageByUserInPod(POD, CALLER)).resolves.toBe(false);
  });

  test("the caller's message in ANOTHER pod does not count for this one", async () => {
    await insert(OTHER_POD, CALLER, 'hello from somewhere else');
    await expect(PGMessage.hasMessageByUserInPod(POD, CALLER)).resolves.toBe(false);
  });

  test("the caller's own text row in this pod is the act, reply or not", async () => {
    await insert(POD, CALLER, '@scout what can you do here?');
    await expect(PGMessage.hasMessageByUserInPod(POD, CALLER)).resolves.toBe(true);
    // The seat never answered; the other pod, where nobody sits, still reads as it did.
    await expect(PGMessage.hasMessageByUserInPod(OTHER_POD, SEAT)).resolves.toBe(false);
  });

  test('accepts ObjectId-like values and refuses blanks without touching the pool', async () => {
    const asId = { toString: () => CALLER };
    await expect(PGMessage.hasMessageByUserInPod({ toString: () => POD }, asId)).resolves.toBe(true);
    await expect(PGMessage.hasMessageByUserInPod('', CALLER)).resolves.toBe(false);
    await expect(PGMessage.hasMessageByUserInPod(POD, null)).resolves.toBe(false);
  });
});
