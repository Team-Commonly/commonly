jest.mock('../../../models/Pod', () => ({
  find: jest.fn(),
}));
jest.mock('../../../models/User', () => ({}));
jest.mock('../../../models/Activity', () => ({
  getPendingApprovals: jest.fn(),
}));
jest.mock('../../../models/Summary', () => ({}));
jest.mock('../../../models/Post', () => ({}));

const ActivityService = require('../../../services/activityService');
const Pod = require('../../../models/Pod');
const Activity = require('../../../models/Activity');

const podFindResult = (rows) => ({
  select: jest.fn(() => ({
    lean: jest.fn().mockResolvedValue(rows),
  })),
});

describe('ActivityService.getPendingApprovals', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('queries only pods created by the queue owner', async () => {
    const ownerUserId = 'queue-owner';
    Pod.find.mockReturnValue(podFindResult([{ _id: 'owner-pod' }]));
    Activity.getPendingApprovals.mockResolvedValue([{ _id: 'approval-1' }]);

    await expect(ActivityService.getPendingApprovals(ownerUserId)).resolves.toEqual([
      { _id: 'approval-1' },
    ]);

    // ADR-020 D3 and TASK-095 v1.4 keep this legacy queue owner-scoped. Do
    // not reintroduce the removed members.role branch: Pod.members is an
    // ObjectId[] and has no role-bearing member objects.
    expect(Pod.find).toHaveBeenCalledWith({ createdBy: ownerUserId });
    expect(Activity.getPendingApprovals).toHaveBeenCalledWith(['owner-pod']);
  });
});
