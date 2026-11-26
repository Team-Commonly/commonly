// F664: deleting an account ends every grant the person owns (seat grants as
// well as pod grants) and removes their GitHub App repository connections,
// through the same removal the integrations route runs. Nobody else's grants
// or connections move, and a grant with no recorded owner is left as it was.
//
// User, Integration, RoomGrant and AccountDeletion run on memory Mongo.
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('../../config/db-pg', () => ({ pool: null }));
jest.mock('../../repositories/recordChainRepository', () => ({ deleteOpeningsFor: jest.fn().mockResolvedValue(0) }));
jest.mock('../../services/objectStore', () => ({ getObjectStore: () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }) }));
jest.mock('../../services/brokerRecordService', () => ({
  recordBrokerCall: jest.fn(), recordApprovalOutcome: jest.fn(),
  recordGrantExpired: jest.fn(), recordGrantsRevoked: jest.fn(), recordGrantIssued: jest.fn(),
}));

const mongoose = require('mongoose');
const User = require('../../models/User');
const Integration = require('../../models/Integration');
const RoomGrant = require('../../models/RoomGrant');
const AccountDeletion = require('../../models/AccountDeletion');
const { sweepAccountDeletions } = require('../../services/accountDeletionService');
const { SYSTEM_REVOKER } = require('../../services/roomGrantService');

const githubRow = (createdBy, repo) => Integration.create({
  type: 'github-app',
  scope: 'user',
  status: 'connected',
  createdBy,
  isActive: true,
  config: { app: 'connect', installationId: '4242', owner: 'acme', repo, repoKey: `acme/${repo}` },
});

const grantOn = (connection, ownerId, target) => RoomGrant.create({
  grantId: `grant_${new mongoose.Types.ObjectId()}`,
  connectionId: String(connection._id),
  installationId: String(connection._id),
  connectionRowId: String(connection._id),
  target,
  tools: ['github.list_issues'],
  writeMode: 'read',
  audience: [target.kind === 'seat' ? target.id : String(new mongoose.Types.ObjectId())],
  expiresAt: new Date(Date.now() + 3_600_000),
  brokerId: 'github-app',
  ownerId: ownerId === null ? null : String(ownerId),
});

const row = (grant) => RoomGrant.findOne({ grantId: grant.grantId }).lean();

describe('account deletion ends the person\'s seat grants and GitHub connections (F664)', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(clearMongoDb);

  it('revokes their seat and pod grants and removes their GitHub connection; others are untouched', async () => {
    const gone = new mongoose.Types.ObjectId();
    const other = await User.create({ username: 'kept-person', email: 'kept@example.test', password: 'Kept-person-123!' });
    const seatId = String(new mongoose.Types.ObjectId());
    await AccountDeletion.create({ _id: gone });

    const theirRow = await githubRow(gone, 'theirs');
    const otherRow = await githubRow(other._id, 'kept');
    const seat = await grantOn(theirRow, gone, { kind: 'seat', id: seatId });
    const pod = await grantOn(theirRow, gone, { kind: 'pod', id: String(new mongoose.Types.ObjectId()) });
    const othersSeat = await grantOn(otherRow, other._id, { kind: 'seat', id: seatId });
    const othersPod = await grantOn(otherRow, other._id, { kind: 'pod', id: String(new mongoose.Types.ObjectId()) });

    await sweepAccountDeletions();

    for (const grant of [seat, pod]) {
      // eslint-disable-next-line no-await-in-loop
      const ended = await row(grant);
      expect(ended.revokedAt).toBeInstanceOf(Date);
      expect(ended.revokedBy).toBe(SYSTEM_REVOKER);
      expect(ended.revocationReason).toBe('owner_deleted');
    }
    expect(await Integration.exists({ _id: theirRow._id })).toBeNull();

    expect((await row(othersSeat)).revokedAt).toBeNull();
    expect((await row(othersPod)).revokedAt).toBeNull();
    const kept = await Integration.findById(otherRow._id).lean();
    expect(kept).toMatchObject({ status: 'connected' });
  });

  it('leaves a grant with no recorded owner exactly as it was', async () => {
    const gone = new mongoose.Types.ObjectId();
    await AccountDeletion.create({ _id: gone });
    const other = await User.create({ username: 'row-owner', email: 'row-owner@example.test', password: 'Row-owner-123!' });
    const connection = await githubRow(other._id, 'unbound');
    const unbound = await grantOn(connection, null, { kind: 'seat', id: String(new mongoose.Types.ObjectId()) });
    const before = await row(unbound);

    await sweepAccountDeletions();

    expect(await row(unbound)).toEqual(before);
  });

  it('a failed grant revoke is logged and swallowed, and the deletion goes on', async () => {
    const gone = new mongoose.Types.ObjectId();
    await AccountDeletion.create({ _id: gone });
    const row = await githubRow(gone, 'revoke-fails');
    // The first grant read in the round is endOwnerGrants'.
    const find = jest.spyOn(RoomGrant, 'find').mockImplementationOnce(() => { throw new Error('db blip'); });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(sweepAccountDeletions()).resolves.toBeUndefined();
      expect(log.mock.calls.some((call) => String(call[0]).includes('account-deletion revoke failed'))).toBe(true);
      // The later step still ran.
      expect(await Integration.exists({ _id: row._id })).toBeNull();
    } finally {
      find.mockRestore();
      log.mockRestore();
    }
  });
});
