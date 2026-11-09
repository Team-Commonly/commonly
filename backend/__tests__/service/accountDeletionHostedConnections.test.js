// F368: the sweep removes a deleted person's hosted connections, including one
// created after the receipt by a request that was already past auth.
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('../../config/db-pg', () => ({ pool: null }));
jest.mock('../../repositories/recordChainRepository', () => ({ deleteOpeningsFor: jest.fn().mockResolvedValue(0) }));
jest.mock('../../services/objectStore', () => ({ getObjectStore: () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }) }));
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
});
