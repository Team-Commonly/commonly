/**
 * #916 — completeConnectAgentStarterTask contract:
 *  - targets ONLY the seeded connect-agent starter (sourceRef match), never
 *    tasks by title or positional taskId
 *  - only pending/claimed flip; an already-done card is left alone
 *  - emits task_updated so the live board and inspector refresh
 *  - dedups pod ids, skips falsy ones, and never throws (fire-and-forget
 *    from the auth path — a board write must not fail a request)
 */

const mockFindOneAndUpdate = jest.fn();
const mockTaskExists = jest.fn();
jest.mock('../../../models/Task', () => ({
  findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
  exists: (...args) => mockTaskExists(...args),
}));
const mockPodFindById = jest.fn();
jest.mock('../../../models/Pod', () => ({ findById: (...args) => mockPodFindById(...args) }));
const mockAnswered = jest.fn();
jest.mock('../../../services/agentAnswerService', () => ({ humansAnsweredBy: (...args) => mockAnswered(...args) }));

const mockEmitTaskUpdated = jest.fn();
jest.mock('../../../services/taskEventService', () => ({
  emitTaskUpdated: (...args) => mockEmitTaskUpdated(...args),
}));

const {
  completeConnectAgentStarterTask,
  completeFirstTaskOnAnswer,
  CONNECT_AGENT_SOURCE_REF,
  FIRST_TASK_SOURCE_REF,
} = require('../../../services/starterTaskService');

const POD_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const POD_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

beforeEach(() => {
  mockFindOneAndUpdate.mockReset();
  mockEmitTaskUpdated.mockReset();
});

describe('completeConnectAgentStarterTask', () => {
  test('completes the seeded starter by sourceRef and emits task_updated', async () => {
    const updatedTask = { taskId: 'TASK-001', status: 'done' };
    mockFindOneAndUpdate.mockResolvedValue(updatedTask);

    await completeConnectAgentStarterTask({ podIds: [POD_A], agentLabel: 'My BYO Agent' });

    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(String(filter.podId)).toBe(POD_A);
    expect(filter.sourceRef).toBe(CONNECT_AGENT_SOURCE_REF);
    // Never resurrect a done/blocked card — only the untouched states flip.
    expect(filter.status).toEqual({ $in: ['pending', 'claimed'] });
    expect(update.$set.status).toBe('done');
    expect(update.$set.completedAt).toBeInstanceOf(Date);
    expect(update.$push.updates.text).toContain('My BYO Agent');
    expect(mockEmitTaskUpdated).toHaveBeenCalledWith(POD_A, updatedTask, 'updated');
  });

  test('does not emit when no starter task matched', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);

    await completeConnectAgentStarterTask({ podIds: [POD_A], agentLabel: 'agent' });

    expect(mockEmitTaskUpdated).not.toHaveBeenCalled();
  });

  test('dedups pod ids and skips falsy entries', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);

    await completeConnectAgentStarterTask({
      podIds: [POD_A, POD_A, null, undefined, POD_B],
      agentLabel: 'agent',
    });

    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  test('never throws — a failing write is contained per pod', async () => {
    mockFindOneAndUpdate
      .mockRejectedValueOnce(new Error('mongo down'))
      .mockResolvedValueOnce({ taskId: 'TASK-001', status: 'done' });

    await expect(completeConnectAgentStarterTask({
      podIds: [POD_A, POD_B],
      agentLabel: 'agent',
    })).resolves.toBeUndefined();

    // The second pod still completed despite the first failing.
    expect(mockEmitTaskUpdated).toHaveBeenCalledTimes(1);
  });

  test('an invalid pod id is contained too', async () => {
    await expect(completeConnectAgentStarterTask({
      podIds: ['not-a-hex-id'],
      agentLabel: 'agent',
    })).resolves.toBeUndefined();
    expect(mockEmitTaskUpdated).not.toHaveBeenCalled();
  });
});

// QA walk 3 (2026-10-16): "Give your agent its first task" stayed pending after
// four answered asks. It completes on the first answer an agent gives the
// workspace owner; who was answered is agentAnswerService's rule.
describe('completeFirstTaskOnAnswer', () => {
  const OWNER = 'cccccccccccccccccccccccc';
  const answer = (extra = {}) => completeFirstTaskOnAnswer({
    podId: POD_A, agentName: 'lee-agent', instanceId: 'default', agentLabel: 'lee-agent', ...extra,
  });

  beforeEach(() => {
    mockTaskExists.mockReset().mockResolvedValue({ _id: 't2' });
    mockPodFindById.mockReset().mockReturnValue({ select: () => ({ lean: async () => ({ createdBy: OWNER }) }) });
    mockAnswered.mockReset().mockResolvedValue(new Set([OWNER]));
    mockFindOneAndUpdate.mockResolvedValue({ taskId: 'TASK-002', status: 'done' });
  });

  test("the agent's first answer to the workspace owner completes the card", async () => {
    await answer({ replyToMessageId: 77 });
    expect(mockAnswered).toHaveBeenCalledWith({
      podId: POD_A, agentName: 'lee-agent', instanceId: 'default', replyToMessageId: 77,
    });
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(String(filter.podId)).toBe(POD_A);
    expect(filter.sourceRef).toBe(FIRST_TASK_SOURCE_REF);
    expect(filter.status).toEqual({ $in: ['pending', 'claimed'] });
    expect(update.$push.updates.text).toContain('lee-agent answered your first request');
    expect(mockEmitTaskUpdated).toHaveBeenCalledWith(POD_A, expect.objectContaining({ taskId: 'TASK-002' }), 'updated');
  });

  test('a post that answers someone else, or nobody, leaves it open', async () => {
    mockAnswered.mockResolvedValue(new Set(['dddddddddddddddddddddddd']));
    await answer();
    mockAnswered.mockResolvedValue(new Set());
    await answer();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  // Sprint Review on #2260: attention keeps a [BLOCKED] answer as an ask, so the
  // checklist must not call the first task done at that moment either.
  test('an answer that says it is blocked does not complete the card', async () => {
    await answer({ content: '[BLOCKED] I need the staging key to go on.' });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('Scout answering is the guide, not "your agent"', async () => {
    await answer({ agentName: 'Scout' });
    expect(mockTaskExists).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('with no open card it stops at one read, before any answer check', async () => {
    mockTaskExists.mockResolvedValue(null);
    await answer();
    expect(mockTaskExists).toHaveBeenCalledWith(expect.objectContaining({ sourceRef: FIRST_TASK_SOURCE_REF }));
    expect(mockAnswered).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('never throws: a failing board read is logged and swallowed', async () => {
    mockTaskExists.mockRejectedValue(new Error('mongo down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(answer()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
