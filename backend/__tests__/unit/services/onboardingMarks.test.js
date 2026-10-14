/**
 * First-session marks are write-once per person, never for bots, and never
 * break the request that triggers them.
 */
const mockUpdateOne = jest.fn();
jest.mock('../../../models/User', () => ({
  __esModule: true,
  default: { updateOne: (...args) => mockUpdateOne(...args) },
}));

const { markPodOpened, resetOnboardingMarksForTest } = require('../../../services/onboardingMarks');

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockUpdateOne.mockReset();
  mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  resetOnboardingMarksForTest();
});

describe('markPodOpened', () => {
  test('marks a person opening a pod they created, write-once in the filter, never for bots', () => {
    markPodOpened('u1', { createdBy: 'u1' });
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = mockUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'u1', isBot: { $ne: true }, 'onboarding.podOpenedAt': { $exists: false } });
    expect(Object.keys(update)).toEqual(['$set']);
    expect(update.$set['onboarding.podOpenedAt']).toBeInstanceOf(Date);
  });

  test("someone else's pod is not their workspace", () => {
    markPodOpened('u1', { createdBy: 'u2' });
    markPodOpened('u1', { createdBy: undefined });
    markPodOpened('u1', null);
    markPodOpened('', { createdBy: '' });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  test('one write per person per process, however many times they open it', () => {
    markPodOpened('u1', { createdBy: 'u1' });
    markPodOpened('u1', { createdBy: 'u1' });
    markPodOpened({ toString: () => 'u1' }, { createdBy: { toString: () => 'u1' } });
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  });

  test('a failed write is retried on the next open, and never throws into the request', async () => {
    mockUpdateOne.mockRejectedValueOnce(new Error('mongo down'));
    expect(() => markPodOpened('u1', { createdBy: 'u1' })).not.toThrow();
    await flush();
    markPodOpened('u1', { createdBy: 'u1' });
    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
  });

  test('a write that throws synchronously is also contained', () => {
    mockUpdateOne.mockImplementationOnce(() => { throw new Error('model not ready'); });
    expect(() => markPodOpened('u1', { createdBy: 'u1' })).not.toThrow();
    markPodOpened('u1', { createdBy: 'u1' });
    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
  });
});
