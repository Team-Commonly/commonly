// The census against stored grants rather than a mocked find: the query has to
// reach a seat-targeted grant through its `target.kind`/`target.id` filter and
// the hosted-MCP connection it names, and leave pods without the seat alone.
const mongoose = require('mongoose');
const Pod = require('../../models/Pod');
const RoomGrant = require('../../models/RoomGrant');
const Integration = require('../../models/Integration');
const { podsWithOutsiderWritableGrants } = require('../../services/nativeOutsiderGrantPolicy');
const { GRANT_BROKER_ID } = require('../../services/installable/toolInstallables');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');

const id = () => new mongoose.Types.ObjectId();
const model = (m) => m.default || m;

describe('outsider grant census', () => {
  const owner = id();
  const seat = id();
  const other = id();
  let withSeat;
  let alsoWithSeat;
  let withoutSeat;
  let connection;

  beforeAll(setupMongoDb);
  afterEach(clearMongoDb);
  afterAll(closeMongoDb);

  beforeEach(async () => {
    const pod = (members) => model(Pod).create({
      name: `census-${String(id())}`, type: 'team', createdBy: owner, members,
    });
    [withSeat, alsoWithSeat, withoutSeat] = await Promise.all([
      pod([owner, seat]), pod([seat]), pod([owner, other]),
    ]);
    connection = await model(Integration).create({
      type: 'hosted-mcp', scope: 'user', status: 'connected', createdBy: owner,
      config: { entryId: 'linear', intake: 'oauth', credentialRef: 'census-ref' },
    });
  });

  const seatGrant = (over = {}) => model(RoomGrant).create({
    grantId: `census-${String(id())}`, connectionId: String(connection._id), installationId: 'census',
    target: { kind: 'seat', id: String(seat) }, audience: [String(seat)], tools: ['linear.list_issues'],
    writeMode: 'read', expiresAt: new Date(Date.now() + 86400000), brokerId: GRANT_BROKER_ID, ...over,
  });
  const census = () => podsWithOutsiderWritableGrants([withSeat, alsoWithSeat, withoutSeat].map((p) => String(p._id)));

  test('a stored seat grant narrows every requested pod containing the seat, and no other', async () => {
    await seatGrant();
    expect(await census()).toEqual(new Set([String(withSeat._id), String(alsoWithSeat._id)]));
  });

  test('a revoked or expired seat grant narrows nothing', async () => {
    await seatGrant({ revokedAt: new Date() });
    await seatGrant({ expiresAt: new Date(Date.now() - 1000) });
    expect(await census()).toEqual(new Set());
  });
});
