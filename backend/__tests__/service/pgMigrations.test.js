/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');
const { waitFor } = require('../utils/testUtils');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
// Every migration that ships, in order. A new migration adds its name here, so
// two lanes claiming the same number conflict on this line.
const SHIPPED = ['0001_legacy_schema.sql', '0002_record_chains.sql', '0003_self_created_tables.sql',
  '0004_tool_call_provider_ref.sql', '0005_message_summary_kind.sql'];
// The three tables 0003 took over from runtime DDL, and every column each must
// end with (0004 adds tool_calls' provider columns). Shared by the fresh and the
// retrofit case: both must reach it.
const SELF_CREATED = {
  message_claims: ['message_id', 'pod_id', 'claimed_by', 'instance_id', 'expires_at', 'state',
    'declined_by', 'created_at', 'refusal_reason', 'refusal_status'],
  tool_call_budgets: ['grant_id', 'calls_used', 'window_started_at'],
  tool_calls: ['call_id', 'grant_id', 'pod_id', 'installation_id', 'agent_user_id', 'tool',
    'args_digest', 'occurred_at', 'outcome', 'reason', 'approval_id', 'duration_ms',
    'credential_owner_id', 'vendor_status', 'vendor_error', 'provider_repo', 'provider_ref'],
};
const COLUMNS_SQL = `SELECT column_name FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = $1`;
const INDEXES_SQL = 'SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1';
const columnsOf = async (pool, table) => (await pool.query(COLUMNS_SQL, [table]))
  .rows.map((row) => row.column_name).sort();
const indexesOf = async (pool, table) => (await pool.query(INDEXES_SQL, [table]))
  .rows.map((row) => row.indexname);
real('Postgres migrations: real DDL, rollback and competing boots', () => {
  let database;
  let pool;
  let directory;
  const write = (name, sql) => fs.writeFileSync(path.join(directory, name), sql);
  beforeEach(async () => {
    database = await createRealPgSchema();
    pool = database.pool;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-migration-real-'));
  });
  afterEach(async () => {
    if (database) await database.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('boots the shipped baseline on a fresh database and does not reapply it', async () => {
    expect(await runPgMigrations(pool)).toEqual(SHIPPED);
    const history = (await pool.query('SELECT * FROM schema_migrations')).rows;
    expect(history[0].applied_at).toBeInstanceOf(Date);
    expect(await runPgMigrations(pool)).toEqual([]);
    expect((await pool.query('SELECT * FROM schema_migrations')).rows).toEqual(history);
    // The application/backfill ledger has distinct semantics and is preserved.
    expect((await pool.query('SELECT * FROM migration_records')).rows).toEqual([]);
  });

  it('retrofits a populated pre-runner schema without dropping messages or ledger details', async () => {
    await pool.query(`
      CREATE TABLE pods (id VARCHAR(24) PRIMARY KEY, name VARCHAR(100) NOT NULL,
        type VARCHAR(50) NOT NULL, created_by VARCHAR(24) NOT NULL);
      CREATE TABLE users (_id VARCHAR(24) PRIMARY KEY, username VARCHAR(100) NOT NULL);
      CREATE TABLE messages (id SERIAL PRIMARY KEY, pod_id VARCHAR(24) REFERENCES pods(id),
        user_id VARCHAR(24) NOT NULL, content TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE migration_records (name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, details JSONB);
      INSERT INTO pods VALUES ('pod', 'kept', 'chat', 'user');
      INSERT INTO users VALUES ('user', 'peer');
      INSERT INTO messages (pod_id, user_id, content) VALUES ('pod', 'user', 'old message');
      INSERT INTO migration_records (name, details) VALUES ('thread-cutoff', '{"cutoff":"kept"}');
    `);
    expect(await runPgMigrations(pool)).toEqual(SHIPPED);
    expect((await pool.query('SELECT id, content, thread_root_id, freshness_revision FROM messages')).rows)
      .toEqual([{
        id: 1, content: 'old message', thread_root_id: null, freshness_revision: '0',
      }]);
    expect((await pool.query('SELECT is_bot FROM users')).rows).toEqual([{ is_bot: false }]);
    expect((await pool.query('SELECT details FROM migration_records')).rows).toEqual([{ details: { cutoff: 'kept' } }]);
    const inserted = await pool.query("INSERT INTO messages (pod_id,user_id,content) VALUES ('pod','user','new') RETURNING freshness_revision");
    expect(inserted.rows[0].freshness_revision).toBe('1');
  });

  it('creates the formerly self-created tables on a fresh database (0003)', async () => {
    expect(await runPgMigrations(pool)).toEqual(SHIPPED);
    const tables = Object.keys(SELF_CREATED);
    const actual = await Promise.all(tables.map((table) => columnsOf(pool, table)));
    expect(actual).toEqual(tables.map((table) => [...SELF_CREATED[table]].sort()));
    expect(await indexesOf(pool, 'message_claims')).toEqual(expect.arrayContaining([
      'idx_message_claims_pod', 'idx_message_claims_terminal_expiry',
    ]));
    expect(await indexesOf(pool, 'tool_calls')).toContain('idx_tool_calls_grant_at');
    // The defaults the CAS and the trail rely on, read back from a real row.
    await pool.query(`INSERT INTO message_claims (message_id, pod_id, claimed_by, expires_at)
      VALUES ('1', 'pod', 'seat', NOW())`);
    expect((await pool.query('SELECT instance_id, state, declined_by FROM message_claims')).rows)
      .toEqual([{ instance_id: 'default', state: 'claimed', declined_by: [] }]);
    await expect(pool.query(`INSERT INTO tool_calls (call_id, grant_id, agent_user_id, tool, args_digest, outcome)
      VALUES ('c', 'g', 'a', 't', '${'a'.repeat(64)}', 'bogus')`)).rejects.toThrow(/check/i);
    expect(await runPgMigrations(pool)).toEqual([]);
  });

  it('retrofits populated pre-retrofit message_claims and tool_calls without losing rows (0003)', async () => {
    // The ORIGINAL shapes, before decline handoff (state, declined_by), the
    // refusal record (refusal_*) and the trail's owner and vendor columns.
    // 0001's CREATE TABLE IF NOT EXISTS skips an existing tool_calls, so the
    // columns can only arrive through 0003's ALTERs.
    await pool.query(`
      CREATE TABLE message_claims (message_id TEXT PRIMARY KEY, pod_id TEXT NOT NULL,
        claimed_by TEXT NOT NULL, instance_id TEXT NOT NULL DEFAULT 'default',
        expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE tool_calls (call_id VARCHAR(255) PRIMARY KEY, grant_id VARCHAR(255) NOT NULL,
        pod_id VARCHAR(255), installation_id VARCHAR(255), agent_user_id VARCHAR(255) NOT NULL,
        tool VARCHAR(255) NOT NULL, args_digest CHAR(64) NOT NULL,
        occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        outcome VARCHAR(32) NOT NULL CHECK (outcome IN ('ok', 'refused', 'pending_approval', 'failed')),
        reason VARCHAR(255), approval_id VARCHAR(255), duration_ms INTEGER);
      INSERT INTO message_claims (message_id, pod_id, claimed_by, expires_at) VALUES ('7', 'pod', 'seat', NOW());
      INSERT INTO tool_calls (call_id, grant_id, agent_user_id, tool, args_digest, outcome)
        VALUES ('old-call', 'grant', 'agent', 'github.list_issues', '${'a'.repeat(64)}', 'ok');
    `);
    expect(await runPgMigrations(pool)).toEqual(SHIPPED);
    expect(await columnsOf(pool, 'message_claims')).toEqual([...SELF_CREATED.message_claims].sort());
    expect(await columnsOf(pool, 'tool_calls')).toEqual([...SELF_CREATED.tool_calls].sort());
    expect(await indexesOf(pool, 'message_claims')).toEqual(expect.arrayContaining([
      'idx_message_claims_pod', 'idx_message_claims_terminal_expiry',
    ]));
    expect((await pool.query(`SELECT message_id, state, declined_by, refusal_reason, refusal_status
      FROM message_claims`)).rows).toEqual([{
      message_id: '7', state: 'claimed', declined_by: [], refusal_reason: null, refusal_status: null,
    }]);
    expect((await pool.query(`SELECT call_id, credential_owner_id, vendor_status, vendor_error,
      provider_repo, provider_ref FROM tool_calls`)).rows).toEqual([{
      call_id: 'old-call', credential_owner_id: null, vendor_status: null, vendor_error: null,
      provider_repo: null, provider_ref: null,
    }]);
    expect(await runPgMigrations(pool)).toEqual([]);
  });

  it('rolls back both DDL and completion on failure, then retries only the failed migration', async () => {
    write('0001_first.sql', 'CREATE TABLE example (id INTEGER PRIMARY KEY); INSERT INTO example VALUES (7);');
    write('0002_upgrade.sql', 'ALTER TABLE example ADD COLUMN label TEXT; INSERT INTO missing_table VALUES (1);');
    await expect(runPgMigrations(pool, directory)).rejects.toThrow('missing_table');
    expect((await pool.query('SELECT * FROM example')).rows).toEqual([{ id: 7 }]);
    const first = (await pool.query('SELECT * FROM schema_migrations')).rows;
    expect(first.map((row) => row.version)).toEqual(['0001_first.sql']);
    write('0002_upgrade.sql', "ALTER TABLE example ADD COLUMN label TEXT; UPDATE example SET label = 'upgraded';");
    expect(await runPgMigrations(pool, directory)).toEqual(['0002_upgrade.sql']);
    expect((await pool.query('SELECT * FROM example')).rows).toEqual([{ id: 7, label: 'upgraded' }]);
    expect((await pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows[0]).toEqual(first[0]);
    expect(await runPgMigrations(pool, directory)).toEqual([]);
  });

  it('rolls back schema changes if writing the completion row fails', async () => {
    write('0001_first.sql', 'CREATE TABLE example (id INTEGER);');
    await runPgMigrations(pool, directory);
    await pool.query("ALTER TABLE schema_migrations ADD CONSTRAINT refuse_second CHECK (version <> '0002_second.sql')");
    write('0002_second.sql', 'ALTER TABLE example ADD COLUMN label TEXT;');
    await expect(runPgMigrations(pool, directory)).rejects.toThrow('refuse_second');
    await expect(pool.query('SELECT label FROM example')).rejects.toThrow('label');
    expect((await pool.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: '0001_first.sql' }]);
    await pool.query('ALTER TABLE schema_migrations DROP CONSTRAINT refuse_second');
    expect(await runPgMigrations(pool, directory)).toEqual(['0002_second.sql']);
  });

  it('serializes two boots despite an unrelated waiter and executes SQL once', async () => {
    write('0001_once.sql', 'CREATE TABLE once_only (id INTEGER); INSERT INTO once_only VALUES (1);');
    const blocker = await pool.connect();
    const lock = [1129270605, 504];
    const boots = [];
    const bootPids = [];
    // Observe each real checked-out connection without replacing its queries.
    const bootPool = {
      connect: async () => {
        const client = await pool.connect();
        bootPids.push(client.processID);
        return client;
      },
    };
    let unrelated;
    let outsiderPid;
    try {
      await blocker.query('SELECT pg_advisory_lock($1::integer, $2::integer)', lock);
      const outsider = await pool.connect();
      outsiderPid = outsider.processID;
      unrelated = outsider.query('SELECT pg_advisory_lock($1::integer, $2::integer)', lock)
        .then(() => outsider.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', lock))
        .finally(() => outsider.release());
      boots.push(runPgMigrations(bootPool, directory), runPgMigrations(bootPool, directory));
      // Observe both waiters in Postgres itself; no sleep-based timing claim.
      await waitFor(async () => {
        const result = await pool.query(`SELECT count(*) FILTER (WHERE pid = ANY($3::integer[]))::int AS own,
            count(*) FILTER (WHERE pid = $4::integer)::int AS outsider FROM pg_locks
          WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`, [...lock, bootPids, outsiderPid]);
        // Other Tier-1 workers share the lock even in separate schemas. Count
        // our two PIDs, and prove the extra waiter really is present too.
        return result.rows[0].own === 2 && result.rows[0].outsider === 1;
      });
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', lock);
      blocker.release();
      // Drain both even if the lock assertion fails, so cleanup never hangs.
      await Promise.allSettled([...boots, unrelated]);
    }
    // allSettled above is cleanup, not permission to hide the control failing.
    await unrelated;
    expect((await Promise.all(boots)).sort((a, b) => a.length - b.length)).toEqual([[], ['0001_once.sql']]);
    expect((await pool.query('SELECT * FROM once_only')).rows).toEqual([{ id: 1 }]);
    expect((await pool.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: '0001_once.sql' }]);
  });
});
