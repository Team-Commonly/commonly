// F664: the read-only count of grants with no recorded owner, by target kind
// and status. Counts only, and owned grants are not counted.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const RoomGrant = require('../../../models/RoomGrant');
const { countUnownedGrants } = require('../../../scripts/count-unowned-grants');

const grant = (over = {}) => RoomGrant.create({
  grantId: `grant_${new mongoose.Types.ObjectId()}`,
  connectionId: 'conn-1',
  installationId: 'conn-1',
  target: { kind: 'seat', id: String(new mongoose.Types.ObjectId()) },
  tools: ['github.list_issues'],
  writeMode: 'read',
  audience: [String(new mongoose.Types.ObjectId())],
  expiresAt: new Date(Date.now() + 3_600_000),
  brokerId: 'github-app',
  ownerId: null,
  ...over,
});

describe('count-unowned-grants', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(clearMongoDb);

  it('counts unowned grants by target kind and status, and nothing owned', async () => {
    await grant();
    await grant();
    await grant({ target: { kind: 'pod', id: String(new mongoose.Types.ObjectId()) } });
    await grant({ revokedAt: new Date(), revokedBy: 'someone' });
    const expired = await grant();
    await RoomGrant.collection.updateOne({ grantId: expired.grantId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await grant({ ownerId: String(new mongoose.Types.ObjectId()) });

    const counts = await countUnownedGrants();

    expect(counts).toEqual([
      { kind: 'pod', status: 'live', count: 1 },
      { kind: 'seat', status: 'expired', count: 1 },
      { kind: 'seat', status: 'live', count: 2 },
      { kind: 'seat', status: 'revoked', count: 1 },
    ]);
    // Counts only: no ids of any kind in the output.
    expect(JSON.stringify(counts)).not.toMatch(/grant_|[a-f\d]{24}/);
  });
});
