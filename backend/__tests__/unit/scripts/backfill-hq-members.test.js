const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const { backfillHqMembers } = require('../../../scripts/backfill-hq-members');

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test-jwt-token'),
  verify: jest.fn(),
}));
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

describe('backfill-hq-members', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
    jest.restoreAllMocks();
    delete process.env.COMMUNITY_POD_ID;
  });

  const seed = async () => {
    const existing = await User.create({
      username: 'existing-human',
      email: 'existing@example.com',
      password: 'hashed',
      verified: true,
    });
    const newcomer = await User.create({
      username: 'new-human',
      email: 'new@example.com',
      password: 'hashed',
      verified: true,
    });
    const bot = await User.create({
      username: 'community-bot',
      email: 'bot@example.com',
      password: 'hashed',
      verified: true,
      isBot: true,
    });
    const unverified = await User.create({
      username: 'unverified-human',
      email: 'unverified@example.com',
      password: 'hashed',
      verified: false,
    });
    const pod = await Pod.create({
      name: 'Commonly HQ',
      type: 'chat',
      createdBy: existing._id,
      members: [existing._id],
    });
    process.env.COMMUNITY_POD_ID = String(pod._id);
    return {
      existing, newcomer, bot, unverified, pod,
    };
  };

  it('defaults to dry-run and mutates nothing', async () => {
    const { pod, newcomer } = await seed();

    const result = await backfillHqMembers();

    expect(result).toMatchObject({
      apply: false,
      totalVerifiedHumans: 2,
      alreadyMembers: 1,
      wouldAdd: 1,
    });
    const fresh = await Pod.findById(pod._id);
    expect(fresh.members.map(String)).not.toContain(String(newcomer._id));
  });

  it('applies idempotently and excludes bots and unverified users', async () => {
    const {
      existing, newcomer, bot, unverified, pod,
    } = await seed();
    const find = jest.spyOn(User, 'find');

    const first = await backfillHqMembers({ apply: true });
    const second = await backfillHqMembers({ apply: true });

    expect(find).toHaveBeenCalledWith({ verified: true, isBot: { $ne: true } });
    expect(first).toMatchObject({ totalVerifiedHumans: 2, alreadyMembers: 1, wouldAdd: 1 });
    expect(second).toMatchObject({ totalVerifiedHumans: 2, alreadyMembers: 2, wouldAdd: 0 });

    const fresh = await Pod.findById(pod._id);
    const memberIds = fresh.members.map(String);
    expect(memberIds).toEqual(expect.arrayContaining([String(existing._id), String(newcomer._id)]));
    expect(memberIds).not.toContain(String(bot._id));
    expect(memberIds).not.toContain(String(unverified._id));
    expect(memberIds.filter((id) => id === String(newcomer._id))).toHaveLength(1);
  });
});
