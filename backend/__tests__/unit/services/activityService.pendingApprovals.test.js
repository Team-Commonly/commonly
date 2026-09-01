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

  it('includes a pod where the user is a member but not its creator', async () => {
    const userId = 'member-only-user';
    Pod.find.mockReturnValue(podFindResult([{ _id: 'member-pod' }]));
    Activity.getPendingApprovals.mockResolvedValue([{ _id: 'approval-1' }]);

    await expect(ActivityService.getPendingApprovals(userId)).resolves.toEqual([
      { _id: 'approval-1' },
    ]);

    // Pod.members is an ObjectId[], while a small number of legacy rows use
    // the embedded-member shape. The queue must accept both, just as the
    // activity feed does; restricting the latter to an imaginary admin role
    // hides a decision from the human it is waiting on.
    expect(Pod.find).toHaveBeenCalledWith({
      $or: [
        { createdBy: userId },
        { 'members.userId': userId },
        { members: userId },
      ],
    });
    expect(Activity.getPendingApprovals).toHaveBeenCalledWith(['member-pod']);
  });
});
