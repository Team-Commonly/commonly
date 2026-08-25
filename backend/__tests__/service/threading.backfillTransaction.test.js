/**
 * The backfill's UPDATE and its ledger INSERT are ONE transaction — executed.
 *
 * Tier 1 on purpose. The guard for this property in
 * `__tests__/unit/models/threadingCutoffRecord.test.js` is a token scan over a
 * slice of the script source, and @sprint-review measured what that misses:
 * gate the ledger INSERT on a never-true condition and every anchor stays put
 * (BEGIN, the UPDATE, the INSERT, COMMIT, ROLLBACK all still present, still in
 * order), both unit suites report 38/38 green, and the run leaves every chain
 * rooted with no cutoff recorded. That is verbatim the harm the transaction
 * guard's own comment names — so the guard is blind to the one failure it was
 * written for.
 *
 * It cannot be fixed at Tier 0: pg-mem rejects `WITH RECURSIVE` outright, which
 * `threading.derivation.test.js` already records. The backfill's CTE needs a
 * real server, so the atomicity property does too.
 *
 * Two directions, because "one transaction" is two claims:
 *   forward  — a successful run leaves BOTH the rooted rows and the ledger row
 *   backward — a run whose INSERT throws leaves NEITHER
 * A test of only the forward half passes against a script with no transaction
 * at all.
 */
const { Pool } = require('pg');

const RUN = process.env.INTEGRATION_TEST === 'true';
const d = RUN ? describe : describe.skip;

// `--apply` is read at module load (`const APPLY = process.argv.includes(...)`),
// so it has to be in place before the require below, not before the call.
if (!process.argv.includes('--apply')) process.argv.push('--apply');
// eslint-disable-next-line global-require
const { main, MIGRATION_NAME } = require('../../scripts/backfill-thread-root-id');

const POD = 'aaaaaaaaaaaaaaaaaaaaaa02';
const USER = 'bbbbbbbbbbbbbbbbbbbbbb02';

let pool;

const connect = () => new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: false,
});

const reset = async () => {
  await pool.query('DELETE FROM migration_records WHERE name = $1', [MIGRATION_NAME]);
  await pool.query('DELETE FROM messages WHERE pod_id = $1', [POD]);
  await pool.query(
    `INSERT INTO users (_id, username) VALUES ($1,'tester') ON CONFLICT (_id) DO NOTHING`, [USER],
  );
  await pool.query(
    `INSERT INTO pods (id, name, type, created_by) VALUES ($1,'P','chat',$2)
     ON CONFLICT (id) DO NOTHING`, [POD, USER],
  );
  const ins = async (replyTo, rootId, minutesAgo) => {
    const { rows } = await pool.query(
      `INSERT INTO messages (pod_id, user_id, content, reply_to_message_id, thread_root_id, created_at)
       VALUES ($1,$2,'m',$3,$4, NOW() - ($5 || ' minutes')::interval) RETURNING id`,
      [POD, USER, replyTo, rootId, String(minutesAgo)],
    );
    return rows[0].id;
  };
  // One already-rooted reply so CUTOFF_SQL takes the from_rooted branch —
  // without it the script needs --derivation-live and refuses to record.
  const liveRoot = await ins(null, null, 50);
  await ins(liveRoot, liveRoot, 40);
  // And an un-rooted chain for the backfill to actually repair.
  const oldRoot = await ins(null, null, 30);
  const a = await ins(oldRoot, null, 20);
  await ins(a, null, 10);
  return { oldRoot };
};

const unrootedCount = async () => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM messages
      WHERE pod_id = $1 AND reply_to_message_id IS NOT NULL AND thread_root_id IS NULL`, [POD],
  );
  return rows[0].n;
};

const ledgerRow = async () => {
  const { rows } = await pool.query(
    'SELECT details FROM migration_records WHERE name = $1', [MIGRATION_NAME],
  );
  return rows[0] || null;
};

d('the UPDATE and the ledger INSERT commit together or not at all', () => {
  beforeAll(() => { pool = connect(); });
  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM messages WHERE pod_id = $1', [POD]);
    await pool.query('DELETE FROM migration_records WHERE name = $1', [MIGRATION_NAME]);
    await pool.end();
  });

  beforeEach(async () => {
    await reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('FORWARD: a successful run leaves both the rooted rows and the ledger row', async () => {
    expect(await unrootedCount()).toBeGreaterThan(0);   // CONTROL: there was work
    await main(pool);
    expect(await unrootedCount()).toBe(0);
    const row = await ledgerRow();
    expect(row).not.toBeNull();
    // The mutant @sprint-review measured gates exactly this INSERT off. Every
    // text anchor survives it; this assertion does not.
    expect(row.details.rowsUpdated).toBeGreaterThan(0);
    expect(row.details).toHaveProperty('threadingCutoff');
  });

  it('BACKWARD: an INSERT that throws rolls the UPDATE back', async () => {
    const before = await unrootedCount();
    expect(before).toBeGreaterThan(0);

    // Wrap the pool so the ledger INSERT — and only it — fails. Everything
    // else, including BEGIN/ROLLBACK, goes to the real server, so this
    // exercises the script's own transaction rather than a simulated one.
    //
    // The patch is UNDONE on release. A pg client is pooled: assigning to
    // `client.query` mutates the object the pool hands out again, so without
    // this the poison outlives the test and every later checkout rejects its
    // ledger INSERT. That cost the next two cases in this file before it was
    // found, and it failed as a plausible product bug (no ledger row) rather
    // than as a broken fixture.
    const failingPool = {
      query: (...args) => pool.query(...args),
      connect: async () => {
        const client = await pool.connect();
        const realQuery = client.query.bind(client);
        const realRelease = client.release.bind(client);
        client.query = (...args) => {
          const sql = String(args[0]?.text || args[0]);
          if (/INSERT INTO migration_records/i.test(sql)) {
            return Promise.reject(new Error('simulated ledger write failure'));
          }
          return realQuery(...args);
        };
        client.release = (...args) => {
          delete client.query;
          delete client.release;
          return realRelease(...args);
        };
        return client;
      },
    };

    // NOT a rejection: main()'s outer catch logs and sets `process.exitCode`,
    // so a failed backfill surfaces as a non-zero exit, never as a thrown
    // promise. Asserting on the exit code is asserting the contract an
    // operator (and any CI wrapper) actually observes.
    process.exitCode = 0;
    await main(failingPool);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    // Neither half landed: the rows are still un-rooted and there is no record.
    expect(await unrootedCount()).toBe(before);
    expect(await ledgerRow()).toBeNull();
  });

  it('and a second run reports the recorded cutoff without re-measuring', async () => {
    await main(pool);
    const first = await ledgerRow();
    console.log.mockClear();
    await main(pool);
    const second = await ledgerRow();
    expect(second.details).toEqual(first.details);
    expect(console.log.mock.calls.map((c) => String(c[0])).join('\n'))
      .toContain('the boundary is not re-measured');
  });
});
