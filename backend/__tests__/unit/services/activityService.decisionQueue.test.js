/**
 * TASK-083 — the decision queue reads FACTS, not heuristics.
 *
 * The Activity tab's "Waiting on you" rendered empty while seven PRs sat at
 * the human press, because its only wired source was direct @mentions (empty
 * — agents write the human's bare name, TASK-070). This suite pins the three
 * concrete fact sources and their classification:
 *   - pending approvals (raw activity id — the act endpoints key on it)
 *   - unacknowledged direct mentions
 *   - board rows: DECIDE-titles and blocked rows -> 'decision';
 *     an explicit human-handoff in the LATEST update -> 'press'
 */

jest.mock('../../../models/Pod', () => ({
  find: jest.fn(),
}));
jest.mock('../../../models/Task', () => ({
  find: jest.fn(),
}));
jest.mock('../../../models/User', () => ({
  find: jest.fn(),
  findById: jest.fn(),
}));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/Summary', () => ({}));
jest.mock('../../../models/Post', () => ({}));

const ActivityService = require('../../../services/activityService');
const Pod = require('../../../models/Pod');
const Task = require('../../../models/Task');

const POD = { _id: 'pod-1', name: 'Sprint HQ', type: 'team' };

const taskChain = (rows) => ({
  sort: () => ({ limit: () => ({ lean: async () => rows }) }),
});

describe('ActivityService.getDecisionQueue', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    Pod.find.mockReturnValue({ select: () => ({ lean: async () => [POD] }) });
    jest.spyOn(ActivityService, 'getPendingApprovals').mockResolvedValue([]);
    jest.spyOn(ActivityService, 'getUserFeed').mockResolvedValue({ activities: [], acknowledgedMentionIds: [] });
    Task.find.mockReturnValue(taskChain([]));
  });

  test('a DECIDE-titled open row and a blocked row are decisions; a human-handoff update is a press', async () => {
    Task.find.mockReturnValue(taskChain([
      {
        taskId: 'TASK-024', podId: 'pod-1', status: 'pending', title: 'DECIDE: backend eslint reaches 0 files',
        updates: [{ text: 'filed', createdAt: new Date('2026-08-26T01:00:00Z') }],
      },
      {
        taskId: 'TASK-016', podId: 'pod-1', status: 'blocked', title: 'REGRESSION: isOneToOneShapedPod counts bots',
        updates: [{ text: 'blocked on decision', createdAt: new Date('2026-08-26T02:00:00Z') }],
      },
      {
        taskId: 'TASK-059', podId: 'pod-1', status: 'claimed', title: 'Retention ledger',
        updates: [{ text: '#1208 is green — held for the human merge press.', createdAt: new Date('2026-08-26T03:00:00Z') }],
      },
      {
        taskId: 'TASK-068', podId: 'pod-1', status: 'claimed', title: 'Activity tab',
        updates: [{ text: 'iterating on the design', createdAt: new Date('2026-08-26T04:00:00Z') }],
      },
    ]));

    const result = await ActivityService.getDecisionQueue('u1');
    const byTask = Object.fromEntries(result.items.map((i) => [i.taskId, i.kind]));
    expect(byTask['TASK-024']).toBe('decision');
    expect(byTask['TASK-016']).toBe('decision');
    expect(byTask['TASK-059']).toBe('press');
    // An ordinary in-flight row is NOT waiting on the human.
    expect(byTask['TASK-068']).toBeUndefined();
  });

  test('the handoff match reads the LATEST update only — an old handoff already resolved does not resurrect', async () => {
    Task.find.mockReturnValue(taskChain([
      {
        taskId: 'TASK-100', podId: 'pod-1', status: 'claimed', title: 'Some feature',
        updates: [
          { text: 'ready for the human press', createdAt: new Date('2026-08-25T00:00:00Z') },
          { text: 'pressed; follow-ups in progress', createdAt: new Date('2026-08-26T00:00:00Z') },
        ],
      },
    ]));
    const result = await ActivityService.getDecisionQueue('u1');
    expect(result.items).toHaveLength(0);
  });

  test('approvals carry the RAW activity id, because /api/activity/:id/approve keys on it', async () => {
    ActivityService.getPendingApprovals.mockResolvedValue([
      { _id: 'act-77', content: 'May I merge?', podId: 'pod-1', createdAt: new Date(), agentMetadata: { agentName: 'anvil' } },
    ]);
    const result = await ActivityService.getDecisionQueue('u1');
    const approval = result.items.find((i) => i.kind === 'approval');
    expect(approval.id).toBe('act-77');
    expect(approval.title).toContain('anvil');
  });

  test('one failed source degrades, never blanks the queue', async () => {
    ActivityService.getPendingApprovals.mockRejectedValue(new Error('store down'));
    Task.find.mockReturnValue(taskChain([
      {
        taskId: 'TASK-024', podId: 'pod-1', status: 'pending', title: 'DECIDE: something',
        updates: [{ text: 'filed', createdAt: new Date() }],
      },
    ]));
    const result = await ActivityService.getDecisionQueue('u1');
    expect(result.items.map((i) => i.taskId)).toEqual(['TASK-024']);
  });
});
