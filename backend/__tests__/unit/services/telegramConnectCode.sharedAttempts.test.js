/**
 * The /commonly-enable attempt budget counts in the shared rate-limit store, so
 * it holds across backend processes. In tests the store has no Redis and counts
 * in memory, which is the same fallback a process takes when Redis is down.
 */
const {
  registerEnableAttempt, resetEnableAttempts, ENABLE_ATTEMPT_LIMIT, ENABLE_ATTEMPT_WINDOW_MS,
} = require('../../../services/telegramConnectCode');

describe('telegram enable attempts in the shared store', () => {
  beforeEach(() => resetEnableAttempts());
  afterAll(() => jest.useRealTimers());

  it('allows the limit per chat, then refuses; other chats keep their own budget', async () => {
    for (let i = 0; i < ENABLE_ATTEMPT_LIMIT; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(await registerEnableAttempt('42')).toBe(true);
    }
    expect(await registerEnableAttempt('42')).toBe(false);
    expect(await registerEnableAttempt('43')).toBe(true);
  });

  it('allows the chat again once its window has passed', async () => {
    jest.useFakeTimers({ now: 0 });
    resetEnableAttempts();
    for (let i = 0; i <= ENABLE_ATTEMPT_LIMIT; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await registerEnableAttempt('42');
    }
    expect(await registerEnableAttempt('42')).toBe(false);
    jest.advanceTimersByTime(ENABLE_ATTEMPT_WINDOW_MS + 1);
    expect(await registerEnableAttempt('42')).toBe(true);
    resetEnableAttempts();
    jest.useRealTimers();
  });

  it('a reset clears every chat', async () => {
    for (let i = 0; i < ENABLE_ATTEMPT_LIMIT; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await registerEnableAttempt('42');
    }
    resetEnableAttempts();
    expect(await registerEnableAttempt('42')).toBe(true);
  });
});
