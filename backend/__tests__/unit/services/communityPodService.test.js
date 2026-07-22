const Pod = require('../../../models/Pod');
const { ensureUserInCommunityPod } = require('../../../services/communityPodService');

jest.mock('../../../models/Pod', () => ({
  updateOne: jest.fn(),
}));

describe('communityPodService', () => {
  const originalCommunityPodId = process.env.COMMUNITY_POD_ID;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.COMMUNITY_POD_ID;
  });

  afterAll(() => {
    if (originalCommunityPodId === undefined) delete process.env.COMMUNITY_POD_ID;
    else process.env.COMMUNITY_POD_ID = originalCommunityPodId;
  });

  it('fails open without configuration and performs no write', async () => {
    await expect(ensureUserInCommunityPod('user-1')).resolves.toBeUndefined();
    expect(Pod.updateOne).not.toHaveBeenCalled();
  });

  it('adds membership idempotently with $addToSet', async () => {
    process.env.COMMUNITY_POD_ID = 'community-pod';
    Pod.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

    await ensureUserInCommunityPod('user-1');

    expect(Pod.updateOne).toHaveBeenCalledWith(
      { _id: 'community-pod' },
      { $addToSet: { members: 'user-1' } },
    );
  });

  it('swallows membership-write failures', async () => {
    process.env.COMMUNITY_POD_ID = 'community-pod';
    Pod.updateOne.mockRejectedValue(new Error('mongo unavailable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ensureUserInCommunityPod('user-1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[community-pod] membership update failed:',
      'mongo unavailable',
    );
  });
});
