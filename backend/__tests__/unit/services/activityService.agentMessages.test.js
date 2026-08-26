jest.mock('../../../models/pg/Message', () => ({ findByPodId: jest.fn() }));

const PGMessage = require('../../../models/pg/Message');
const ActivityService = require('../../../services/activityService');

describe('ActivityService.getMessageActivities', () => {
  afterEach(() => jest.restoreAllMocks());

  test('uses the persisted bot flag and preserves the Postgres pod id for an agent update', async () => {
    PGMessage.findByPodId.mockResolvedValue([{
      id: 'message-1',
      pod_id: 'pod-1',
      content: 'The verification suite passed.',
      created_at: new Date(),
      userId: { _id: 'agent-1', username: 'release-bot', isBot: true },
    }]);
    jest.spyOn(ActivityService, 'isAgentUsername').mockReturnValue(false);

    const activities = await ActivityService.getMessageActivities(
      ['pod-1'],
      new Map([['pod-1', { _id: 'pod-1', name: 'Release pod' }]]),
      { filter: 'agents' },
    );

    expect(activities).toEqual([expect.objectContaining({
      actor: expect.objectContaining({ type: 'agent', name: 'release-bot' }),
      pod: { id: 'pod-1', name: 'Release pod' },
      flags: expect.objectContaining({ isAgentAction: true }),
    })]);
  });
});
