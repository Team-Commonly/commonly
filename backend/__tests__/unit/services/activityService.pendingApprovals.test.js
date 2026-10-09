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

  // TASK-166 inverted this arm: it used to assert the query read `createdBy`
  // as membership ("both creator and membership pods"). `createdBy` records who
  // made the pod and `leavePod` keeps it, so that term put a departed creator's
  // queue back in front of them. The read rule and the write gate in
  // `requireActivityApprovalMember` are now the same rule.
  it('queries approvals from listed membership only', async () => {
    const memberUserId = 'queue-member';
    Pod.find.mockReturnValue(podFindResult([{ _id: 'member-pod' }]));
    Activity.getPendingApprovals.mockResolvedValue([{ _id: 'approval-1' }]);

    await expect(ActivityService.getPendingApprovals(memberUserId)).resolves.toEqual([
      { _id: 'approval-1' },
    ]);

    expect(Pod.find).toHaveBeenCalledWith({
      $or: [
        { members: memberUserId },
      ],
    });
    expect(Activity.getPendingApprovals).toHaveBeenCalledWith(['member-pod']);
  });
});
