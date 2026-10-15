/**
 * First-session marks are write-once per person, never for bots, and never
 * break the request that triggers them.
 */
const mockUpdateOne = jest.fn();
jest.mock('../../../models/User', () => ({
  __esModule: true,
  default: { updateOne: (...args) => mockUpdateOne(...args) },
}));

const {
  markPodOpened, markStartPicked, markByoOpened, resetOnboardingMarksForTest,
} = require('../../../services/onboardingMarks');

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

// Which of Scout's starts a new person picks. A click sends the start's label
// as their message, so the server reads the pick from the text it already has.
describe('markStartPicked', () => {
  test('records which start a person posted in a pod they created, write-once, never for bots', () => {
    markStartPicked('u1', { createdBy: 'u1' }, 'Connect an agent I already use');
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = mockUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'u1', isBot: { $ne: true }, 'onboarding.firstStartAt': { $exists: false } });
    expect(update.$set['onboarding.firstStartId']).toBe('connect-agent');
    expect(update.$set['onboarding.firstStartAt']).toBeInstanceOf(Date);
  });

  test('reads the pod start by its own label, around surrounding whitespace', () => {
    markStartPicked('u1', { createdBy: 'u1' }, '  Start a pod for a project\n');
    expect(mockUpdateOne.mock.calls[0][1].$set['onboarding.firstStartId']).toBe('start-pod');
  });

  test('anything that is not exactly a start is not a pick', () => {
    markStartPicked('u1', { createdBy: 'u1' }, 'hello');
    markStartPicked('u1', { createdBy: 'u1' }, 'connect an agent i already use');
    markStartPicked('u1', { createdBy: 'u1' }, 'Connect an agent I already use, please');
    markStartPicked('u1', { createdBy: 'u1' }, undefined);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  test("a start posted in someone else's pod is not a first-session pick", () => {
    markStartPicked('u1', { createdBy: 'u2' }, 'Connect an agent I already use');
    markStartPicked('u1', null, 'Connect an agent I already use');
    markStartPicked('', { createdBy: '' }, 'Connect an agent I already use');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  test('one write per person per process, and a failed write is retried without throwing', async () => {
    mockUpdateOne.mockRejectedValueOnce(new Error('mongo down'));
    expect(() => markStartPicked('u1', { createdBy: 'u1' }, 'Start a pod for a project')).not.toThrow();
    await flush();
    markStartPicked('u1', { createdBy: 'u1' }, 'Start a pod for a project');
    markStartPicked('u1', { createdBy: 'u1' }, 'Connect an agent I already use');
    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
  });

  test('the open mark and the start mark are independent', () => {
    markPodOpened('u1', { createdBy: 'u1' });
    markStartPicked('u1', { createdBy: 'u1' }, 'Start a pod for a project');
    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
  });
});

// The first visit to Bring your own, read from the page's own load request.
describe('markByoOpened', () => {
  test('marks the first visit to Bring your own, write-once in the filter, never for bots', () => {
    markByoOpened('u1');
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = mockUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'u1', isBot: { $ne: true }, 'onboarding.byoOpenedAt': { $exists: false } });
    expect(Object.keys(update)).toEqual(['$set']);
    expect(Object.keys(update.$set)).toEqual(['onboarding.byoOpenedAt']);
    expect(update.$set['onboarding.byoOpenedAt']).toBeInstanceOf(Date);
  });

  test('no person, no write', () => {
    markByoOpened('');
    markByoOpened(undefined);
    markByoOpened(null);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  test('one write per person per process, however often the page reloads its availability', () => {
    markByoOpened('u1');
    markByoOpened('u1');
    markByoOpened({ toString: () => 'u1' });
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  });

  test('a failed write is retried on the next visit, and never throws into the request', async () => {
    mockUpdateOne.mockRejectedValueOnce(new Error('mongo down'));
    expect(() => markByoOpened('u1')).not.toThrow();
    await flush();
    markByoOpened('u1');
    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
  });
});

describe('the three marks together', () => {
  const fieldOf = ([filter]) => Object.keys(filter)[2];

  test('they are independent: having one never skips another', () => {
    markPodOpened('u1', { createdBy: 'u1' });
    markStartPicked('u1', { createdBy: 'u1' }, 'Connect an agent I already use');
    markByoOpened('u1');
    expect(mockUpdateOne.mock.calls.map(fieldOf))
      .toEqual(['onboarding.podOpenedAt', 'onboarding.firstStartAt', 'onboarding.byoOpenedAt']);
  });

  test('the reset seam forgets all three', () => {
    markPodOpened('u1', { createdBy: 'u1' });
    markStartPicked('u1', { createdBy: 'u1' }, 'Connect an agent I already use');
    markByoOpened('u1');
    resetOnboardingMarksForTest();
    markPodOpened('u1', { createdBy: 'u1' });
    markStartPicked('u1', { createdBy: 'u1' }, 'Connect an agent I already use');
    markByoOpened('u1');
    expect(mockUpdateOne).toHaveBeenCalledTimes(6);
  });
});
