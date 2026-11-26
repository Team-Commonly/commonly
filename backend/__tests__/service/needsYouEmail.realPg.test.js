/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 step 2 for NeedsYouEmail on real PostgreSQL: migration 0024 run
 * twice, then a dual claim, status changes, a click and a digest mark through
 * the real pgTableAdapter SQL ($exists and $in included), ending with verify
 * finding both stores equal, the hidden click token included.
 */
const fs = require('fs');
const path = require('path');
const { Types } = require('mongoose');

const mockDb = { pool: null };
jest.mock('../../config/db-pg', () => ({
  pool: { query: (...args) => mockDb.pool.query(...args) },
}));

const { createRealPgSchema } = require('../utils/realPgSchema');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const NeedsYouEmail = require('../../models/NeedsYouEmail');
const {
  needsYouEmailStore, claimNeedsYouEmail, setNeedsYouEmailStatus, findNeedsYouClick,
  markNeedsYouClicked, listUndigestedOverflow, markIncludedInDigest,
} = require('../../repositories/needsYouEmailRepository');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATION = fs.readFileSync(path.join(__dirname, '../../config/migrations/0024_needs_you_emails.sql'), 'utf8');
const ENV = 'STORE_MODE_NEEDS_YOU_EMAIL';
const at = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute));
// Obviously fake 48-hex tokens.
const token = (n) => `${'e'.repeat(40)}${String(n).padStart(8, '0')}`;

real('NeedsYouEmail on real PostgreSQL (ADR-034 step 2)', () => {
  let database;

  beforeAll(async () => {
    await setupMongoDb();
    await NeedsYouEmail.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDb.pool = database.pool;
    await database.pool.query(MIGRATION);
    await NeedsYouEmail.deleteMany({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    delete process.env[ENV];
    jest.restoreAllMocks();
    if (database) await database.close();
  });

  it('0024 is a no-op on a second run, with the item and the token unique', async () => {
    await database.pool.query(MIGRATION);
    const { rows } = await database.pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
        AND tablename = 'needs_you_emails' ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'needs_you_emails_attention_item_id', 'needs_you_emails_click_token', 'needs_you_emails_pkey',
      'needs_you_emails_recipient_user_id',
    ]);
    const insert = (id, item, clickToken) => database.pool.query(
      `INSERT INTO needs_you_emails (id, attention_item_id, recipient_user_id, click_token, status, pg_version)
        VALUES ($1, $2, 'u', $3, 'claimed', 1)`,
      [id, item, clickToken],
    );
    await insert('a', 'item-1', token(1));
    await expect(insert('b', 'item-1', token(2))).rejects.toMatchObject({ code: '23505' });
    await expect(insert('c', 'item-2', token(1))).rejects.toMatchObject({ code: '23505' });
  });

  it.each(['dual', 'pg-read'])('%s: claim, status, click and digest mark land in both stores, and verify agrees',
    async (mode) => {
      process.env[ENV] = mode;
      const recipient = new Types.ObjectId();
      const sentItem = new Types.ObjectId();
      const heldItems = [new Types.ObjectId(), new Types.ObjectId()];

      // Racing claims of one item: one wins.
      const racing = await Promise.all([1, 2, 3].map((n) => claimNeedsYouEmail({
        attentionItemId: sentItem, recipientUserId: recipient, clickToken: token(n),
      })));
      const sentId = racing.find(Boolean);
      expect(racing.filter(Boolean)).toHaveLength(1);
      const winner = await NeedsYouEmail.findById(sentId).select('+clickToken').lean();
      await setNeedsYouEmailStatus(sentId, { status: 'sent', sentAt: at(1) });
      const found = await findNeedsYouClick(winner.clickToken);
      expect(found).toEqual({ _id: sentId, attentionItemId: sentItem });
      expect(await markNeedsYouClicked(sentId, at(2))).toBe(true);
      expect(await markNeedsYouClicked(sentId, at(3))).toBe(false);

      const heldIds = [];
      for (const [i, item] of heldItems.entries()) {
        // eslint-disable-next-line no-await-in-loop
        const id = await claimNeedsYouEmail({
          attentionItemId: item, recipientUserId: recipient, clickToken: token(10 + i),
        });
        // eslint-disable-next-line no-await-in-loop
        await setNeedsYouEmailStatus(id, { status: 'overflow' });
        heldIds.push(id);
      }
      // The overflow read: on Postgres in pg-read, through $exists on included_in_digest_at.
      const query = jest.spyOn(database.pool, 'query');
      const listed = await listUndigestedOverflow(recipient);
      expect(listed.map((row) => String(row.attentionItemId)).sort()).toEqual(heldItems.map(String).sort());
      listed.forEach((row) => expect(Object.keys(row).sort()).toEqual(['_id', 'attentionItemId']));
      const pgReads = query.mock.calls.filter(([sql]) => /included_in_digest_at IS NULL/.test(sql));
      expect(pgReads).toHaveLength(mode === 'pg-read' ? 1 : 0);
      query.mockRestore();

      expect(await markIncludedInDigest([heldIds[0]], at(4))).toBe(1);
      expect(await markIncludedInDigest(heldIds, at(5))).toBe(1);
      expect(await listUndigestedOverflow(recipient)).toEqual([]);

      const { rows } = await database.pool.query(
        'SELECT * FROM needs_you_emails ORDER BY created_at, id',
      );
      expect(rows).toHaveLength(3);
      const sentRow = rows.find((row) => row.id === String(sentId));
      expect(sentRow).toMatchObject({
        attention_item_id: String(sentItem),
        recipient_user_id: String(recipient),
        click_token: winner.clickToken,
        status: 'sent',
        sent_at: at(1),
        clicked_at: at(2),
        included_in_digest_at: null,
        pg_version: 3,
      });
      expect(rows.find((row) => row.id === String(heldIds[0]))).toMatchObject({
        status: 'overflow', included_in_digest_at: at(4), pg_version: 3,
      });
      expect(rows.find((row) => row.id === String(heldIds[1]))).toMatchObject({
        status: 'overflow', included_in_digest_at: at(5), pg_version: 3,
      });
      const verified = await needsYouEmailStore().verify();
      expect(verified).toMatchObject({
        mongo: 3, pg: 3, missing: 0, differs: 0, extra: 0,
      });
      expect(verified.checksumPg).toBe(verified.checksumMongo);
    });
});
