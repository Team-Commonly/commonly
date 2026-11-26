/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// ADR-034 step 2 for the per-ask needs-you email record. The repository's
// Postgres table is the in-memory adapter here; Mongo is real, so racing
// claims meet the production unique index on attentionItemId.
const mockPg = { current: null, options: null };
jest.mock('../../../repositories/dualStore', () => {
  const actual = jest.requireActual('../../../repositories/dualStore');
  const forward = (method) => (...args) => mockPg.current[method](...args);
  return {
    ...actual,
    pgTableAdapter: (options) => {
      mockPg.options = options;
      return {
        ...Object.fromEntries(['upsert', 'remove', 'replace', 'removeAt', 'get', 'scan', 'findWhere']
          .map((m) => [m, forward(m)])),
        presenceColumns: options.presenceColumns,
      };
    },
  };
});
const fs = require('fs');
const path = require('path');
const { Types } = require('mongoose');
const NeedsYouEmail = require('../../../models/NeedsYouEmail');
const {
  needsYouEmailStore, claimNeedsYouEmail, setNeedsYouEmailStatus, findNeedsYouClick,
  markNeedsYouClicked, listUndigestedOverflow, markIncludedInDigest,
} = require('../../../repositories/needsYouEmailRepository');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_NEEDS_YOU_EMAIL';
const at = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute));
let sequence = 0;
// Obviously fake 48-hex tokens.
const fakeToken = () => {
  sequence += 1;
  return `${'f'.repeat(40)}${String(sequence).padStart(8, '0')}`;
};
const newClaim = (recipientUserId = new Types.ObjectId()) => ({
  attentionItemId: new Types.ObjectId(), recipientUserId, clickToken: fakeToken(),
});

describe('needs-you email repository (ADR-034 step 2)', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await NeedsYouEmail.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await NeedsYouEmail.deleteMany({});
    mockPg.current = fakePg({ presenceColumns: ['clicked_at', 'included_in_digest_at'] });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The store's 5-second flag cache outlives a test; a repair pass on an
    // empty collection resets it, so each test starts unflagged.
    process.env[ENV] = 'dual';
    await needsYouEmailStore().repair();
    delete process.env[ENV];
    mockPg.current.calls.length = 0;
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  const raw = (id) => NeedsYouEmail.findById(id).select('+clickToken').lean();
  const rowOf = (id) => mockPg.current.rows.get(String(id));
  const upserts = () => mockPg.current.calls.filter((call) => call === 'upsert').length;
  // One email's whole life: claim, overflow, digest mark; or claim, sent, two clicks.
  const sentAndClicked = async (claim) => {
    const id = await claimNeedsYouEmail(claim);
    await setNeedsYouEmailStatus(id, { status: 'sent', sentAt: at(1) });
    const found = await findNeedsYouClick(claim.clickToken);
    const first = await markNeedsYouClicked(found._id, at(2));
    const second = await markNeedsYouClicked(found._id, at(3));
    return {
      id, found, first, second,
    };
  };

  it('declares the table, the id and the presence columns', () => {
    needsYouEmailStore();
    expect(mockPg.options).toMatchObject({
      table: 'needs_you_emails', idColumn: 'id', presenceColumns: ['clicked_at', 'included_in_digest_at'],
    });
  });

  it('names the columns 0024 creates, and nothing else, with the item and the token unique', () => {
    needsYouEmailStore();
    const sql = fs.readFileSync(path.join(__dirname, '../../../config/migrations/0024_needs_you_emails.sql'), 'utf8');
    const created = [...sql.matchAll(/^\s+([a-z_]+) (?:TEXT|INTEGER|TIMESTAMPTZ)/gm)].map((m) => m[1]);
    expect([mockPg.options.idColumn, ...mockPg.options.columns, 'pg_version'].sort()).toEqual(created.sort());
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS \w+\s+ON needs_you_emails \(attention_item_id\)/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS \w+\s+ON needs_you_emails \(click_token\)/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS \w+\s+ON needs_you_emails \(recipient_user_id\)/);
  });

  describe('mongo (the default)', () => {
    it('makes the pre-step-2 calls, with no markers and no Postgres call', async () => {
      const calls = [];
      const record = (method) => {
        const original = NeedsYouEmail[method];
        jest.spyOn(NeedsYouEmail, method).mockImplementation(function spy(...args) {
          calls.push([method, ...args.map((arg) => (arg && typeof arg === 'object' ? { ...arg } : arg))]);
          return original.apply(this, args);
        });
      };
      ['create', 'updateOne', 'findOne', 'find', 'updateMany'].forEach(record);
      const select = jest.spyOn(require('mongoose').Query.prototype, 'select');
      const claim = newClaim();

      const { id, found, first, second } = await sentAndClicked(claim);
      expect(found).toEqual({ _id: id, attentionItemId: claim.attentionItemId });
      expect([first, second]).toEqual([true, false]);
      const overflowClaim = newClaim(claim.recipientUserId);
      const overflowId = await claimNeedsYouEmail(overflowClaim);
      await setNeedsYouEmailStatus(overflowId, { status: 'overflow' });
      const held = await listUndigestedOverflow(claim.recipientUserId);
      expect(held).toEqual([{ _id: overflowId, attentionItemId: overflowClaim.attentionItemId }]);
      expect(await markIncludedInDigest([overflowId], at(9))).toBe(1);
      expect(await markIncludedInDigest([overflowId], at(10))).toBe(0);
      expect(await claimNeedsYouEmail(claim)).toBeNull();

      expect(calls).toEqual([
        ['create', { ...claim, status: 'claimed' }],
        ['updateOne', { _id: id }, { $set: { status: 'sent', sentAt: at(1) } }],
        ['findOne', { clickToken: claim.clickToken }],
        ['updateOne', { _id: id, clickedAt: { $exists: false } }, { $set: { clickedAt: at(2) } }],
        ['updateOne', { _id: id, clickedAt: { $exists: false } }, { $set: { clickedAt: at(3) } }],
        ['create', { ...overflowClaim, status: 'claimed' }],
        ['updateOne', { _id: overflowId }, { $set: { status: 'overflow' } }],
        ['find', {
          recipientUserId: claim.recipientUserId, status: 'overflow', includedInDigestAt: { $exists: false },
        }],
        ['updateMany', { _id: { $in: [overflowId] }, includedInDigestAt: { $exists: false } },
          { $set: { includedInDigestAt: at(9) } }],
        ['updateMany', { _id: { $in: [overflowId] }, includedInDigestAt: { $exists: false } },
          { $set: { includedInDigestAt: at(10) } }],
        ['create', { ...claim, status: 'claimed' }],
      ]);
      expect(select.mock.calls.map(([projection]) => projection))
        .toEqual(expect.arrayContaining(['+clickToken attentionItemId', '_id attentionItemId']));
      const doc = await raw(id);
      expect(doc).toMatchObject({ status: 'sent', sentAt: at(1), clickedAt: at(2) });
      expect(doc.pgVersion).toBeUndefined();
      expect(mockPg.current.calls).toEqual([]);
    });

    it('an empty digest mark makes no call', async () => {
      const updateMany = jest.spyOn(NeedsYouEmail, 'updateMany');
      expect(await markIncludedInDigest([], at(1))).toBe(0);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('passes through a claim error that is not a duplicate key', async () => {
      jest.spyOn(NeedsYouEmail, 'create').mockRejectedValueOnce(new Error('mongo down'));
      await expect(claimNeedsYouEmail(newClaim())).rejects.toThrow('mongo down');
    });
  });

  describe.each(['dual', 'pg-read'])('%s', (mode) => {
    beforeEach(() => { process.env[ENV] = mode; });

    it('gives the same answers and document as mongo, and copies each write once, token included', async () => {
      delete process.env[ENV];
      const mongoClaim = newClaim();
      const mongoRun = await sentAndClicked(mongoClaim);
      process.env[ENV] = mode;

      const claim = newClaim();
      const run = await sentAndClicked(claim);
      expect(run.found).toEqual({ _id: run.id, attentionItemId: claim.attentionItemId });
      expect([run.first, run.second]).toEqual([mongoRun.first, mongoRun.second]);
      expect(await claimNeedsYouEmail(claim)).toBeNull();

      const doc = await raw(run.id);
      const mongoDoc = await raw(mongoRun.id);
      const payload = ({
        _id: a, attentionItemId: b, recipientUserId: c, clickToken: d, createdAt: e, updatedAt: f,
        pgVersion: g, pgPending: h, __v: i, ...rest
      }) => rest;
      expect(payload(doc)).toEqual(payload(mongoDoc));
      // Claim, sent, first click: three versions and three copies; the second click writes nothing.
      expect(doc).toMatchObject({ pgVersion: 3, clickedAt: at(2), clickToken: claim.clickToken });
      expect(doc.pgPending).toBeUndefined();
      expect(upserts()).toBe(3);
      expect(rowOf(run.id)).toEqual({
        row: {
          id: String(run.id),
          attention_item_id: String(claim.attentionItemId),
          recipient_user_id: String(claim.recipientUserId),
          click_token: claim.clickToken,
          status: 'sent',
          sent_at: at(1),
          clicked_at: at(2),
          included_in_digest_at: null,
          created_at: doc.createdAt,
          updated_at: doc.updatedAt,
        },
        version: 3,
      });
      // The mongo-mode document was never copied.
      expect(await needsYouEmailStore().verify()).toMatchObject({
        mongo: 2, pg: 1, missing: 1, differs: 0, extra: 0,
      });
    });

    it('two concurrent claims of one attention item: exactly one claims, one document, one row', async () => {
      const claim = newClaim();
      const outcomes = await Promise.all([
        claimNeedsYouEmail(claim), claimNeedsYouEmail({ ...claim, clickToken: fakeToken() }),
      ]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const many = await Promise.all(Array.from({ length: 8 }, () => claimNeedsYouEmail({
        ...claim, clickToken: fakeToken(),
      })));
      expect(many.filter(Boolean)).toHaveLength(0);
      expect(await NeedsYouEmail.countDocuments({})).toBe(1);
      expect(mockPg.current.rows.size).toBe(1);
      expect(upserts()).toBe(1);
      expect(await needsYouEmailStore().verify()).toMatchObject({
        mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
      });
    });

    it('a failed copy after a claim still claims, with the marker for repair; a retry is already claimed', async () => {
      const claim = newClaim();
      mockPg.current.failNext('upsert');
      const id = await claimNeedsYouEmail(claim);
      expect(id).toBeTruthy();
      expect(await raw(id)).toMatchObject({ pgVersion: 1, pgPending: 1 });
      expect(mockPg.current.rows.size).toBe(0);
      expect(await claimNeedsYouEmail({ ...claim, clickToken: fakeToken() })).toBeNull();
      // A status change on top of the flagged claim copies the token with it.
      await setNeedsYouEmailStatus(id, { status: 'overflow' });
      expect(rowOf(id)).toMatchObject({ row: { status: 'overflow', click_token: claim.clickToken }, version: 2 });
      expect(await needsYouEmailStore().repair()).toMatchObject({ failed: 0 });
      expect(await needsYouEmailStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('a failed copy of a status change keeps the token, and repair copies it', async () => {
      const claim = newClaim();
      const id = await claimNeedsYouEmail(claim);
      mockPg.current.failNext('upsert');
      await setNeedsYouEmailStatus(id, { status: 'failed' });
      expect(await raw(id)).toMatchObject({ status: 'failed', pgVersion: 2, pgPending: 2 });
      expect(rowOf(id)).toMatchObject({ row: { status: 'claimed' }, version: 1 });
      expect(await needsYouEmailStore().repair()).toMatchObject({ copied: 1, failed: 0 });
      expect(rowOf(id)).toMatchObject({ row: { status: 'failed', click_token: claim.clickToken }, version: 2 });
    });

    it('the first click stamps once, even when two land together', async () => {
      const claim = newClaim();
      const id = await claimNeedsYouEmail(claim);
      await setNeedsYouEmailStatus(id, { status: 'sent', sentAt: at(1) });
      const before = upserts();
      const marks = await Promise.all([markNeedsYouClicked(id, at(2)), markNeedsYouClicked(id, at(3))]);
      expect(marks.filter(Boolean)).toHaveLength(1);
      expect(upserts() - before).toBe(1);
      const doc = await raw(id);
      expect(doc.pgVersion).toBe(3);
      expect(rowOf(id).row.clicked_at).toEqual(doc.clickedAt);
      expect(await markNeedsYouClicked(id, at(4))).toBe(false);
      expect((await raw(id)).clickedAt).toEqual(doc.clickedAt);
    });

    it('the click lookup reads Mongo and returns no token, even past a lagging row', async () => {
      const claim = newClaim();
      const id = await claimNeedsYouEmail(claim);
      // Another process's claim landed in Mongo with its copy lost, and this
      // process's flag cache says nothing is flagged.
      await listUndigestedOverflow(claim.recipientUserId);
      mockPg.current.rows.delete(String(id));
      mockPg.current.calls.length = 0;
      const found = await findNeedsYouClick(claim.clickToken);
      expect(found).toEqual({ _id: id, attentionItemId: claim.attentionItemId });
      expect(mockPg.current.calls).toEqual([]);
      expect(await findNeedsYouClick(fakeToken())).toBeNull();
    });

    it('the overflow list returns only _id and attentionItemId, never the token, from either store', async () => {
      const recipient = new Types.ObjectId();
      const held = newClaim(recipient);
      const heldId = await claimNeedsYouEmail(held);
      await setNeedsYouEmailStatus(heldId, { status: 'overflow' });
      const sentId = await claimNeedsYouEmail(newClaim(recipient));
      await setNeedsYouEmailStatus(sentId, { status: 'sent', sentAt: at(1) });
      const doneId = await claimNeedsYouEmail(newClaim(recipient));
      await setNeedsYouEmailStatus(doneId, { status: 'overflow' });
      await markIncludedInDigest([doneId], at(2));
      await setNeedsYouEmailStatus(await claimNeedsYouEmail(newClaim()), { status: 'overflow' });
      mockPg.current.calls.length = 0;

      const listed = await listUndigestedOverflow(recipient);
      expect(listed).toEqual([{ _id: heldId, attentionItemId: held.attentionItemId }]);
      expect(Object.keys(listed[0]).sort()).toEqual(['_id', 'attentionItemId']);
      expect(mockPg.current.calls.includes('findWhere')).toBe(mode === 'pg-read');
    });

    it('a failed Postgres overflow read falls back to Mongo, so the digest still has its answer', async () => {
      const recipient = new Types.ObjectId();
      const held = newClaim(recipient);
      const heldId = await claimNeedsYouEmail(held);
      await setNeedsYouEmailStatus(heldId, { status: 'overflow' });
      mockPg.current.failNext('findWhere');
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const listed = await listUndigestedOverflow(recipient);
        expect(listed).toEqual([{ _id: heldId, attentionItemId: held.attentionItemId }]);
        expect(Object.keys(listed[0]).sort()).toEqual(['_id', 'attentionItemId']);
        // dual reads Mongo first and never reaches Postgres; pg-read reaches it, fails, and reads Mongo.
        expect(warn).toHaveBeenCalledTimes(mode === 'pg-read' ? 1 : 0);
      } finally {
        warn.mockRestore();
      }
    });

    it('the digest mark changes only unmarked claims, each with its own version and one copy', async () => {
      const recipient = new Types.ObjectId();
      const ids = [];
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const id = await claimNeedsYouEmail(newClaim(recipient));
        // eslint-disable-next-line no-await-in-loop
        await setNeedsYouEmailStatus(id, { status: 'overflow' });
        ids.push(id);
      }
      expect(await markIncludedInDigest([ids[0]], at(1))).toBe(1);
      const before = upserts();
      expect(await markIncludedInDigest(ids, at(5))).toBe(2);
      expect(upserts() - before).toBe(2);
      expect((await raw(ids[0])).includedInDigestAt).toEqual(at(1));
      for (const id of ids.slice(1)) {
        // eslint-disable-next-line no-await-in-loop
        const doc = await raw(id);
        expect(doc).toMatchObject({ includedInDigestAt: at(5), pgVersion: 3 });
        expect(rowOf(id))
          .toMatchObject({ row: { included_in_digest_at: at(5), click_token: doc.clickToken }, version: 3 });
      }
      expect(await listUndigestedOverflow(recipient)).toEqual([]);
      expect(await needsYouEmailStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('backfill copies claims written before dual, token included, and verify agrees', async () => {
      delete process.env[ENV];
      const mongoClaim = newClaim();
      await sentAndClicked(mongoClaim);
      process.env[ENV] = mode;
      // A pre-dual document written directly, without timestamps or optional fields.
      const bare = { _id: new Types.ObjectId(), ...newClaim(), status: 'claimed' };
      await NeedsYouEmail.collection.insertOne(bare);
      const store = needsYouEmailStore();
      expect(await store.verify()).toMatchObject({ mongo: 2, pg: 0, missing: 2 });
      expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 2, inserted: 2 });
      expect(rowOf(bare._id)).toMatchObject({
        row: {
          click_token: bare.clickToken, sent_at: null, clicked_at: null, created_at: null, updated_at: null,
        },
        version: 0,
      });
      const verified = await store.verify();
      expect(verified).toMatchObject({
        mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
      });
      expect(verified.checksumPg).toBe(verified.checksumMongo);
      // A dual write on a backfilled claim lands at the next version.
      await setNeedsYouEmailStatus(bare._id, { status: 'overflow' });
      expect(rowOf(bare._id)).toMatchObject({ row: { status: 'overflow', click_token: bare.clickToken }, version: 1 });
      expect(await store.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });
  });

  it('pg: every write refuses until step 4, before any write', async () => {
    process.env[ENV] = 'pg';
    const id = new Types.ObjectId();
    await expect(claimNeedsYouEmail(newClaim())).rejects.toThrow(/not supported in pg mode until step 4/);
    await expect(setNeedsYouEmailStatus(id, { status: 'sent', sentAt: at(1) }))
      .rejects.toThrow(/not supported in pg mode until step 4/);
    await expect(markNeedsYouClicked(id)).rejects.toThrow(/not supported in pg mode until step 4/);
    await expect(markIncludedInDigest([id], at(1))).rejects.toThrow(/not supported in pg mode until step 4/);
    expect(await NeedsYouEmail.countDocuments({})).toBe(0);
    expect(mockPg.current.calls).toEqual([]);
  });
});
