const { cleanSignupRef } = require('../../../utils/signupRef');

describe('cleanSignupRef', () => {
  it('keeps a short plain code, lower-cased', () => {
    expect(cleanSignupRef('x')).toBe('x');
    expect(cleanSignupRef(' X-Thread_2 ')).toBe('x-thread_2');
  });

  it.each([
    ['empty', ''],
    ['too long', 'a'.repeat(33)],
    ['markup', '<script>'],
    ['a URL', 'https://evil.example'],
    ['a dot path', '../x'],
    ['an object', { $gt: '' }],
    ['a number', 7],
  ])('drops %s', (_label, raw) => {
    expect(cleanSignupRef(raw)).toBeUndefined();
  });
});
