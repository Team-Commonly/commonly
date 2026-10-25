const { cleanSignupTouch, signupSourceFields } = require('../../../utils/signupSource');

describe('signup source privacy boundary', () => {
  it('strips query, fragment and URL credentials, and ignores unrecognized keys', () => {
    const source = cleanSignupTouch({
      ref: ' X ', referrer: 'https://name:password@news.example/article?email=secret#token',
      landingPath: '/guides/a?invite=private#secret', firstSeenAt: '2026-01-01T00:00:00.000Z',
      authMethod: 'admin', extra: 'secret',
    });
    expect(source).toEqual({
      ref: 'x', referrer: 'https://news.example/article', landingPath: '/guides/a',
      firstSeenAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it.each([null, [], '{bad', 'x'.repeat(4097), { referrer: 'javascript:secret', landingPath: '//foreign.example', firstSeenAt: 'nope' }])(
    'drops malformed optional input without failing registration: %p', (input) => {
      expect(cleanSignupTouch(input)).toEqual({});
    },
  );

  it('does not turn a later ref into the ref of an earlier direct visit', () => {
    expect(cleanSignupTouch({ landingPath: '/' }, 'later')).toEqual({ landingPath: '/' });
    expect(cleanSignupTouch(undefined, 'old-browser')).toEqual({ ref: 'old-browser' });
  });

  it('sets auth method and recording time on the server, even without browser storage', () => {
    const source = signupSourceFields({ authMethod: 'github', recordedAt: '1900-01-01' }, 'password');
    expect(source.signupSource).toEqual({ authMethod: 'password', recordedAt: expect.any(Date) });
  });
});
