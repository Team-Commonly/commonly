/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * D245: the message contract's columns on real PostgreSQL. pg-mem has its own
 * parser and type inference (review-checklist rule 55), so the migration and
 * the model's INSERT, SELECT and edit run here against a real server too.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

// The model reads `pool` from config/db-pg when it loads; this holder is filled
// with the test schema's pool before the model is required.
const mockDbPg = {};
jest.mock('../../config/db-pg', () => mockDbPg);

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATIONS = path.join(__dirname, '../../config/migrations');
const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const USER = 'bbbbbbbbbbbbbbbbbbbbbb01';

real('message contract columns on real PostgreSQL (D245)', () => {
  let database;
  let pool;
  let PGMessage;

  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    database = await createRealPgSchema();
    pool = database.pool;
    mockDbPg.pool = pool;
    // eslint-disable-next-line global-require -- loaded after the pool holder is filled
    jest.isolateModules(() => { PGMessage = require('../../models/pg/Message'); });
  });
  afterEach(async () => {
    if (database) await database.close();
  });

  const seed = async () => {
    await pool.query("INSERT INTO users (_id, username, is_bot) VALUES ($1, 'nova', true)", [USER]);
    await pool.query("INSERT INTO pods (id, name, type, created_by) VALUES ($1, 'Checkout', 'team', $2)", [POD, USER]);
  };

  it('upgrades a populated 0004 schema, keeping its rows with NULL summary and kind', async () => {
    const before = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-0004-'));
    try {
      fs.readdirSync(MIGRATIONS).filter((name) => name < '0005').forEach((name) => {
        fs.copyFileSync(path.join(MIGRATIONS, name), path.join(before, name));
      });
      await runPgMigrations(pool, before);
    } finally {
      fs.rmSync(before, { recursive: true, force: true });
    }
    await seed();
    await pool.query("INSERT INTO messages (pod_id, user_id, content) VALUES ($1, $2, 'kept')", [POD, USER]);

    expect(await runPgMigrations(pool)).toEqual(['0005_message_summary_kind.sql', '0006_message_receipt.sql', '0007_tool_call_caller_confinement.sql']);
    expect((await pool.query('SELECT content, summary, kind, receipt FROM messages')).rows)
      .toEqual([{
        content: 'kept', summary: null, kind: null, receipt: null,
      }]);
    expect(await runPgMigrations(pool)).toEqual([]);
  });

  describe('on the migrated schema', () => {
    beforeEach(async () => {
      await runPgMigrations(pool);
      await seed();
    });

    it('stores both fields and returns them on findById and findByPodId', async () => {
      const summary = `${'修'.repeat(119)}🙂`;
      const row = await PGMessage.create(
        POD, 
        USER, 
        'Fixed the redirect.', 
        'text',
        null, 
        null, 
        null, 
        null, 
        null, 
        { summary, kind: 'result' },
      );
      expect(row).toMatchObject({ summary, kind: 'result' });
      expect(await PGMessage.findById(String(row.id))).toMatchObject({ summary, kind: 'result' });
      const [listed] = await PGMessage.findByPodId(POD, 10);
      expect(listed).toMatchObject({ summary, kind: 'result' });
    });

    it('writes one field alone, and a plain post leaves both NULL', async () => {
      expect(await PGMessage.create(POD, USER, 'fyi', 'text', null, null, null, null, null, { summary: null, kind: 'fyi' }))
        .toMatchObject({ summary: null, kind: 'fyi' });
      expect(await PGMessage.create(POD, USER, 'plain', 'text'))
        .toMatchObject({ summary: null, kind: null });
    });

    it('keeps the reply guard with the extra columns in the INSERT', async () => {
      const root = await PGMessage.create(POD, USER, 'root', 'text');
      const reply = await PGMessage.create(
        POD, 
        USER, 
        'reply', 
        'text', 
        String(root.id), 
        null, 
        null, 
        null, 
        null,
        { summary: 'Answered', kind: 'answer' },
      );
      expect(reply).toMatchObject({ summary: 'Answered', kind: 'answer', thread_root_id: root.id });
    });

    it('stores a self-reported receipt as JSONB, returns it on both reads, and an edit clears it (D245 item 4)', async () => {
      const receipt = {
        adapter: 'claude', model: 'claude-opus-5-5', turns: 3, tools: ['Read', 'Bash'], durationMs: 41250, source: 'self-reported',
      };
      const row = await PGMessage.create(POD, USER, 'Done.', 'text', null, null, null, null, null, { receipt });
      expect(row.receipt).toEqual(receipt);
      expect((await PGMessage.findById(String(row.id))).receipt).toEqual(receipt);
      const [listed] = await PGMessage.findByPodId(POD, 10);
      expect(listed.receipt).toEqual(receipt);
      const { rows: [typed] } = await pool.query('SELECT jsonb_typeof(receipt) AS t FROM messages WHERE id = $1', [row.id]);
      expect(typed.t).toBe('object');
      expect((await PGMessage.update(String(row.id), 'Edited.')).receipt).toBeNull();
    });

    it('an edit clears the summary', async () => {
      const row = await PGMessage.create(
        POD, 
        USER, 
        'old', 
        'text', 
        null, 
        null, 
        null, 
        null, 
        null,
        { summary: 'The old claim', kind: 'result' },
      );
      expect(await PGMessage.update(String(row.id), 'new')).toMatchObject({ content: 'new', summary: null });
    });
  });
});
