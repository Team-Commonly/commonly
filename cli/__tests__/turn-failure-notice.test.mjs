import {
  LOGIN_NOTICE,
  NOT_INSTALLED_NOTICE,
  cantAnswerNotice,
} from '../src/lib/turn-failure-notice.js';

describe('cantAnswerNotice', () => {
  test.each([
    ['a gateway key that expired', 'codex exited with code 1: 401 Authentication Error, Expired Key. Key Expiry time 2026-11-06'],
    ['a provider that says unauthorized', 'unexpected status 401 Unauthorized'],
    ['a login that lapsed', 'claude exited with code 1: Not logged in'],
    ['a refused key', 'invalid api key'],
  ])('%s names the key or login', (_name, message) => {
    expect(cantAnswerNotice(new Error(message))).toBe(LOGIN_NOTICE);
  });

  test('an adapter that will not start says that, not that a key failed', () => {
    expect(cantAnswerNotice(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })))
      .toBe(NOT_INSTALLED_NOTICE);
    expect(cantAnswerNotice(new Error('codex: command not found'))).toBe(NOT_INSTALLED_NOTICE);
  });

  test.each([
    ['a rate limit', 'unexpected status 429 Too Many Requests'],
    ['a used-up quota', 'You exceeded your current quota'],
    ['a crash', 'codex exited with code 1:'],
    ['a bare 403, which can be a route refusing', 'request failed with status 403'],
  ])('%s gets no notice', (_name, message) => {
    expect(cantAnswerNotice(new Error(message))).toBeNull();
  });

  test('the line never quotes the error, which can carry key material', () => {
    const notice = cantAnswerNotice(new Error('401 Expired Key sk-walk-abc123'));
    expect(notice).not.toContain('sk-');
    expect(notice).not.toContain('401');
  });

  test('both lines fit one chat message', () => {
    expect(LOGIN_NOTICE.length).toBeLessThanOrEqual(400);
    expect(NOT_INSTALLED_NOTICE.length).toBeLessThanOrEqual(400);
  });
});
