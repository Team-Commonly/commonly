/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * TASK-513: the server's record chains on real PostgreSQL. Row locks,
 * unique constraints and transaction rollback are what keep a chain whole
 * across replicas, and pg-mem models none of them faithfully.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');
const { appendRecord, readRecordExport, BOARD_ACTOR } = require('../../services/recordService');
const { appendToChain, MAX_PAGE_LINES } = require('../../repositories/recordChainRepository');
const { verifyRecord } = require('../../vendor/seats/src/record/format');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATIONS = path.join(__dirname, '../../config/migrations');
const POD = '6a692a1be833c668acdb84cf';
const AGENT = { type: 'agent', id: '6a920d43b08dee6c42a81c9e', owner: '6a47891ee025ce2e0ca1d30b' };

real('record chains on real PostgreSQL', () => {
  let database;
  let pool;
  beforeEach(async () => {
    database = await createRealPgSchema();
    pool = database.pool;
  });
  afterEach(async () => {
    if (database) await database.close();
  });

  const kinds = (jsonl) => jsonl.trimEnd().split('\n').map((line) => JSON.parse(line));

  it('upgrades a populated 0001 schema without touching its rows', async () => {
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'record-0001-'));
    try {
      fs.copyFileSync(path.join(MIGRATIONS, '0001_legacy_schema.sql'), path.join(legacy, '0001_legacy_schema.sql'));
      expect(await runPgMigrations(pool, legacy)).toEqual(['0001_legacy_schema.sql']);
    } finally {
      fs.rmSync(legacy, { recursive: true, force: true });
    }
    await pool.query("INSERT INTO users (_id, username) VALUES ('u1', 'ana')");
    await pool.query("INSERT INTO pods (id, name, type, created_by) VALUES ('p1', 'Checkout', 'team', 'u1')");
    await pool.query("INSERT INTO messages (pod_id, user_id, content) VALUES ('p1', 'u1', 'kept')");

    expect(await runPgMigrations(pool)).toEqual(['0002_record_chains.sql']);
    expect((await pool.query('SELECT content FROM messages')).rows).toEqual([{ content: 'kept' }]);
    expect((await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^0001/), expect.stringMatching(/^0002/)]));
    expect(await appendRecord({ podId: POD, taskId: 'TASK-1' }, 'e', [{ kind: 'task.claimed', actor: AGENT }], pool))
      .toEqual({ appended: 1, duplicate: false });
  });

  describe('on the migrated schema', () => {
    beforeEach(async () => {
      await runPgMigrations(pool);
    });

    it('gives concurrent writers on one chain consecutive seqs, and the export verifies', async () => {
      const ref = { podId: POD, taskId: 'TASK-2' };
      const results = await Promise.all(Array.from({ length: 30 }, (_, index) => appendRecord(ref, `event-${index}`, [
        { kind: 'task.claimed', actor: AGENT, data: { leaseUntil: '2026-10-26T05:30:00.000Z' } },
      ], pool)));
      expect(results.every((r) => r.appended === 1)).toBe(true);
      const out = await readRecordExport(ref, pool);
      const verified = verifyRecord(out.jsonl);
      expect(verified).toMatchObject({ ok: true, entries: 30 });
      expect(out.head).toBe(verified.head);
      expect(kinds(out.jsonl).map((entry) => entry.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
      const chain = (await pool.query('SELECT head_seq, head_hash FROM record_chains')).rows;
      expect(chain).toEqual([{ head_seq: 30, head_hash: verified.head }]);
    });

    it('creates a new chain once when its first writers race', async () => {
      // Both racers can pass the chain-row insert's conflict check before
      // either commits; one round rarely shows it, forty almost always do.
      const results = [];
      for (let round = 0; round < 40; round += 1) {
        const ref = { podId: POD, taskId: `TASK-race-${round}` };
        // eslint-disable-next-line no-await-in-loop -- each round is its own race
        results.push(...await Promise.allSettled(Array.from({ length: 12 }, (_, index) => appendRecord(ref, `e-${index}`, [
          { kind: 'task.claimed', actor: AGENT },
        ], pool))));
      }
      const failures = results.filter((result) => result.status === 'rejected');
      expect(failures.map((result) => result.reason.message)).toEqual([]);
      const chains = (await pool.query('SELECT head_seq FROM record_chains')).rows;
      expect(chains).toHaveLength(40);
      expect(chains.every((row) => row.head_seq === 12)).toBe(true);
    });

    it('refuses a run id that already names another chain, and writes nothing', async () => {
      const build = () => ({ lines: ['{}'], headHash: '0'.repeat(64) });
      await appendToChain({ podId: POD, taskId: 'TASK-a' }, 'srv-shared', 'e-1', build, pool);
      await expect(appendToChain({ podId: POD, taskId: 'TASK-b' }, 'srv-shared', 'e-1', build, pool))
        .rejects.toThrow('run_id srv-shared belongs to another chain');
      expect((await pool.query('SELECT task_id FROM record_chains')).rows).toEqual([{ task_id: 'TASK-a' }]);
    });

    it('keeps two chains apart when their writes interleave', async () => {
      const a = { podId: POD, taskId: 'TASK-3' };
      const b = { podId: POD };
      await Promise.all(Array.from({ length: 10 }, (_, index) => appendRecord(index % 2 ? a : b, `e-${index}`, [
        { kind: index % 2 ? 'task.claimed' : 'tool.call', actor: AGENT, data: index % 2 ? {} : { toolCallId: `t${index}`, title: 'x' } },
      ], pool)));
      const [ta, tb] = await Promise.all([readRecordExport(a, pool), readRecordExport(b, pool)]);
      expect(verifyRecord(ta.jsonl)).toMatchObject({ ok: true, entries: 5 });
      expect(verifyRecord(tb.jsonl)).toMatchObject({ ok: true, entries: 5 });
      expect(kinds(tb.jsonl).every((entry) => entry.taskId === undefined && entry.podId === POD)).toBe(true);
      expect(ta.runId).not.toBe(tb.runId);
    });

    it('writes a redelivered event once, even when the deliveries race', async () => {
      const ref = { podId: POD, taskId: 'TASK-4' };
      // On a fresh chain the chain-row insert alone serializes the racers;
      // an existing chain is where only the row lock stands between them.
      await appendRecord(ref, 'seed', [{ kind: 'task.claimed', actor: AGENT }], pool);
      const results = await Promise.all(Array.from({ length: 8 }, () => appendRecord(ref, 'the-one-event', [
        { kind: 'task.claimed', actor: AGENT },
        { kind: 'task.done', actor: BOARD_ACTOR },
      ], pool)));
      expect(results.filter((r) => r.appended === 2)).toHaveLength(1);
      expect(results.filter((r) => r.duplicate)).toHaveLength(7);
      expect(verifyRecord((await readRecordExport(ref, pool)).jsonl)).toMatchObject({ ok: true, entries: 3 });
    });

    it('rolls back every line of an event when the head update fails, then accepts the retry', async () => {
      const ref = { podId: POD, taskId: 'TASK-5' };
      await appendRecord(ref, 'first', [{ kind: 'task.claimed', actor: AGENT }, { kind: 'task.released', actor: AGENT }], pool);
      await pool.query(`
        CREATE FUNCTION refuse_head() RETURNS trigger AS $$
        BEGIN IF NEW.head_seq > 2 THEN RAISE EXCEPTION 'head update refused'; END IF; RETURN NEW; END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER refuse_head BEFORE UPDATE ON record_chains FOR EACH ROW EXECUTE FUNCTION refuse_head();
      `);
      await expect(appendRecord(ref, 'second', [
        { kind: 'task.claimed', actor: AGENT },
        { kind: 'task.done', actor: BOARD_ACTOR },
      ], pool)).rejects.toThrow(/head update refused/);
      expect((await pool.query('SELECT count(*)::int AS n FROM record_lines')).rows[0].n).toBe(2);
      expect((await pool.query('SELECT head_seq FROM record_chains')).rows[0].head_seq).toBe(2);

      await pool.query('DROP TRIGGER refuse_head ON record_chains');
      expect(await appendRecord(ref, 'second', [
        { kind: 'task.claimed', actor: AGENT },
        { kind: 'task.done', actor: BOARD_ACTOR },
      ], pool)).toEqual({ appended: 2, duplicate: false });
      expect(verifyRecord((await readRecordExport(ref, pool)).jsonl)).toMatchObject({ ok: true, entries: 4 });
    });

    it('reads an unwritten chain as empty, and a missing store as an error', async () => {
      expect(await readRecordExport({ podId: POD, taskId: 'TASK-never' }, pool))
        .toEqual({
          runId: null, entries: 0, head: null, jsonl: '', nextAfter: null,
        });
      const { readChain, RecordStoreUnavailableError } = require('../../repositories/recordChainRepository');
      await expect(readChain({ podId: POD }, null)).rejects.toBeInstanceOf(RecordStoreUnavailableError);
    });

    it('reads a long chain in pages that each name the whole chain\'s head and join into one that verifies', async () => {
      const ref = { podId: POD, taskId: 'TASK-7' };
      const total = MAX_PAGE_LINES + 2;
      await appendRecord(ref, 'bulk', Array.from({ length: total }, () => ({ kind: 'task.claimed', actor: AGENT })), pool);

      // No cursor still reads one bounded page, never the whole history.
      const first = await readRecordExport(ref, pool);
      expect(kinds(first.jsonl)).toHaveLength(MAX_PAGE_LINES);
      expect(first).toMatchObject({ entries: total, nextAfter: MAX_PAGE_LINES });
      expect(kinds((await readRecordExport(ref, pool, { limit: MAX_PAGE_LINES * 5 })).jsonl)).toHaveLength(MAX_PAGE_LINES);

      const pages = [];
      let after = 0;
      while (after !== null) {
        // eslint-disable-next-line no-await-in-loop
        const page = await readRecordExport(ref, pool, { after, limit: 400 });
        expect(page).toMatchObject({ entries: total, head: first.head, runId: first.runId });
        pages.push(page.jsonl);
        after = page.nextAfter;
      }
      expect(pages.map((jsonl) => kinds(jsonl).length)).toEqual([400, 400, total - 800]);
      expect(kinds(pages[1])[0].seq).toBe(401);
      expect(verifyRecord(pages.join(''))).toMatchObject({ ok: true, entries: total, head: first.head });

      expect(await readRecordExport(ref, pool, { after: total, limit: 10 }))
        .toMatchObject({ entries: total, jsonl: '', nextAfter: null });
    });

    it('stores lines byte for byte, so an edited row fails verification', async () => {
      const ref = { podId: POD, taskId: 'TASK-6' };
      await appendRecord(ref, 'a', [{ kind: 'task.claimed', actor: AGENT }], pool);
      await appendRecord(ref, 'b', [{ kind: 'task.done', actor: BOARD_ACTOR }], pool);
      await pool.query("UPDATE record_lines SET line = replace(line, 'task.claimed', 'task.release') WHERE seq = 1");
      const result = verifyRecord((await readRecordExport(ref, pool)).jsonl);
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ seq: 2, reason: 'prev_mismatch' })]));
    });
  });
});
