// TASK-166: `getUserFeed` builds the viewer's pod set from membership. It used
// to `$or` in `{ createdBy: userId }`, and `leavePod` keeps that field after
// unlisting the creator — so a departed creator's ambient feed still contained
// the pod they had left, while every chat and connector write into it refused
// them.
//
// Covered here rather than through `getRecap`, which spies this method out: the
// membership decision is in the query, so the arm asserts the query rather than
// a row (the Pod mock returns whichever fixture it is handed).
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/Summary', () => ({}));
jest.mock('../../../models/Post', () => ({}));
jest.mock('../../../models/Task', () => ({ find: jest.fn() }));

const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const ActivityService = require('../../../services/activityService');

const chain = (value) => ({ select: () => ({ lean: async () => value }) });

describe('ActivityService.getUserFeed — pod membership', () => {
  let rankSpy;
  let aggregateSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    User.findById.mockReturnValue(chain({ _id: 'caller-1', username: 'Caller' }));
    Pod.find.mockReturnValue(chain([]));
    rankSpy = jest.spyOn(ActivityService, 'rankPodsByRecentActivity').mockResolvedValue([]);
    aggregateSpy = jest.spyOn(ActivityService, 'aggregateActivities').mockResolvedValue([]);
  });

  afterEach(() => {
    rankSpy.mockRestore();
    aggregateSpy.mockRestore();
  });

  it('selects the viewer\'s pods by membership, not by createdBy', async () => {
    await ActivityService.getUserFeed('caller-1', {});

    expect(Pod.find).toHaveBeenCalledWith({
      $or: [
        { 'members.userId': 'caller-1' },
        { members: 'caller-1' },
      ],
    });
  });

  it('still reaches the aggregator for a member (control)', async () => {
    await expect(ActivityService.getUserFeed('caller-1', {})).resolves.toMatchObject({
      activities: [],
      hasMore: false,
    });
    expect(aggregateSpy).toHaveBeenCalledTimes(1);
  });
});
