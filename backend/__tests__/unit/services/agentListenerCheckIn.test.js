// TASK-719: the listener check-in stamp is its own field, written at most once
// a minute per token, and a failed write retries on the next poll.
jest.mock('../../../models/User', () => ({ updateOne: jest.fn() }));

const User = require('../../../models/User');
const {
  recordListenerCheckIn,
  resetListenerCheckInThrottle,
} = require('../../../services/agentListenerCheckIn');

describe('recordListenerCheckIn', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-31T12:00:00.000Z'));
    User.updateOne.mockReset().mockResolvedValue({});
    resetListenerCheckInThrottle();
  });

  afterEach(() => jest.useRealTimers());

  it('stamps lastListenedAt on the matching token record, and not lastUsedAt', () => {
    recordListenerCheckIn('agent-1', 'hash-1');

    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: 'agent-1', 'agentRuntimeTokens.tokenHash': 'hash-1' },
      { $set: { 'agentRuntimeTokens.$.lastListenedAt': new Date('2026-10-31T12:00:00.000Z') } },
    );
  });

  it('writes at most once a minute per token, but each token on its own clock', () => {
    recordListenerCheckIn('agent-1', 'hash-1');
    recordListenerCheckIn('agent-1', 'hash-1');
    recordListenerCheckIn('agent-2', 'hash-2');
    expect(User.updateOne).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(61 * 1000);
    recordListenerCheckIn('agent-1', 'hash-1');
    expect(User.updateOne).toHaveBeenCalledTimes(3);
  });

  it('writes nothing without an agent id or a token hash', () => {
    recordListenerCheckIn(undefined, 'hash-1');
    recordListenerCheckIn('agent-1', undefined);
    recordListenerCheckIn('agent-1', '');
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it('retries on the next poll when the write fails, and never throws', async () => {
    User.updateOne.mockRejectedValueOnce(new Error('mongo down'));
    recordListenerCheckIn('agent-1', 'hash-1');
    await Promise.resolve();
    await Promise.resolve();

    recordListenerCheckIn('agent-1', 'hash-1');
    expect(User.updateOne).toHaveBeenCalledTimes(2);
  });

  it('does not throw when the driver throws synchronously', () => {
    User.updateOne.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => recordListenerCheckIn('agent-1', 'hash-1')).not.toThrow();
    recordListenerCheckIn('agent-1', 'hash-1');
    expect(User.updateOne).toHaveBeenCalledTimes(2);
  });
});
