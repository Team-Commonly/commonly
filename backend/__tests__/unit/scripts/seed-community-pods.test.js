process.env.PG_HOST = '';

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test-jwt-token'),
  verify: jest.fn(),
}));

jest.mock('../../../models/pg/Pod', () => ({
  create: jest.fn(),
}));

const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const PGPod = require('../../../models/pg/Pod');
const { seedCommunityPods } = require('../../../scripts/seed-community-pods');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

describe('seed-community-pods', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
    jest.restoreAllMocks();
    jest.clearAllMocks();
    delete process.env.COMMUNITY_POD_ID;
    process.env.PG_HOST = '';
  });

  const seedHq = async () => {
    const owner = await User.create({
      username: 'community-seed-owner',
      email: 'community-seed-owner@example.com',
      password: 'hashed',
      verified: true,
    });
    const hq = await Pod.create({
      name: 'Commonly HQ',
      type: 'team',
      createdBy: owner._id,
      members: [owner._id],
    });
    process.env.COMMUNITY_POD_ID = String(hq._id);
    return { owner, hq };
  };

  it('defaults to dry-run and writes nothing', async () => {
    const { hq } = await seedHq();

    const result = await seedCommunityPods();

    expect(result).toEqual({
      apply: false,
      total: 2,
      existing: 0,
      wouldCreate: 2,
      created: 0,
      updated: 0,
    });
    expect(await Pod.countDocuments({ parentPod: hq._id })).toBe(0);
    expect(PGPod.create).not.toHaveBeenCalled();
  });

  it('creates both feedback Pods once and is a no-op when re-applied', async () => {
    const { owner, hq } = await seedHq();

    const first = await seedCommunityPods({ apply: true });
    const second = await seedCommunityPods({ apply: true });

    expect(first).toMatchObject({ created: 2, updated: 0, wouldCreate: 2 });
    expect(second).toMatchObject({ created: 0, updated: 0, wouldCreate: 0, existing: 2 });
    const children = await Pod.find({ parentPod: hq._id }).sort({ name: 1 }).lean();
    expect(children.map((pod) => pod.name)).toEqual(['Bug Reports', 'Feature Requests']);
    children.forEach((pod) => {
      expect(pod).toMatchObject({
        type: 'team',
        joinPolicy: 'open',
        publicRead: true,
        communityListed: true,
      });
      expect(String(pod.parentPod)).toBe(String(hq._id));
      expect(String(pod.createdBy)).toBe(String(owner._id));
      expect(pod.members.map(String)).toEqual([String(owner._id)]);
    });
  });

  it('aborts when the configured HQ Pod does not exist', async () => {
    process.env.COMMUNITY_POD_ID = '507f1f77bcf86cd799439011';

    await expect(seedCommunityPods({ apply: true }))
      .rejects.toThrow('Configured COMMUNITY_POD_ID Pod was not found');
    expect(await Pod.countDocuments()).toBe(0);
  });

  it('aborts when COMMUNITY_POD_ID is unset', async () => {
    delete process.env.COMMUNITY_POD_ID;

    await expect(seedCommunityPods())
      .rejects.toThrow('COMMUNITY_POD_ID is required');
    expect(await Pod.countDocuments()).toBe(0);
  });

  it('keeps Mongo seeds when the best-effort PostgreSQL mirror fails', async () => {
    const { hq } = await seedHq();
    process.env.PG_HOST = 'configured-for-test';
    PGPod.create.mockRejectedValue(new Error('postgres unavailable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await seedCommunityPods({ apply: true });

    expect(result.created).toBe(2);
    expect(await Pod.countDocuments({ parentPod: hq._id })).toBe(2);
    expect(PGPod.create).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      '[community-pod-seed] PostgreSQL mirror failed:',
      'postgres unavailable',
    );
  });
});
