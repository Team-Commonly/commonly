const { cleanSignupTouch, signupSourceFields } = require('../../../utils/signupSource');

describe('signup source privacy boundary', () => {
  it('strips query, fragment and URL credentials, and ignores unrecognized keys', () => {
    const source = cleanSignupTouch({
      ref: ' X ', referrer: 'https://name:password@news.example/article?email=secret#token',
      landingPath: '/guides/a?invite=private#secret', firstSeenAt: '2026-01-01T00:00:00.000Z',
      authMethod: 'admin', extra: 'secret',
    });
    expect(source).toEqual({
      ref: 'x', referrer: 'https://news.example', landingPath: '/guides/a',
      firstSeenAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it.each([null, [], '{bad', 'x'.repeat(4097), { referrer: 'javascript:secret', landingPath: '//foreign.example', firstSeenAt: 'nope' }])(
    'drops malformed optional input without failing registration: %p', (input) => {
      expect(cleanSignupTouch(input)).toEqual({});
    },
  );

  it.each([
    '/v2/invite/SECRETinviteTOKEN123',
    '/v2/INVITE/short',
    '/v2/%69nvite/short',
    '/v2/%2569nvite%252Fshort',
    '/share/0123456789abcdef0123456789abcdef',
    '/share/550e8400-e29b-41d4-a716-446655440000',
    '/share/AbCdEfGhIjKlMnOpQrStUvWxYz012345', '/v2/%25252569nvite/short', '/bad/%zz',
  ])('drops path-embedded capabilities even from an old or forged client: %s', (path) => {
    expect(cleanSignupTouch({ landingPath: path, referrer: `https://news.example${path}` }))
      .toEqual({ referrer: 'https://news.example' });
  });

  it('retains a normal guide path while reducing even long referrer paths to an origin', () => {
    expect(cleanSignupTouch({ landingPath: '/guides/multi-agent-collaboration-platform',
      referrer: `https://news.example/${'a'.repeat(1500)}` })).toEqual({
      landingPath: '/guides/multi-agent-collaboration-platform', referrer: 'https://news.example',
    });
  });

  it('does not turn a later ref into the ref of an earlier direct visit', () => {
    expect(cleanSignupTouch({ landingPath: '/' }, 'later')).toEqual({ landingPath: '/' });
    expect(cleanSignupTouch(undefined, 'old-browser')).toEqual({ ref: 'old-browser' });
  });

  it('sets auth method and recording time on the server, even without browser storage', () => {
    const source = signupSourceFields({ authMethod: 'github', recordedAt: '1900-01-01' }, 'password');
    expect(source.signupSource).toEqual({ authMethod: 'password', recordedAt: expect.any(Date) });
  });
});
