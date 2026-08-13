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
jest.mock('../../../models/Task', () => ({
  findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
}));

const mockEmitTaskUpdated = jest.fn();
jest.mock('../../../services/taskEventService', () => ({
  emitTaskUpdated: (...args) => mockEmitTaskUpdated(...args),
}));

const {
  completeConnectAgentStarterTask,
  CONNECT_AGENT_SOURCE_REF,
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
