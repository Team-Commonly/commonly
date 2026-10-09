// TASK-166: the pod feed is pod-scoped, and `getPodFeed` checked membership as
// `createdBy === userId || members.includes(userId)`. `leavePod` filters
// `members` and keeps `createdBy`, so a departed creator could still read the
// pod's whole activity feed — including activities written after they left —
// while every chat and connector write into that pod refused them.
//
// Route-level tests mock this method out (`routes/activity.read.test.js`,
// `routes/activity.identity.test.js`), so the arm lives here.
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/Summary', () => ({}));
jest.mock('../../../models/Post', () => ({}));
jest.mock('../../../models/Task', () => ({ find: jest.fn() }));

const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const ActivityService = require('../../../services/activityService');

const userChain = (value) => ({ select: () => ({ lean: async () => value }) });
const podChain = (value) => ({ lean: async () => value });

describe('ActivityService.getPodFeed — pod membership', () => {
  let aggregateSpy;
  let readStateSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    User.findById.mockReturnValue(userChain({ _id: 'caller-1', username: 'Caller' }));
    aggregateSpy = jest.spyOn(ActivityService, 'aggregateActivities').mockResolvedValue([]);
    readStateSpy = jest.spyOn(ActivityService, 'annotateReadState').mockReturnValue([]);
  });

  afterEach(() => {
    aggregateSpy.mockRestore();
    readStateSpy.mockRestore();
  });

  it('refuses a creator who left the pod', async () => {
    Pod.findById.mockReturnValue(podChain({
      _id: 'pod-1', name: 'Former', createdBy: 'creator-1', members: ['member-1'],
    }));

    await expect(ActivityService.getPodFeed('pod-1', 'creator-1', {}))
      .rejects.toThrow('Access denied');
    expect(aggregateSpy).not.toHaveBeenCalled();
  });

  it('still serves a listed member (control)', async () => {
    Pod.findById.mockReturnValue(podChain({
      _id: 'pod-1', name: 'Current', createdBy: 'creator-1', members: ['member-1'],
    }));

    await expect(ActivityService.getPodFeed('pod-1', 'member-1', {}))
      .resolves.toMatchObject({ activities: [], hasMore: false });
  });
});
