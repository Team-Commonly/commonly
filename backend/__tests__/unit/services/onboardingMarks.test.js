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
  markPodOpened, markStartPicked, markByoOpened, markByoCommandCopied,
  markByoConnectionAttempt, markWelcomeHostedStart, markSurface, markByoDaemonRegistered,
  resetOnboardingMarksForTest,
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

  // TASK-290: the welcome's hosted start sends no message, so the hosted route
  // records it once the server has checked the click (services/welcomeHostedStart).
  test('the welcome hosted start records run-hosted as the first start, under the same write-once rule', () => {
    markWelcomeHostedStart('u1');
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = mockUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'u1', isBot: { $ne: true }, 'onboarding.firstStartAt': { $exists: false } });
    expect(update.$set['onboarding.firstStartId']).toBe('run-hosted');
    expect(update.$set['onboarding.firstStartAt']).toBeInstanceOf(Date);

    // One first start per person, whichever start it was.
    markStartPicked('u1', { createdBy: 'u1' }, 'Start a pod for a project');
    markWelcomeHostedStart('u1');
    markWelcomeHostedStart('');
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
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

  test('records the OS the page detected in the same write-once update', () => {
    markByoOpened('u1', 'windows');
    const [filter, update] = mockUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'u1', isBot: { $ne: true }, 'onboarding.byoOpenedAt': { $exists: false } });
    expect(Object.keys(update.$set)).toEqual(['onboarding.byoOpenedAt', 'onboarding.byoOpenedOs']);
    expect(update.$set['onboarding.byoOpenedOs']).toBe('windows');
  });

  test.each(['mac', 'linux', 'windows', 'other'])('keeps os=%s', (os) => {
    markByoOpened('u1', os);
    expect(mockUpdateOne.mock.calls[0][1].$set['onboarding.byoOpenedOs']).toBe(os);
  });

  test.each([['ios'], ['Mac'], [''], [['mac']], [{ os: 'mac' }], [42]])(
    'any other os value (%p) records the visit without an OS',
    (os) => {
      markByoOpened('u1', os);
      expect(mockUpdateOne).toHaveBeenCalledTimes(1);
      expect(Object.keys(mockUpdateOne.mock.calls[0][1].$set)).toEqual(['onboarding.byoOpenedAt']);
    },
  );

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

describe('BYO setup marks', () => {
  test('records the first copied command as a fixed kind, never its contents', () => {
    markByoCommandCopied('u1', 'mcp');
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'u1', isBot: { $ne: true }, 'onboarding.byoCommandCopiedAt': { $exists: false } },
      { $set: {
        'onboarding.byoCommandCopiedAt': expect.any(Date),
        'onboarding.byoCommandType': 'mcp',
      } },
    );
    expect(JSON.stringify(mockUpdateOne.mock.calls)).not.toMatch(/cm_agent|command text/i);
  });

  test('keeps the first-copy pair to the first kind and refuses invalid kinds', () => {
    markByoCommandCopied('u1', 'cli');
    markByoCommandCopied('u1', 'mcp');
    markByoCommandCopied('u1', 'shell');
    const firstCopyWrites = mockUpdateOne.mock.calls.filter(
      ([filter]) => filter['onboarding.byoCommandCopiedAt'],
    );
    expect(firstCopyWrites).toHaveLength(1);
    expect(firstCopyWrites[0][1].$set['onboarding.byoCommandType']).toBe('cli');
    expect(mockUpdateOne).toHaveBeenCalledTimes(3);
  });

  test('records each command kind once, so MCP-then-listener is not read as MCP-only (TASK-721)', () => {
    markByoCommandCopied('u1', 'mcp');
    markByoCommandCopied('u1', 'mcp');
    markByoCommandCopied('u1', 'cli');
    markByoCommandCopied('u1', 'cli');
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'u1', isBot: { $ne: true }, 'onboarding.byoMcpCopiedAt': { $exists: false } },
      { $set: { 'onboarding.byoMcpCopiedAt': expect.any(Date) } },
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'u1', isBot: { $ne: true }, 'onboarding.byoCliCopiedAt': { $exists: false } },
      { $set: { 'onboarding.byoCliCopiedAt': expect.any(Date) } },
    );
    // one first-copy write + one per kind, however often each button is pressed
    expect(mockUpdateOne).toHaveBeenCalledTimes(3);
  });

  test('a failed per-kind write is retried on the next copy', async () => {
    mockUpdateOne.mockRejectedValueOnce(new Error('down'));
    markByoCommandCopied('u1', 'cli');
    await flush();
    mockUpdateOne.mockClear();
    markByoCommandCopied('u1', 'cli');
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ 'onboarding.byoCliCopiedAt': { $exists: false } }),
      expect.anything(),
    );
  });

  test('records a first BYO runtime attempt for the human installer, not the bot', () => {
    markByoConnectionAttempt('u1', { config: { runtime: { host: 'byo', runtimeType: 'webhook' } } });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'u1', isBot: { $ne: true }, 'onboarding.byoFirstConnectionAttemptAt': { $exists: false } },
      { $set: { 'onboarding.byoFirstConnectionAttemptAt': expect.any(Date) } },
    );
  });

  test('records the computer-placement runtime as BYO', () => {
    markByoConnectionAttempt('u1', { config: { runtime: { runtimeType: 'wrapper' } } });
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  });

  test('does not mark hosted, native, or push-webhook attempts', () => {
    markByoConnectionAttempt('u1', { config: { runtime: { runtimeType: 'hosted' } } });
    markByoConnectionAttempt('u2', { config: { runtime: { runtimeType: 'native' } } });
    markByoConnectionAttempt('u3', { config: { runtime: { runtimeType: 'webhook', webhookUrl: 'https://example.test' } } });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});

describe('markByoDaemonRegistered (TASK-661)', () => {
  test('sets byoDaemonRegisteredAt write-once in the filter, never for bots', () => {
    markByoDaemonRegistered('u1');

    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'u1', isBot: { $ne: true }, 'onboarding.byoDaemonRegisteredAt': { $exists: false } },
      { $set: { 'onboarding.byoDaemonRegisteredAt': expect.any(Date) } },
    );
  });

  test('one write per person per process, however many machines they register', () => {
    markByoDaemonRegistered('u1');
    markByoDaemonRegistered('u1');
    markByoDaemonRegistered('u2');
    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
  });

  test('a failed write is retried on the next registration and never throws', async () => {
    mockUpdateOne.mockRejectedValueOnce(new Error('db down'));
    markByoDaemonRegistered('u1');
    await flush();
    markByoDaemonRegistered('u1');
    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
  });

  test('no person, no write', () => {
    markByoDaemonRegistered(undefined);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});

describe('markSurface', () => {
  test.each(['inviteCardShownAt', 'inviteCardDismissedAt', 'byoOfferShownAt'])('%s is write-once in the filter, never for bots', (mark) => {
    markSurface('u1', mark);
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = mockUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'u1', isBot: { $ne: true }, [`onboarding.${mark}`]: { $exists: false } });
    expect(Object.keys(update.$set)).toEqual([`onboarding.${mark}`]);
    expect(update.$set[`onboarding.${mark}`]).toBeInstanceOf(Date);
  });

  test('refuses any field outside the three surface marks, and no person means no write', () => {
    markSurface('u1', 'podOpenedAt');
    markSurface('u1', 'isAdmin');
    markSurface('', 'inviteCardShownAt');
    markSurface(undefined, 'byoOfferShownAt');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  test('one write per person per mark per process; each mark is independent', () => {
    markSurface('u1', 'inviteCardShownAt');
    markSurface('u1', 'inviteCardShownAt');
    markSurface('u1', 'inviteCardDismissedAt');
    markSurface('u2', 'inviteCardShownAt');
    expect(mockUpdateOne).toHaveBeenCalledTimes(3);
  });

  test('a failed write is retried on the next ping and never throws; reset forgets', async () => {
    mockUpdateOne.mockRejectedValueOnce(new Error('mongo down'));
    expect(() => markSurface('u1', 'byoOfferShownAt')).not.toThrow();
    await flush();
    markSurface('u1', 'byoOfferShownAt');
    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
    resetOnboardingMarksForTest();
    markSurface('u1', 'byoOfferShownAt');
    expect(mockUpdateOne).toHaveBeenCalledTimes(3);
  });
});

describe('the onboarding marks together', () => {
  const fieldOf = ([filter]) => Object.keys(filter)[2];

  test('they are independent: having one never skips another', () => {
    markPodOpened('u1', { createdBy: 'u1' });
    markStartPicked('u1', { createdBy: 'u1' }, 'Connect an agent I already use');
    markByoOpened('u1');
    markByoCommandCopied('u1', 'cli');
    markByoConnectionAttempt('u1', { config: { runtime: { host: 'byo' } } });
    expect(mockUpdateOne.mock.calls.map(fieldOf))
      .toEqual([
        'onboarding.podOpenedAt', 'onboarding.firstStartAt', 'onboarding.byoOpenedAt',
        'onboarding.byoCliCopiedAt', 'onboarding.byoCommandCopiedAt',
        'onboarding.byoFirstConnectionAttemptAt',
      ]);
  });

  test('the reset seam forgets all onboarding marks', () => {
    markPodOpened('u1', { createdBy: 'u1' });
    markStartPicked('u1', { createdBy: 'u1' }, 'Connect an agent I already use');
    markByoOpened('u1');
    markByoCommandCopied('u1', 'cli');
    markByoConnectionAttempt('u1', { config: { runtime: { host: 'byo' } } });
    resetOnboardingMarksForTest();
    markPodOpened('u1', { createdBy: 'u1' });
    markStartPicked('u1', { createdBy: 'u1' }, 'Connect an agent I already use');
    markByoOpened('u1');
    markByoCommandCopied('u1', 'cli');
    markByoConnectionAttempt('u1', { config: { runtime: { host: 'byo' } } });
    expect(mockUpdateOne).toHaveBeenCalledTimes(12);
  });
});
