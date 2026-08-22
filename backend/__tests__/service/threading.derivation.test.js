/**
 * Threading derivation — EXECUTED against a real Postgres (W-T, TASK-029, 1/4).
 *
 * @sprint-review blocked #1106 on exactly this: the unit tests are regexes over
 * Message.ts and schema.sql as strings, and nothing runs the SQL. A regex
 * proves the query was written; it cannot prove the query is correct, and the
 * two claims that matter here are both about what Postgres DOES —
 *
 *   1. COALESCE(parent.thread_root_id, parent.id) collapses ANY depth to the
 *      one true root, using a single parent lookup.
 *   2. The backfill's recursive CTE produces the same roots as the write path.
 *
 * Tier 1 only. pg-mem cannot run this — probed 2026-08-22: it rejects
 * `WITH RECURSIVE` outright ("your query failed to parse") and mistypes the
 * parameterised INSERT. So there is no in-process shortcut; it is a real
 * server or it is nothing. CI provides postgres:16 with INTEGRATION_TEST=true.
 */

const { Pool } = require('pg');
// The SHIPPED model, not a copy of its SQL. Re-typing the INSERT here would
// test the test: the derivation could be corrected in one place and stay wrong
// in production. This is the same code path createMessage takes.
const PGMessage = require('../../models/pg/Message');

const RUN = process.env.INTEGRATION_TEST === 'true';
// describe.skip would report "skipped" in a way that reads like coverage.
// Skipping is honest; pretending is not.
const d = RUN ? describe : describe.skip;

let pool;
// VARCHAR(24) — the pods PK is a Mongo ObjectId string, and messages.pod_id
// has an FK to it. The first run of this suite failed on exactly that, which
// is the point: a regex over the SQL cannot discover a foreign key.
const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const USER = 'bbbbbbbbbbbbbbbbbbbbbb01';

const connect = () => new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: false,
});

const seed = async () => {
  await pool.query(
    `INSERT INTO users (_id, username) VALUES ($1,'tester') ON CONFLICT (_id) DO NOTHING`, [USER],
  );
  await pool.query(
    `INSERT INTO pods (id, name, type, created_by) VALUES ($1,'threading','chat',$2)
     ON CONFLICT (id) DO NOTHING`, [POD, USER],
  );
};

const insert = (content, replyTo = null) => PGMessage.create(POD, USER, content, 'text', replyTo);

d('thread_root_id derivation, executed', () => {
  beforeAll(async () => {
    pool = connect();
    const fs = require('fs');
    const path = require('path');
    await pool.query(fs.readFileSync(path.join(__dirname, '../../config/schema.sql'), 'utf8'));
    await seed();
  });

  afterAll(async () => { if (pool) await pool.end(); });
  beforeEach(async () => { await pool.query('DELETE FROM messages WHERE pod_id = $1', [POD]); });

  test('a root has no thread_root_id — NULL, not self-referential', async () => {
    const root = await insert('the root');
    // A root pointing at itself would make "is this a root" a comparison
    // instead of a null check, and every consumer would have to know that.
    expect(root.thread_root_id).toBeNull();
  });

  test('a direct reply inherits the root id', async () => {
    const root = await insert('the root');
    const reply = await insert('first reply', root.id);
    expect(reply.thread_root_id).toBe(root.id);
    expect(reply.reply_to_message_id).toBe(root.id);
  });

  test('THE claim: one parent lookup collapses a 7-deep chain to one root', async () => {
    // This is what a regex over the SQL cannot check. The subquery reads only
    // the immediate parent, and the invariant is that this suffices at any
    // depth because the parent already stored its own root.
    const root = await insert('depth 1');
    let prev = root;
    const chain = [];
    for (let i = 2; i <= 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      prev = await insert(`depth ${i}`, prev.id);
      chain.push(prev);
    }
    for (const row of chain) expect(row.thread_root_id).toBe(root.id);
    // And the deep rows genuinely differ from the addressing edge — the
    // property the whole two-column design rests on.
    expect(chain[chain.length - 1].reply_to_message_id).not.toBe(root.id);
  });

  test('two threads in one pod do not merge', async () => {
    const a = await insert('root A');
    const b = await insert('root B');
    const ra = await insert('reply to A', a.id);
    const rb = await insert('reply to B', b.id);
    expect(ra.thread_root_id).toBe(a.id);
    expect(rb.thread_root_id).toBe(b.id);
    expect(ra.thread_root_id).not.toBe(rb.thread_root_id);
  });

  test('a reply to a missing parent is REJECTED, not silently rooted at NULL', async () => {
    // Corrects the backfill script's own comment. It says orphaned chains
    // "stay NULL by design", implying a bad edge can be written and later
    // renders unthreaded. Executed, the FK on reply_to_message_id refuses the
    // row outright — so an orphan can only be created by DELETING a parent
    // afterwards, never by writing a bad edge. That is a stronger guarantee
    // than the comment claimed, and the unit tests could not have found it
    // because no regex over the SQL sees a foreign key.
    // 999999 does not exist, so the FK on reply_to_message_id rejects the row
    // outright — the derivation subquery never even gets to return NULL.
    // Worth executing rather than assuming: it means an orphan can only be
    // CREATED by deleting a parent later, never by writing a bad edge, which
    // is a stronger guarantee than the script's comment claims.
    // Must fail for the RIGHT reason. The suite's first run "passed" this
    // assertion because pod_id's FK rejected every insert — a control that
    // shares the failure mode proves nothing.
    await expect(insert('reply to nothing', 999999))
      .rejects.toThrow(/messages_reply_to_message_id_fkey|violates foreign key/);
    // Positive control: the same call with a REAL parent succeeds, so the
    // rejection above is about the missing parent and nothing else.
    const root = await insert('a real root');
    await expect(insert('a real reply', root.id)).resolves.toBeTruthy();
  });

  test('deleting a root nulls its replies\' roots rather than deleting them', async () => {
    // ON DELETE SET NULL, executed. A CASCADE here would delete a whole
    // conversation because one message was removed.
    const root = await insert('the root');
    const reply = await insert('a reply', root.id);
    await pool.query('DELETE FROM messages WHERE id = $1', [root.id]);
    const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [reply.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_root_id).toBeNull();
  });
});

d('the backfill CTE agrees with the write path', () => {
  beforeAll(async () => {
    pool = connect();
    await seed();
  });
  afterAll(async () => {
    if (pool) await pool.end();
    // PGMessage.create uses the module-level pool from config/db-pg — the same
    // one production uses, which is why this suite exercises the real path.
    // It has to be closed too or jest hangs on an open handle.
    // eslint-disable-next-line global-require
    const { pool: modelPool } = require('../../config/db-pg');
    if (modelPool?.end) await modelPool.end();
  });
  beforeEach(async () => { await pool.query('DELETE FROM messages WHERE pod_id = $1', [POD]); });

  test('the CTE recomputes exactly the roots the write path derived', async () => {
    // The two implementations must not be able to disagree — one runs per
    // message forever, the other ran once over history. A regex can confirm
    // both exist; only execution can confirm they agree.
    const root = await insert('root');
    let prev = root;
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      prev = await insert(`level ${i}`, prev.id);
    }
    const { rows } = await pool.query(
      `WITH RECURSIVE chain AS (
         SELECT id, reply_to_message_id, id AS root FROM messages
          WHERE reply_to_message_id IS NULL AND pod_id = $1
         UNION ALL
         SELECT m.id, m.reply_to_message_id, c.root
           FROM messages m JOIN chain c ON m.reply_to_message_id = c.id
       )
       SELECT m.id, m.thread_root_id AS written, chain.root AS recomputed
         FROM messages m JOIN chain ON chain.id = m.id
        WHERE m.reply_to_message_id IS NOT NULL`,
      [POD],
    );
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(Number(r.written)).toBe(Number(r.recomputed));
  });

  test('the CTE is order-independent — inserting children before the walk changes nothing', async () => {
    const root = await insert('root');
    const a = await insert('a', root.id);
    await insert('b', a.id);
    await insert('c', root.id);
    const { rows } = await pool.query(
      `WITH RECURSIVE chain AS (
         SELECT id, id AS root FROM messages WHERE reply_to_message_id IS NULL AND pod_id = $1
         UNION ALL
         SELECT m.id, c.root FROM messages m JOIN chain c ON m.reply_to_message_id = c.id
       )
       SELECT count(DISTINCT root)::int AS roots, count(*)::int AS n FROM chain`,
      [POD],
    );
    expect(rows[0].roots).toBe(1);
    expect(rows[0].n).toBe(4);
  });
});
