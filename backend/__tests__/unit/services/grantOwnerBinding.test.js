/**
 * Grant owner binding. A grant's owner is fixed at mint from the row it was
 * minted against. An installation id is reusable, so a grant must never take
 * the owner of whoever holds that id later. The pure resolver is tested
 * directly; the backfill runs against memory Mongo with the real models.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { resolveGrantBinding, backfillGrantOwners } = require('../../../services/grantOwnerBinding');

const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbb02';
const ROW_A = 'aaaaaaaaaaaaaaaaaaaaaa01';
const ROW_B = 'aaaaaaaaaaaaaaaaaaaaaa02';
const T_MINT = new Date('2026-10-20T00:00:00.000Z');
const BEFORE = new Date('2026-10-19T00:00:00.000Z');
const AFTER = new Date('2026-10-21T00:00:00.000Z');

const row = (over = {}) => ({
  _id: ROW_A,
  type: 'github-app',
  installationId: 'install-1',
  createdBy: OWNER,
  createdAt: BEFORE,
  ...over,
});

describe('resolveGrantBinding (pure)', () => {
  test('a grant naming a row _id binds to that row and its owner', () => {
    const binding = resolveGrantBinding(
      { connectionId: ROW_A, createdAt: T_MINT },
      [row({ _id: ROW_A }), row({ _id: ROW_B, installationId: 'install-2', createdBy: OTHER })],
    );
    expect(binding).toEqual({ connectionRowId: ROW_A, ownerId: OWNER });
  });

  test('an installation id with one pre-mint row binds to that row', () => {
    const binding = resolveGrantBinding({ connectionId: 'install-1', createdAt: T_MINT }, [row()]);
    expect(binding).toEqual({ connectionRowId: ROW_A, ownerId: OWNER });
  });

  test('an installation id carried in config.installationId also binds', () => {
    const binding = resolveGrantBinding(
      { connectionId: 'install-1', createdAt: T_MINT },
      [row({ installationId: null, config: { installationId: 'install-1' } })],
    );
    expect(binding).toEqual({ connectionRowId: ROW_A, ownerId: OWNER });
  });

  // The changed-hands case from the ruling. Row A was removed (its grants were
  // revoked with it); row B later took the same installation id. A resolver
  // that read "the current holder" would bind the old grant to OTHER here.
  test('changed hands after mint: the new holder does not inherit the grant', () => {
    const binding = resolveGrantBinding(
      { connectionId: 'install-1', createdAt: T_MINT },
      [row({ _id: ROW_B, createdBy: OTHER, createdAt: AFTER })],
    );
    expect(binding).toBeNull();
  });

  test('two rows carrying the installation id is ambiguous and stays unbound', () => {
    const binding = resolveGrantBinding(
      { connectionId: 'install-1', createdAt: T_MINT },
      [row(), row({ _id: ROW_B, createdBy: OTHER })],
    );
    expect(binding).toBeNull();
  });

  test('no row carrying the installation id stays unbound', () => {
    expect(resolveGrantBinding({ connectionId: 'install-1', createdAt: T_MINT }, [])).toBeNull();
  });

  test('a row with no owner cannot bind an owner', () => {
    const binding = resolveGrantBinding(
      { connectionId: 'install-1', createdAt: T_MINT },
      [row({ createdBy: undefined, config: {} })],
    );
    expect(binding).toBeNull();
  });
});

describe('backfillGrantOwners (memory Mongo)', () => {
  let mongod;
  let RoomGrant;
  let Integration;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    RoomGrant = require('../../../models/RoomGrant');
    Integration = require('../../../models/Integration');
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    await RoomGrant.deleteMany({});
    await Integration.collection.deleteMany({});
  });

  // Raw inserts keep the fixture's createdAt; create() would stamp "now".
  const insertGrant = (over = {}) => RoomGrant.collection.insertOne({
    grantId: `grant_${Math.random().toString(36).slice(2)}`,
    connectionId: 'install-1',
    installationId: 'install-1',
    target: { kind: 'pod', id: 'aaaaaaaaaaaaaaaaaaaaaa09' },
    tools: [],
    writeMode: 'read',
    audience: [],
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    revokedAt: null,
    brokerId: 'broker-1',
    ownerId: null,
    connectionRowId: null,
    createdAt: T_MINT,
    updatedAt: T_MINT,
    ...over,
  });
  const insertRow = (over = {}) => Integration.collection.insertOne({
    type: 'github-app',
    status: 'connected',
    installationId: 'install-1',
    ...row(over),
  });

  test('changed hands after mint: the grant stays unbound and the new holder gets nothing', async () => {
    await insertRow({ _id: new mongoose.Types.ObjectId(ROW_A), createdBy: new mongoose.Types.ObjectId(OWNER), createdAt: BEFORE });
    const grantId = 'grant_changed_hands';
    await insertGrant({ grantId });
    // Row A is removed; the id is reused by a row created after the mint.
    await Integration.collection.deleteMany({ _id: new mongoose.Types.ObjectId(ROW_A) });
    await insertRow({ _id: new mongoose.Types.ObjectId(ROW_B), createdBy: new mongoose.Types.ObjectId(OTHER), createdAt: AFTER });

    const result = await backfillGrantOwners();

    expect(result).toEqual({ scanned: 1, bound: 0, unbound: 1 });
    const stored = await RoomGrant.findOne({ grantId }).lean();
    expect(stored.ownerId).toBeNull();
    expect(stored.connectionRowId).toBeNull();
  });

  test('a grant minted before its row existed binds to the row owner, once', async () => {
    await insertRow({ _id: new mongoose.Types.ObjectId(ROW_A), createdBy: new mongoose.Types.ObjectId(OWNER), createdAt: BEFORE });
    const grantId = 'grant_bindable';
    await insertGrant({ grantId });

    expect(await backfillGrantOwners()).toEqual({ scanned: 1, bound: 1, unbound: 0 });
    expect(await backfillGrantOwners()).toEqual({ scanned: 0, bound: 0, unbound: 0 });

    const stored = await RoomGrant.findOne({ grantId }).lean();
    expect(stored.ownerId).toBe(OWNER);
    expect(stored.connectionRowId).toBe(ROW_A);
  });

  test('a grant naming a row _id binds to that row, whatever a later row now holds', async () => {
    await insertRow({ _id: new mongoose.Types.ObjectId(ROW_A), createdBy: new mongoose.Types.ObjectId(OWNER), createdAt: BEFORE });
    const grantId = 'grant_by_row_id';
    await insertGrant({ grantId, connectionId: ROW_A, installationId: 'install-1' });
    // A later row exists under another installation id, owned by someone else.
    await insertRow({ _id: new mongoose.Types.ObjectId(ROW_B), installationId: 'install-2', createdBy: new mongoose.Types.ObjectId(OTHER), createdAt: AFTER });

    await backfillGrantOwners();

    const stored = await RoomGrant.findOne({ grantId }).lean();
    expect(stored.ownerId).toBe(OWNER);
    expect(stored.connectionRowId).toBe(ROW_A);
  });

  test('a grant naming a row _id whose row is gone stays unbound; the installation id is not a fallback', async () => {
    // Row A is removed. Row B reuses the installation id the grant also carries.
    await insertRow({ _id: new mongoose.Types.ObjectId(ROW_B), createdBy: new mongoose.Types.ObjectId(OTHER), createdAt: AFTER });
    const grantId = 'grant_row_gone';
    await insertGrant({ grantId, connectionId: ROW_A, installationId: 'install-1' });

    expect(await backfillGrantOwners()).toEqual({ scanned: 1, bound: 0, unbound: 1 });
    const stored = await RoomGrant.findOne({ grantId }).lean();
    expect(stored.ownerId).toBeNull();
  });
});
