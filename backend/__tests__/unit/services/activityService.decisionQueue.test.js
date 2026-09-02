/**
 * DecisionRequest is the only source of interactive decision cards. Board
 * prose remains board prose; an OPTIONS line must never turn into an action
 * surface merely because it looked structured to the reader.
 */

jest.mock('../../../models/Pod', () => ({
  find: jest.fn(),
  findById: jest.fn(),
}));
jest.mock('../../../models/Task', () => ({ find: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/DecisionRequest', () => ({ find: jest.fn() }));
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn().mockResolvedValue({ rows: [] }) } }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/Summary', () => ({}));
jest.mock('../../../models/Post', () => ({}));

const ActivityService = require('../../../services/activityService');
const Pod = require('../../../models/Pod');
const Task = require('../../../models/Task');
const User = require('../../../models/User');
const DecisionRequest = require('../../../models/DecisionRequest');
const { pool } = require('../../../config/db-pg');

const POD = { _id: 'pod-1', name: 'Sprint HQ', type: 'team' };
const userChain = (doc) => ({ select: () => ({ lean: async () => doc }) });
const taskChain = (rows) => ({ sort: () => ({ limit: () => ({ lean: async () => rows }) }) });
const decisionChain = (rows) => ({ sort: () => ({ limit: () => ({ lean: async () => rows }) }) });

const decision = (overrides = {}) => ({
  _id: 'decision-1', podId: 'pod-1', title: 'Choose deployment shape',
  question: 'Which release train should this agent follow?',
  options: [
    { label: 'Fast lane', description: 'Ship after the green suite.' },
    { label: 'Canary', description: 'Roll out gradually.', recommended: true },
  ],
  messageId: '700', threadRootId: '695', status: 'pending',
  createdAt: new Date('2026-09-01T12:00:00Z'), ...overrides,
});

describe('ActivityService.getDecisionQueue', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    Pod.find.mockReturnValue({ select: () => ({ lean: async () => [POD] }) });
    Task.find.mockReturnValue(taskChain([]));
    User.findById.mockReturnValue(userChain({ username: 'Sam', activityQueue: { acknowledgedMentionIds: [] } }));
    DecisionRequest.find.mockReturnValue(decisionChain([]));
    pool.query.mockResolvedValue({ rows: [] });
    jest.spyOn(ActivityService, 'getPendingApprovals').mockResolvedValue([]);
  });

  test('renders agent-authored pending rows with their stored alternatives, not task prose', async () => {
    DecisionRequest.find.mockReturnValue(decisionChain([decision()]));
    Task.find.mockReturnValue(taskChain([
      {
        taskId: 'TASK-024', podId: 'pod-1', status: 'pending',
        title: 'DECIDE: legacy board wording',
        updates: [{ text: 'OPTIONS: Parse me | Do not parse me', createdAt: new Date() }],
      },
    ]));

    const result = await ActivityService.getDecisionQueue('u1');

    expect(DecisionRequest.find).toHaveBeenCalledWith({
      podId: { $in: ['pod-1'] }, status: 'pending', messageId: { $exists: true, $ne: null },
    });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'decision', id: 'decision-1', messageId: '700', threadRootId: '695',
        options: [
          { label: 'Canary', description: 'Roll out gradually.', recommended: true },
          { label: 'Fast lane', description: 'Ship after the green suite.' },
        ],
      }),
    ]));
    expect(result.items.find((item) => item.taskId === 'TASK-024')).toBeUndefined();
  });

  test('a blocked row is a standing decision, a human handoff is a press — both open-board items', async () => {
    Task.find.mockReturnValue(taskChain([
      {
        taskId: 'TASK-016', podId: 'pod-1', status: 'blocked', title: 'Fix release gate',
        updates: [{ text: 'blocked on upstream', createdAt: new Date() }],
      },
      {
        taskId: 'TASK-059', podId: 'pod-1', status: 'claimed', title: 'Retention ledger',
        updates: [{ text: 'held for the human merge press', createdAt: new Date() }],
      },
    ]));
    const result = await ActivityService.getDecisionQueue('u1');
    expect(result.items.map((item) => [item.taskId, item.kind])).toEqual([
      ['TASK-016', 'decision'], ['TASK-059', 'press'],
    ]);
  });

  test('leaves existing Activity approvals on their established read path', async () => {
    const getPendingApprovals = jest.spyOn(ActivityService, 'getPendingApprovals').mockResolvedValue([
      { _id: 'activity-approval-1', content: 'Deploy?', podId: 'pod-1', createdAt: new Date(), agentMetadata: { agentName: 'scout' } },
    ]);
    const result = await ActivityService.getDecisionQueue('u1');
    expect(getPendingApprovals).toHaveBeenCalledWith('u1');
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'approval', id: 'activity-approval-1', title: 'scout requests approval' }),
    ]));
  });

  test('presents a member with an approval they can decide', async () => {
    Pod.find.mockReturnValue({ select: () => ({ lean: async () => [POD] }) });
    jest.spyOn(ActivityService, 'getPendingApprovals').mockResolvedValue([
      { _id: 'activity-approval-1', content: 'Deploy?', podId: 'pod-1', createdAt: new Date() },
    ]);

    const result = await ActivityService.getDecisionQueue('member-1');

    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'approval', id: 'activity-approval-1' }),
    ]));
  });

  test('mentions are still thread-aware and cap at eight without hiding decision cards', async () => {
    DecisionRequest.find.mockReturnValue(decisionChain(Array.from({ length: 4 }, (_, index) => decision({
      _id: `decision-${index}`, messageId: `${700 + index}`, createdAt: new Date(Date.now() - index * 1000),
    }))));
    pool.query.mockResolvedValue({ rows: Array.from({ length: 10 }, (_, index) => ({
      id: 100 + index, pod_id: 'pod-1', user_id: 'bot-1', content: '@Sam ping',
      created_at: new Date(Date.now() - index * 1000), thread_root_id: null, author: 'vale',
    })) });
    const result = await ActivityService.getDecisionQueue('u1');
    expect(result.items.filter((item) => item.kind === 'mention')).toHaveLength(8);
    expect(result.items.filter((item) => item.kind === 'decision')).toHaveLength(4);
    expect(result.count).toBe(14);
  });

  test('a failed DecisionRequest read degrades to the still-available board facts', async () => {
    DecisionRequest.find.mockImplementation(() => { throw new Error('store down'); });
    Task.find.mockReturnValue(taskChain([{
      taskId: 'TASK-059', podId: 'pod-1', status: 'claimed', title: 'Release',
      updates: [{ text: 'ready for the human press', createdAt: new Date() }],
    }]));
    const result = await ActivityService.getDecisionQueue('u1');
    expect(result.items).toEqual([expect.objectContaining({ taskId: 'TASK-059', kind: 'press' })]);
  });
});
