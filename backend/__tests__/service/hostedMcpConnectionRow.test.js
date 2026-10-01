process.env.PG_HOST = '';

const mongoose = require('mongoose');
const Integration = require('../../models/Integration');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

// TASK-172's `hosted-mcp` row is the per-person Connection to a vendor-hosted
// MCP server (docs/plans/hosted-mcp-connection-scope.md §2). This test is the
// instrument for the three ways the RECORD can be wrong before any OAuth flow
// exists, and each is silent by construction:
//
//   1. `config` is a STRICT subdocument, so a path the schema does not declare
//      is dropped from a `$set` without an error. The keys at stake here are a
//      ConnectorSecret ref and the §10.3 fence's generation: a dropped
//      `credentialRef` is a `connected` row holding no token, and a dropped
//      `refreshGeneration` is a fence that lets a stale refresh write.
//   2. `podId` is required only when `scope: 'pod'`. A hosted-mcp row IS
//      per-person and carries no pod, so the conditional requirement is what
//      lets the row exist at all — the arm below fails the day that
//      requirement loses its condition.
//   3. The row is one per `(createdBy, config.entryId)`, and `entryId` itself
//      is required for THIS type. The index is PARTIAL: a non-partial unique
//      index over the same keys would refuse a second Slack row for one
//      person, which is the direction this type cannot fail. Required, so a
//      hosted row with no entry is refused by name rather than indexed as
//      `null` and refused as a duplicate entry (Vera, #1976 gate).

const OWNER_A = new mongoose.Types.ObjectId();
const OWNER_B = new mongoose.Types.ObjectId();
const ENTRY_A = 'linear';
const ENTRY_B = 'notion';

const shape = (overrides = {}) => ({
  scope: 'user',
  type: 'hosted-mcp',
  status: 'pending',
  createdBy: OWNER_A,
  config: { entryId: ENTRY_A, intake: 'oauth' },
  ...overrides,
});

// Every key the record carries (scope §2). Asserted one path at a time so a
// failure names the key that was dropped rather than the object that lost it.
const RECORD_KEYS = {
  'config.entryId': 'linear',
  'config.intake': 'oauth',
  'config.clientId': 'https://api.commonly.me/api/integrations/connect/hosted-mcp/linear/client-metadata',
  'config.providerSubject': 'subject-1',
  'config.grantedScope': 'read openid',
  'config.expiresAt': new Date('2026-09-27T15:00:00.000Z'),
  'config.credentialRef': 'secret-access-1',
  'config.refreshTokenRef': 'secret-refresh-1',
  'config.refreshGeneration': 3,
  'config.credentialHint': 'a…1',
  // The two keys the removal step writes. They were absent from this list when
  // they shipped, and absent from the schema's declaration too — which is how a
  // `$set` that mongoose drops in silence looked green everywhere else: the
  // removal suite asserts the payload handed to a MOCKED model, and a payload
  // arm cannot see a strict subdocument refuse it. Both are read back through
  // the raw collection here, so the mark exists on the row or this arm fails.
  'config.providerRevokedAt': new Date('2026-09-30T03:00:00.000Z'),
  'config.revokePage': 'https://linear.app/settings/security',
  'config.pendingAuth.state': 'state-1',
  'config.pendingAuth.codeVerifier': 'verifier-1',
  'config.pendingAuth.expiresAt': new Date('2026-09-27T14:30:00.000Z'),
};

const setAndRead = async (doc, path, value) => {
  await Integration.updateOne({ _id: doc._id }, { $set: { [path]: value } });
  const raw = await Integration.collection.findOne({ _id: doc._id });
  return path.split('.').reduce((node, key) => (node == null ? node : node[key]), raw);
};

describe('the hosted-mcp connection row', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await Integration.init();
  });

  // The rows below are the same person on the same entry on purpose, so a
  // leftover row from the previous test is a duplicate-key failure in the test
  // that did not plant it. Indexes survive `deleteMany` — the DB is dropped in
  // `closeMongoDb`, not here — so the uniqueness under test is still the one
  // mongod built in `beforeAll`.
  beforeEach(async () => {
    await Integration.deleteMany({});
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  test('a per-person row carries no pod and saves', async () => {
    const doc = await Integration.create(shape());

    expect(doc.type).toBe('hosted-mcp');
    expect(doc.scope).toBe('user');
    expect(doc.podId).toBeUndefined();
  });

  test('every key of the record survives a $set', async () => {
    const doc = await Integration.create(shape());

    const dropped = [];
    await Promise.all(Object.entries(RECORD_KEYS).map(async ([path, value]) => {
      const stored = await setAndRead(doc, path, value);
      const same = value instanceof Date
        ? stored instanceof Date && stored.getTime() === value.getTime()
        : stored === value;
      if (!same) dropped.push(`${path} → ${JSON.stringify(stored)}`);
    }));

    expect(dropped).toEqual([]);
  });

  test('the mark the removal step writes is really on the row', async () => {
    // The instrument above is generic; this arm names the consequence, because
    // the field it writes is the only record that a vendor revoke happened —
    // #2035 shipped it as server-owned and unwritable while the schema dropped
    // every write of it. Read through `defaultDeps()`, so the assertion is about
    // the shipped writer and not about a fixture.
    const { defaultDeps, PROVIDER_REVOKED_MARK } = require('../../services/connectionRemovalService');
    const doc = await Integration.create(shape());
    const at = new Date('2026-09-30T03:00:00.000Z');

    await defaultDeps().markProviderRevoked(String(doc._id), at);

    const raw = await Integration.collection.findOne({ _id: doc._id });
    expect(raw.config[PROVIDER_REVOKED_MARK]).toEqual(at);
  });

  test('positive control: the same instrument sees an undeclared key dropped', async () => {
    // Without this arm, "every key survives" would also pass if `$set` silently
    // did nothing, or if the reader never reached the document. `config` is a
    // strict subdocument — the trap this whole test exists for — so a key that
    // is NOT declared must come back undefined through the same code path.
    const doc = await Integration.create(shape());

    const stored = await setAndRead(doc, 'config.neverDeclaredKey', 'planted');

    expect(stored).toBeUndefined();
  });

  test('one row per (person, entry): a second row for the same entry is refused', async () => {
    await Integration.create(shape());

    const second = Integration.create(shape());
    await expect(second).rejects.toMatchObject({ code: 11000 });

    // A different entry is a different row, and a different person on the same
    // entry is a different row.
    await expect(Integration.create(shape({ config: { entryId: ENTRY_B, intake: 'oauth' } })))
      .resolves.toBeDefined();
    await expect(Integration.create(shape({ createdBy: OWNER_B }))).resolves.toBeDefined();
  });

  test('positive control: the index is PARTIAL, not a unique index on createdBy', async () => {
    // If the declaration lost `partialFilterExpression`, the unique key would
    // still be enforced on hosted-mcp rows and the arm above would keep
    // passing — so the arm that shows the difference is a same-person pair of
    // rows on a type the partial filter excludes. These must BOTH save.
    const owner = new mongoose.Types.ObjectId();

    await expect(Integration.create({
      scope: 'user', type: 'slack', status: 'connected', createdBy: owner,
      config: { teamId: 'T1', slackUserId: 'U1' },
    })).resolves.toBeDefined();
    await expect(Integration.create({
      scope: 'user', type: 'slack', status: 'connected', createdBy: owner,
      config: { teamId: 'T2', slackUserId: 'U2' },
    })).resolves.toBeDefined();
  });

  test('a hosted-mcp row with no entry is refused by name, not by the index', async () => {
    // The unique index is on `(createdBy, config.entryId)`, and a row with no
    // entry is indexed as `null` — so before this requirement, the SECOND such
    // row for one person arrived as an E11000 naming `config.entryId`: a
    // refusal that reports a duplicate entry to a writer whose two rows share
    // no entry at all, in the one direction this type was said not to fail in
    // (Vera, #1976 gate). It is refused at validation instead, so the failure
    // names the missing field. Nothing can create such a row today — the create
    // route refuses the type by name — which is why the declaration, and not a
    // caller nobody has written yet, is where it is closed.
    const noEntry = () => ({
      scope: 'user', type: 'hosted-mcp', status: 'pending', createdBy: OWNER_A,
      config: { intake: 'oauth' },
    });

    const first = await Integration.create(noEntry()).then(() => null, (error) => error);
    expect(first).toBeInstanceOf(mongoose.Error.ValidationError);
    expect(Object.keys(first.errors)).toContain('config.entryId');
    expect(first.code).not.toBe(11000);

    // The second attempt is the one that used to be the duplicate-key error.
    const second = await Integration.create(noEntry()).then(() => null, (error) => error);
    expect(second).toBeInstanceOf(mongoose.Error.ValidationError);
    expect(second.code).not.toBe(11000);
    expect(await Integration.countDocuments({ type: 'hosted-mcp' })).toBe(0);
  });

  test('a whitespace-only entry is refused, so the index cannot see two of one entry', async () => {
    // `trim` runs before validation, so `'   '` reaches `required` as `''` and
    // is refused by the same arm above. Without the trim it would be stored
    // verbatim: `(createdBy, '   ')` is a different key from
    // `(createdBy, 'linear')`, so one person's row for an entry could be born
    // twice under two strings that name the same entry.
    await expect(Integration.create(shape({ config: { entryId: '   ', intake: 'oauth' } })))
      .rejects.toBeInstanceOf(mongoose.Error.ValidationError);

    // The positive control for the trim itself: a padded entry is stored as the
    // entry, not as the padding.
    const padded = await Integration.create(shape({ config: { entryId: ' linear ', intake: 'oauth' } }));
    expect(padded.config.entryId).toBe(ENTRY_A);
  });

  test('positive control: the entry requirement is scoped to the type that has entries', async () => {
    // If `required` lost its condition, every connector row in the collection
    // would have to carry `config.entryId` — and Slack and Discord legitimately
    // have none, so half the collection could not be created. The condition is
    // the whole of the rule above, and this is the arm that sees it.
    const owner = new mongoose.Types.ObjectId();

    await expect(Integration.create({
      scope: 'user', type: 'slack', status: 'connected', createdBy: owner,
      config: { teamId: 'T-scoped', slackUserId: 'U-scoped' },
    })).resolves.toBeDefined();
  });

  test('the row carries neither key EITHER removal sweep selects on', async () => {
    // TASK-147, as a tripwire rather than a note. Two sweeps can remove a
    // connection row without running the shared revoke step, and each selects
    // on a field this row does not have: `podController.deletePod` filters
    // `Integration.deleteMany({ podId })` (podController.ts:730) and
    // `installableReconciler` selects on `installationId`
    // (:48, :86, :94, :127, :157, :190, :217, :240). A grant on a hosted row is
    // keyed by the row's own `_id` (grants.ts:310-316), so a sweep that reached
    // the row would strand that grant.
    //
    // What it does NOT cover, stated so a green here is not read as wider than
    // it is: the arm builds the row from the record's own shape, so it fires on
    // a SCHEMA change that stamps either field and NOT on a writer that adds
    // one to its payload. The writer's payload cannot be traced yet — the
    // hosted connect route refuses before it writes while `HOSTED_MCP_ENTRIES`
    // is empty, which is the same first-catalogue-entry trigger the row carries
    // for its witnesses. When that entry lands, this arm is the shape half and
    // the writer half is driven through the callback.
    //
    // The remedy, whenever it fires, is not to invert the assertion but to
    // route the row through the shared removal step in the sweep that now
    // reaches it.
    const doc = await Integration.create(shape());
    const raw = await Integration.collection.findOne({ _id: doc._id });

    expect(Object.keys(raw)).not.toContain('podId');
    expect(Object.keys(raw)).not.toContain('installationId');
    expect(raw.podId).toBeUndefined();
    expect(raw.installationId).toBeUndefined();
  });

  test('positive control: a duplicate on a declared unique index is observable', async () => {
    // The 11000 assertions above are only evidence if this connection can
    // produce one from an index unrelated to this type. `installationId` is
    // the one other declared unique index on this collection, and it is
    // TOP-LEVEL — `config.installationId` is a different field with no index,
    // so planting the value there (which this control did first) passes and
    // proves nothing about the connection's ability to see a duplicate.
    const owner = new mongoose.Types.ObjectId();
    const row = () => ({
      scope: 'pod',
      type: 'github-app',
      podId: new mongoose.Types.ObjectId(),
      createdBy: owner,
      installationId: 'inst-1',
      config: { owner: 'acme', repo: 'widgets' },
    });

    await Integration.create(row());

    await expect(Integration.create(row())).rejects.toMatchObject({ code: 11000 });
  });
});
