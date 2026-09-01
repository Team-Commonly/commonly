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
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn().mockResolvedValue({ rows: [] }) } }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/Summary', () => ({}));
jest.mock('../../../models/Post', () => ({}));

const ActivityService = require('../../../services/activityService');
const Pod = require('../../../models/Pod');
const Task = require('../../../models/Task');
const User = require('../../../models/User');
const { pool } = require('../../../config/db-pg');

const userChain = (doc) => ({ select: () => ({ lean: async () => doc }) });

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
    User.findById.mockReturnValue(userChain({ username: 'Sam', activityQueue: { acknowledgedMentionIds: [] } }));
    pool.query.mockResolvedValue({ rows: [] });
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

  test('attention order beats recency: approval, press, mention, then standing decisions — capped at 12 with an honest total', async () => {
    ActivityService.getPendingApprovals.mockResolvedValue([
      { _id: 'act-1', content: 'approve?', podId: 'pod-1', createdAt: new Date('2026-08-20T00:00:00Z') },
    ]);
    pool.query.mockResolvedValue({ rows: [{
      id: 501, pod_id: 'pod-1', user_id: 'bot-1', content: '@Sam ping', created_at: new Date('2026-08-27T00:00:00Z'),
      thread_root_id: 480, author: 'anvil',
    }] });
    const rows = [];
    for (let i = 0; i < 13; i += 1) {
      rows.push({
        taskId: `TASK-${100 + i}`, podId: 'pod-1', status: 'blocked', title: `Old blocked ${i}`,
        updates: [{ text: 'stuck', createdAt: new Date(`2026-08-2${i % 6}T0${i % 9}:00:00Z`) }],
      });
    }
    rows.push({
      taskId: 'TASK-059', podId: 'pod-1', status: 'claimed', title: 'Ledger',
      updates: [{ text: 'held for the human merge press', createdAt: new Date('2026-08-19T00:00:00Z') }],
    });
    Task.find.mockReturnValue(taskChain(rows));

    const result = await ActivityService.getDecisionQueue('u1');
    expect(result.items).toHaveLength(12);
    expect(result.count).toBe(16); // 1 approval + 1 mention + 13 blocked + 1 press
    // Kind order wins over raw recency: the OLD approval and press outrank
    // fresher blocked rows.
    expect(result.items[0].kind).toBe('approval');
    expect(result.items[1].kind).toBe('press');
    expect(result.items[2].kind).toBe('mention');
    expect(result.items[3].kind).toBe('decision');
  });

  test('mentions come from a dedicated thread-aware query: acked rows drop, reply coordinates ride along', async () => {
    // Sam, 2026-09-01: 15 @Sam mentions in 36h, 14 inside threads, feed saw
    // zero. The queue asks the store directly and keeps the thread root so
    // the tab can reply IN the thread.
    User.findById.mockReturnValue(userChain({ username: 'Sam', activityQueue: { acknowledgedMentionIds: ['msg_7'] } }));
    pool.query.mockResolvedValue({ rows: [
      { id: 9, pod_id: 'pod-1', user_id: 'bot-1', content: '@Sam in a thread', created_at: new Date(), thread_root_id: 4, author: 'vale' },
      { id: 7, pod_id: 'pod-1', user_id: 'bot-2', content: '@Sam already handled', created_at: new Date(), thread_root_id: null, author: 'juno' },
      { id: 5, pod_id: 'pod-1', user_id: 'bot-3', content: '@Sam top-level', created_at: new Date(), thread_root_id: null, author: 'kai' },
    ] });
    const result = await ActivityService.getDecisionQueue('u1');
    const mentions = result.items.filter((i) => i.kind === 'mention');
    expect(mentions.map((m) => m.id)).toEqual(['msg_9', 'msg_5']);
    expect(mentions[0]).toMatchObject({ threadRootId: 4, messageId: 9, title: 'vale mentioned you' });
    // A top-level mention is its own thread root.
    expect(mentions[1]).toMatchObject({ threadRootId: 5, messageId: 5 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/ANY\(\$1::text\[\]\)/);
    expect(params[2]).toBe('@Sam(?![A-Za-z0-9_])');
  });

  test('mentions take at most 8 of the 12 slots so standing decisions stay visible', async () => {
    // Live after #1464: 40+ thread mentions filled the page and the four
    // ADR-024 decisions vanished below the cap.
    pool.query.mockResolvedValue({ rows: Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i, pod_id: 'pod-1', user_id: 'bot-1', content: '@Sam ping', created_at: new Date(Date.now() - i * 1000), thread_root_id: null, author: 'vale',
    })) });
    Task.find.mockReturnValue(taskChain(Array.from({ length: 4 }, (_, i) => ({
      taskId: `TASK-${200 + i}`, podId: 'pod-1', status: 'blocked', title: `Standing ${i}`,
      updates: [{ text: 'blocked', createdAt: new Date() }],
    }))));
    const result = await ActivityService.getDecisionQueue('u1');
    const kinds = result.items.map((i) => i.kind);
    expect(kinds.filter((k) => k === 'mention')).toHaveLength(8);
    expect(kinds.filter((k) => k === 'decision')).toHaveLength(4);
    expect(result.count).toBe(14);
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
