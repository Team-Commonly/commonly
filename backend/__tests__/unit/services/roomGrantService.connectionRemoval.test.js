// TASK-145 — removal's grants step (tools plan §10.5).
//
// A connection that is removed leaves grants pointing at it. Both removal
// paths (the installable tombstone and `DELETE /api/integrations/:id`) end the
// grants through this one helper, and it has to run before the connection row
// moves: the granter's revoke route resolves ownership through
// `findConnection` (routes/grants.ts:421), so a deleted row turns every
// remaining revoke into a 403.
//
// RoomGrant runs on memory Mongo; the connection is a plain object, because
// that is exactly what both callers have in hand.
// testUtils and the routers pull jsonwebtoken, whose Node-version-incompatible
// SlowBuffer dependency is irrelevant to these suites.
jest.mock('jsonwebtoken', () => ({}));

const mongoose = require('mongoose');

const RoomGrant = require('../../../models/RoomGrant');
const { revokeConnectionGrants } = require('../../../services/roomGrantService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const OWNER = new mongoose.Types.ObjectId().toString();
const OTHER_OWNER = new mongoose.Types.ObjectId().toString();
const CONNECTION = new mongoose.Types.ObjectId();
const OTHER_CONNECTION = new mongoose.Types.ObjectId();
const INSTALLATION = 'install-9f2';
const CONFIG_INSTALLATION = 'install-config-7a1';
const POD = new mongoose.Types.ObjectId().toString();

const connectionRow = () => ({
  _id: CONNECTION,
  installationId: INSTALLATION,
  config: { installationId: CONFIG_INSTALLATION },
});

const grantFixture = (overrides = {}) => ({
  grantId: new mongoose.Types.ObjectId().toString(),
  connectionId: String(CONNECTION),
  installationId: INSTALLATION,
  target: { kind: 'pod', id: POD },
  tools: ['github.list_issues'],
  writeMode: 'read',
  audience: [OWNER],
  expiresAt: new Date(Date.now() + 3_600_000),
  brokerId: 'github-app',
  ...overrides,
});

const live = async (grantId) => RoomGrant.findOne({ grantId }).lean();

describe('revokeConnectionGrants (removal ends the connection\'s grants)', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await RoomGrant.syncIndexes();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
  });

  it('revokes every grant addressed by any of the connection\'s three identifiers', async () => {
    // A connection is addressable three ways and a grant stores whichever
    // identifier it was minted with, so each fixture is reachable by exactly
    // one of them: dropping any single space leaves one grant behind.
    const onlyRowId = grantFixture({ connectionId: String(CONNECTION), installationId: 'install-none' });
    const onlyTopLevel = grantFixture({ connectionId: 'conn-none', installationId: INSTALLATION });
    const onlyConfig = grantFixture({ connectionId: 'conn-none-2', installationId: CONFIG_INSTALLATION });
    await RoomGrant.create([onlyRowId, onlyTopLevel, onlyConfig]);

    // The returned count alone cannot witness this: `revokeCascade` filters to
    // unrevoked rows and counts only what it moved, so 0 is equally satisfied by
    // "already revoked" and by "found none" (Vera 74459). The witness is the
    // post-state, with the pre-state read in the same test.
    const stillLive = () => RoomGrant.countDocuments({
      $or: [
        { connectionId: { $in: [String(CONNECTION)] } },
        { installationId: { $in: [INSTALLATION, CONFIG_INSTALLATION] } },
      ],
      revokedAt: null,
    });
    expect(await stillLive()).toBe(3);

    const revoked = await revokeConnectionGrants({ connection: connectionRow(), revokedBy: OWNER });

    expect(revoked).toBe(3);
    expect(await stillLive()).toBe(0);
    for (const grant of [onlyRowId, onlyTopLevel, onlyConfig]) {
      const row = await live(grant.grantId);
      expect(row.revokedAt).toBeInstanceOf(Date);
      expect(row.revokedBy).toBe(OWNER);
    }
  });

  it('cascades to an attenuated child of a grant on the same connection', async () => {
    const parent = grantFixture();
    const child = grantFixture({ parentGrantId: parent.grantId, tools: ['github.list_issues'] });
    await RoomGrant.create([parent, child]);

    const revoked = await revokeConnectionGrants({ connection: connectionRow(), revokedBy: OWNER });

    expect(revoked).toBe(2);
    expect((await live(child.grantId)).revokedAt).toBeInstanceOf(Date);
  });

  it('is idempotent: a second removal does not move the recorded revocation', async () => {
    const parent = grantFixture();
    await RoomGrant.create(parent);

    expect(await revokeConnectionGrants({ connection: connectionRow(), revokedBy: OWNER })).toBe(1);
    const first = await live(parent.grantId);

    expect(await revokeConnectionGrants({ connection: connectionRow(), revokedBy: OWNER })).toBe(0);
    const second = await live(parent.grantId);
    expect(second.revokedAt.getTime()).toBe(first.revokedAt.getTime());
    expect(second.revokedBy).toBe(OWNER);
  });

  it('leaves another connection\'s grants untouched', async () => {
    const mine = grantFixture();
    const theirs = grantFixture({
      connectionId: String(OTHER_CONNECTION),
      installationId: 'install-other',
      audience: [OTHER_OWNER],
    });
    await RoomGrant.create([mine, theirs]);

    expect(await revokeConnectionGrants({ connection: connectionRow(), revokedBy: OWNER })).toBe(1);

    const other = await live(theirs.grantId);
    expect(other.revokedAt).toBeNull();
    expect(other.revokedBy).toBeNull();
  });

  it('answers 0 for a connection with no addressable identifier and for one with no grants', async () => {
    expect(await revokeConnectionGrants({ connection: {}, revokedBy: OWNER })).toBe(0);
    expect(await revokeConnectionGrants({ connection: null, revokedBy: OWNER })).toBe(0);
    expect(await revokeConnectionGrants({
      connection: { _id: new mongoose.Types.ObjectId() },
      revokedBy: OWNER,
    })).toBe(0);
  });
});
