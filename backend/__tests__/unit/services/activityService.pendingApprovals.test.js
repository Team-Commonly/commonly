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

  it('queries approvals from both creator and membership pods', async () => {
    const memberUserId = 'queue-member';
    Pod.find.mockReturnValue(podFindResult([{ _id: 'owner-pod' }]));
    Activity.getPendingApprovals.mockResolvedValue([{ _id: 'approval-1' }]);

    await expect(ActivityService.getPendingApprovals(memberUserId)).resolves.toEqual([
      { _id: 'approval-1' },
    ]);

    expect(Pod.find).toHaveBeenCalledWith({
      $or: [
        { createdBy: memberUserId },
        { members: memberUserId },
      ],
    });
    expect(Activity.getPendingApprovals).toHaveBeenCalledWith(['owner-pod']);
  });
});
