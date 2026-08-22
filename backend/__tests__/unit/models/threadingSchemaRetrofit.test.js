/**
 * schema.sql must reach an EXISTING database, not only a fresh one
 * (W-T, TASK-029, 1/4).
 *
 * The bug this exists for was live in #1106 and would have broken chat posting
 * on every existing instance. `thread_root_id` was declared only inside
 * `CREATE TABLE IF NOT EXISTS messages`, which is a no-op where the table
 * already exists — so the column would never have been created, the index
 * would have thrown at boot, and every PGMessage.create INSERT would have
 * named a column that does not exist.
 *
 * Nothing I ran could catch it. The unit tests read the DDL as text and saw a
 * column declaration; the tier-1 suite provisions a FRESH postgres:16 per CI
 * run, so it exercises the CREATE path and never the ALTER path. Both were
 * green. It was found by @sprint-review's caveat that CREATE TABLE IF NOT
 * EXISTS cannot retrofit a constraint — the same sentence applies to columns,
 * and I had verified the FK claim without noticing the column claim rode on it.
 *
 * So this suite starts from the OLD table shape and applies the schema on top.
 * That is the only arrangement in which the defect is visible.
 */
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const SCHEMA = fs.readFileSync(path.join(__dirname, '../../../config/schema.sql'), 'utf8');

// The messages table as it existed BEFORE threading — what a real instance has.
const OLD_MESSAGES = `
  CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    pod_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    content TEXT,
    message_type VARCHAR(50) DEFAULT 'text',
    reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`;

const columnsOf = async (pool, table) => {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}'`,
  );
  return rows.map((r) => r.column_name);
};

// pg-mem cannot run all of schema.sql (extensions, some DDL), so apply only the
// statements that matter here: the retrofit ALTERs. Extracting them by pattern
// is deliberate — it means a retrofit that is never written is a retrofit this
// test cannot find, which is exactly the failure being guarded.
const alters = SCHEMA.split('\n')
  .filter((l) => /^ALTER TABLE messages ADD COLUMN IF NOT EXISTS/i.test(l.trim()))
  .map((l) => l.trim());
const multiLineAlters = [...SCHEMA.matchAll(/ALTER TABLE messages\s*\n\s*ADD COLUMN IF NOT EXISTS[^;]*;/gi)]
  .map((m) => m[0].replace(/\s+/g, ' '));

describe('every late column on messages is retrofitted, not just declared', () => {
  test('thread_root_id has an ALTER — the CREATE TABLE alone cannot reach an existing instance', () => {
    const all = [...alters, ...multiLineAlters].join('\n');
    expect(all).toMatch(/thread_root_id/);
  });

  test('applied to a PRE-EXISTING messages table, the column appears', async () => {
    // The discriminating case. On a fresh database the CREATE TABLE supplies
    // the column and this passes for the wrong reason, which is precisely how
    // the defect survived CI.
    const db = newDb();
    const pool = new (db.adapters.createPg().Pool)();
    await pool.query(OLD_MESSAGES);
    expect(await columnsOf(pool, 'messages')).not.toContain('thread_root_id');

    for (const stmt of [...alters, ...multiLineAlters]) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(stmt);
    }

    expect(await columnsOf(pool, 'messages')).toContain('thread_root_id');
  });

  test('CONTROL: the old shape genuinely lacks it, so the test above measures something', async () => {
    const db = newDb();
    const pool = new (db.adapters.createPg().Pool)();
    await pool.query(OLD_MESSAGES);
    const cols = await columnsOf(pool, 'messages');
    expect(cols).toContain('reply_to_message_id');
    expect(cols).not.toContain('thread_root_id');
  });

  test('the retrofits are idempotent — boot DDL runs on every start', async () => {
    const db = newDb();
    const pool = new (db.adapters.createPg().Pool)();
    await pool.query(OLD_MESSAGES);
    for (let i = 0; i < 3; i += 1) {
      for (const stmt of [...alters, ...multiLineAlters]) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query(stmt);
      }
    }
    expect(await columnsOf(pool, 'messages')).toContain('thread_root_id');
  });

  test('the index on thread_root_id is created AFTER the retrofit that adds it', () => {
    // Ordering is load-bearing: CREATE INDEX on a column that does not exist
    // yet throws at boot, taking the whole backend down rather than degrading.
    const alterAt = SCHEMA.search(/ADD COLUMN IF NOT EXISTS thread_root_id/i);
    const indexAt = SCHEMA.indexOf('idx_messages_thread_root_id ON messages(thread_root_id)');
    expect(alterAt).toBeGreaterThan(-1);
    expect(indexAt).toBeGreaterThan(alterAt);
  });
});
