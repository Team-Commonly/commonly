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
//   3. The row is one per `(createdBy, config.entryId)`. The index is PARTIAL:
//      a non-partial unique index over the same keys would refuse a second
//      Slack row for one person, which is the direction this type cannot fail.

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
  'config.providerSubject': 'subject-1',
  'config.grantedScope': 'read openid',
  'config.expiresAt': new Date('2026-09-27T15:00:00.000Z'),
  'config.credentialRef': 'secret-access-1',
  'config.refreshTokenRef': 'secret-refresh-1',
  'config.refreshGeneration': 3,
  'config.credentialHint': 'a…1',
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
