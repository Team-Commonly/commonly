/**
 * A supplied base URL only SELECTS one the operator configured. The value
 * returned is always the allowlist's own entry, never the input
 * (review-checklist rule 54). The cases that carry the weight are the near
 * misses: another host sharing an allowed prefix, userinfo before an allowed
 * host, and a different port, scheme or path.
 */
const { selectAllowedBaseUrl, allowedFromEnv } = require('../../../utils/allowedBaseUrl');

const ALLOWED = ['https://openrouter.ai/api/v1', 'ws://clawdbot-gateway.commonly-dev.svc.cluster.local:18789'];

describe('selectAllowedBaseUrl', () => {
  test('returns the allowlist entry the request names', () => {
    expect(selectAllowedBaseUrl('https://openrouter.ai/api/v1', ALLOWED)).toBe('https://openrouter.ai/api/v1');
    expect(selectAllowedBaseUrl('ws://clawdbot-gateway.commonly-dev.svc.cluster.local:18789', ALLOWED))
      .toBe('ws://clawdbot-gateway.commonly-dev.svc.cluster.local:18789');
  });

  test('matches through trailing slashes and host case, and returns the ENTRY, not the input', () => {
    expect(selectAllowedBaseUrl('https://OpenRouter.AI/api/v1///', ALLOWED)).toBe('https://openrouter.ai/api/v1');
    expect(selectAllowedBaseUrl(' https://openrouter.ai/api/v1/ ', ['https://openrouter.ai/api/v1/'])).toBe('https://openrouter.ai/api/v1');
  });

  test.each([
    ['another host', 'https://other.example/api/v1'],
    ['an allowed host as a subdomain prefix', 'https://openrouter.ai.other.example/api/v1'],
    ['userinfo before an allowed host', 'https://user:pass@openrouter.ai/api/v1'],
    ['a different scheme', 'http://openrouter.ai/api/v1'],
    ['a different port', 'https://openrouter.ai:8443/api/v1'],
    ['a different path', 'https://openrouter.ai/api/v2'],
    ['a path suffix', 'https://openrouter.ai/api/v1/../../x'],
    ['a query string', 'https://openrouter.ai/api/v1?x=1'],
    ['not a URL', 'openrouter.ai/api/v1'],
    ['a non-string', { toString: () => 'https://openrouter.ai/api/v1' }],
  ])('refuses %s', (_label, requested) => {
    expect(selectAllowedBaseUrl(requested, ALLOWED)).toBeNull();
  });

  test('a blank request is null, so the caller picks its own default', () => {
    expect(selectAllowedBaseUrl('', ALLOWED)).toBeNull();
    expect(selectAllowedBaseUrl(undefined, ALLOWED)).toBeNull();
    expect(selectAllowedBaseUrl(null, ALLOWED)).toBeNull();
  });

  test('blank and unparseable allowlist entries match nothing', () => {
    expect(selectAllowedBaseUrl('https://openrouter.ai/api/v1', ['', null, undefined, 'not a url'])).toBeNull();
  });
});

describe('allowedFromEnv', () => {
  const saved = process.env.TEST_ALLOWED_URLS;
  afterEach(() => {
    if (saved === undefined) delete process.env.TEST_ALLOWED_URLS;
    else process.env.TEST_ALLOWED_URLS = saved;
  });

  test('splits a comma list and drops blanks; unset is empty', () => {
    delete process.env.TEST_ALLOWED_URLS;
    expect(allowedFromEnv('TEST_ALLOWED_URLS')).toEqual([]);
    process.env.TEST_ALLOWED_URLS = ' https://a.example/v1 , ,https://b.example ';
    expect(allowedFromEnv('TEST_ALLOWED_URLS')).toEqual(['https://a.example/v1', 'https://b.example']);
  });
});
