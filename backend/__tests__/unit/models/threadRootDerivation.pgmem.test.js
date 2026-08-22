/**
 * thread_root_id derivation, EXECUTED at the unit tier (W-T, TASK-029, 1/4).
 *
 * @sprint-review (56787): the depth claim was asserted by grepping for the
 * COALESCE substring that implements it — assertion and thing asserted are the
 * same text, so it cannot discriminate. They proposed pg-mem: insert A, B→A,
 * C→B, assert C's root is A; mutate COALESCE to `parent.id` and it must go red.
 *
 * They were right and my first answer was too broad. I had probed pg-mem,
 * found `WITH RECURSIVE` unsupported, and generalised that to "pg-mem cannot
 * run this". Only the backfill's recursive CTE is out of reach — the write-path
 * derivation runs fine once the scalar subquery is cast (pg-mem otherwise
 * types it as `integer[]`). The production query now carries those casts,
 * which are inert in Postgres, so what runs below is the REAL string.
 *
 * This is the fast tier and it runs in plain `npm test`. The tier-1 suite
 * (__tests__/service/threading.derivation.test.js) still exists for what needs
 * a real server: the recursive CTE, the foreign keys, ON DELETE SET NULL.
 */

const { newDb } = require('pg-mem');

// `mock`-prefixed so jest's hoisted factory below may reference it — the
// factory runs before ordinary module scope, and jest only exempts names it
// can see are mocks.
const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();

// The model reads its pool from here. Pointing that at pg-mem is what makes
// this exercise the shipped code path rather than a re-typed copy of its SQL.
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const PGMessage = require('../../../models/pg/Message');

const POD = 'pod-1';
const insert = (content, replyTo = null) => PGMessage.create(POD, 'user-1', content, 'text', replyTo);

beforeAll(async () => {
  // Only the columns the derivation touches. No FKs to pods/users: those are
  // real and are covered by the tier-1 suite, and adding them here would make
  // this a slower copy of that instead of a fast complement to it.
  await mockPool.query(`CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    pod_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    content TEXT,
    message_type VARCHAR(50) DEFAULT 'text',
    payload JSONB,
    reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    thread_root_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`);
  await mockPool.query(`CREATE TABLE pods (
    id VARCHAR(255) PRIMARY KEY, updated_at TIMESTAMP WITH TIME ZONE
  )`);
  await mockPool.query("INSERT INTO pods (id) VALUES ('pod-1')");
});

describe('the derivation runs, and depth is the thing it proves', () => {
  test('a root gets NULL, not itself', async () => {
    const root = await insert('root');
    expect(root.thread_root_id).toBeNull();
  });

  test('a direct reply inherits the root id', async () => {
    const root = await insert('root');
    const reply = await insert('reply', root.id);
    expect(reply.thread_root_id).toBe(root.id);
  });

  test("sprint-review's case: A, B→A, C→B — C's root is A, not B", async () => {
    const a = await insert('A');
    const b = await insert('B', a.id);
    const c = await insert('C', b.id);
    expect(b.thread_root_id).toBe(a.id);
    expect(c.thread_root_id).toBe(a.id);
    // The discriminating half. With `parent.id` instead of COALESCE, C's root
    // would be B — which is also C's reply edge, so the two columns would
    // collapse and the whole design would be redundant.
    expect(c.thread_root_id).not.toBe(c.reply_to_message_id);
  });

  test('depth 7 — the deepest chain on live data — still resolves to one root', async () => {
    const root = await insert('depth 1');
    let prev = root;
    const chain = [];
    for (let i = 2; i <= 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      prev = await insert(`depth ${i}`, prev.id);
      chain.push(prev);
    }
    for (const row of chain) expect(row.thread_root_id).toBe(root.id);
  });

  test('two chains in one pod stay separate', async () => {
    const a = await insert('root A');
    const b = await insert('root B');
    const deepA = await insert('a2', (await insert('a1', a.id)).id);
    const deepB = await insert('b2', (await insert('b1', b.id)).id);
    expect(deepA.thread_root_id).toBe(a.id);
    expect(deepB.thread_root_id).toBe(b.id);
  });
});
