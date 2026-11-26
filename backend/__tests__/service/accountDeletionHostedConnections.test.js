// F368: the sweep removes a deleted person's hosted connections, including one
// created after the receipt by a request that was already past auth.
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('../../config/db-pg', () => ({ pool: null }));
const mockDeleteOpenings = jest.fn().mockResolvedValue(0);
jest.mock('../../repositories/recordChainRepository', () => ({ deleteOpeningsFor: (...args) => mockDeleteOpenings(...args) }));
const mockDeletePrefix = jest.fn().mockResolvedValue(0);
jest.mock('../../services/objectStore', () => ({ getObjectStore: () => ({ deletePrefix: (...args) => mockDeletePrefix(...args) }) }));
const mockRemove = jest.fn();
jest.mock('../../services/connectionRemovalService', () => ({
  HOSTED_MCP_TYPE: 'hosted-mcp',
  removeConnection: (...args) => mockRemove(...args),
}));

const mongoose = require('mongoose');
const User = require('../../models/User');
const Integration = require('../../models/Integration');
const AccountDeletion = require('../../models/AccountDeletion');
const { sweepAccountDeletions } = require('../../services/accountDeletionService');
const { revokeConnectionGrants, SYSTEM_REVOKER } = require('../../services/roomGrantService');

const hostedRow = (createdBy, entryId) => Integration.create({
  type: 'hosted-mcp', scope: 'user', status: 'connected', createdBy, config: { entryId },
});

describe('the account deletion sweep and hosted connections (F368)', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await clearMongoDb();
    mockRemove.mockReset();
    // Stands in for the real removal: the row goes when the removal finishes.
    mockRemove.mockImplementation(async ({ connection }) => {
      await Integration.deleteOne({ _id: connection._id });
      return { removed: true, grantsRevoked: 0, revokeAt: 'https://vendor.example/apps', providerRevoked: true };
    });
  });

  it('removes a receipted person\'s connections, even one created after the receipt, and leaves others\' alone', async () => {
    const gone = new mongoose.Types.ObjectId();
    const other = await User.create({ username: 'kept-person', email: 'kept@example.test', password: 'Kept-person-123!' });
    await AccountDeletion.create({ _id: gone });
    // A connect that was already past auth lands after the receipt.
    const late = await hostedRow(gone, 'linear');
    const early = await hostedRow(gone, 'notion');
    const kept = await hostedRow(other._id, 'linear');

    await sweepAccountDeletions();

    expect(mockRemove).toHaveBeenCalledTimes(2);
    for (const [call] of mockRemove.mock.calls) {
      expect(call).toMatchObject({ removedBy: SYSTEM_REVOKER, revokeGrants: revokeConnectionGrants });
      expect(String(call.connection.createdBy)).toBe(String(gone));
    }
    expect(await Integration.exists({ _id: late._id })).toBeNull();
    expect(await Integration.exists({ _id: early._id })).toBeNull();
    expect(await Integration.exists({ _id: kept._id })).toBeTruthy();
  });

  it('retries a connection the vendor refused on the next round', async () => {
    const gone = new mongoose.Types.ObjectId();
    await AccountDeletion.create({ _id: gone });
    const row = await hostedRow(gone, 'linear');
    mockRemove.mockResolvedValueOnce({ removed: false, code: 'provider_revoke_failed', message: 'vendor down', grantsRevoked: 1 });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    await sweepAccountDeletions().catch(() => {});
    expect(await Integration.exists({ _id: row._id })).toBeTruthy();

    await sweepAccountDeletions();
    expect(mockRemove).toHaveBeenCalledTimes(2);
    expect(await Integration.exists({ _id: row._id })).toBeNull();
    error.mockRestore();
  });

  it('tries every connection even when one throws, and the receipt still rotates', async () => {
    const gone = new mongoose.Types.ObjectId();
    await AccountDeletion.create({ _id: gone });
    const first = await hostedRow(gone, 'linear');
    const second = await hostedRow(gone, 'notion');
    mockRemove.mockRejectedValueOnce(new Error('vendor exploded'));

    const failure = await sweepAccountDeletions().catch((error) => error);
    expect(failure.errors.map((e) => e.message).join(' ')).toMatch(/hosted connections not removed yet/);
    expect(mockRemove).toHaveBeenCalledTimes(2);
    // One of the two went through despite the other throwing first.
    expect(await Integration.countDocuments({ _id: { $in: [first._id, second._id] } })).toBe(1);
    expect((await AccountDeletion.findById(gone).lean()).lastSweptAt).toBeInstanceOf(Date);
  });

  it('runs the later steps when an earlier one keeps failing', async () => {
    const gone = new mongoose.Types.ObjectId();
    await AccountDeletion.create({ _id: gone });
    const row = await hostedRow(gone, 'linear');
    // The upload store is down for this round.
    mockDeletePrefix.mockRejectedValueOnce(new Error('store unavailable'));

    await expect(sweepAccountDeletions()).rejects.toThrow(/Account deletion cleanup failed/);
    // Record ids and connections still came off.
    expect(mockDeleteOpenings).toHaveBeenCalledWith(String(gone));
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(await Integration.exists({ _id: row._id })).toBeNull();
  });

  // F660: removeOwnedConnections reaches hosted rows only, so a GitHub-app
  // row the person shared with a pod kept its grants live. The sweep now ends
  // the person's pod grants in every pod, a DM room included; seat grants are
  // out of this scope and stay.
  it('ends the person\'s pod grants on every connection type, and no one else\'s', async () => {
    // eslint-disable-next-line global-require
    const RoomGrant = require('../../models/RoomGrant');
    const gone = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    const agent = new mongoose.Types.ObjectId();
    await AccountDeletion.create({ _id: gone });
    const grant = (ownerId, target) => RoomGrant.create({
      grantId: `grant_${new mongoose.Types.ObjectId()}`,
      connectionId: 'install-gh-1',
      installationId: 'install-gh-1',
      target,
      tools: ['github.list_issues'],
      writeMode: 'read',
      audience: [String(agent)],
      expiresAt: new Date(Date.now() + 3_600_000),
      brokerId: 'github-app',
      ownerId: String(ownerId),
    });
    const inPod = await grant(gone, { kind: 'pod', id: String(new mongoose.Types.ObjectId()) });
    const inDmRoom = await grant(gone, { kind: 'pod', id: String(new mongoose.Types.ObjectId()) });
    const seat = await grant(gone, { kind: 'seat', id: String(agent) });
    const othersGrant = await grant(other, { kind: 'pod', id: String(new mongoose.Types.ObjectId()) });

    await sweepAccountDeletions();

    const revokedAt = async (g) => (await RoomGrant.findOne({ grantId: g.grantId }).lean()).revokedAt;
    expect(await revokedAt(inPod)).toBeInstanceOf(Date);
    expect(await revokedAt(inDmRoom)).toBeInstanceOf(Date);
    expect(await revokedAt(seat)).toBeNull();
    expect(await revokedAt(othersGrant)).toBeNull();
  });
});
