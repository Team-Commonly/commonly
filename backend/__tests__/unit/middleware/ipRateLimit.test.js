// @ts-nocheck

const { ipKeyGenerator } = require('express-rate-limit');
const { cloudflareIpRateLimitKeyGenerator } = require('../../../middleware/ipRateLimit');

describe('cloudflareIpRateLimitKeyGenerator', () => {
  it('prefers CF-Connecting-IP over req.ip', () => {
    const key = cloudflareIpRateLimitKeyGenerator({
      headers: { 'cf-connecting-ip': '198.51.100.10' },
      ip: '203.0.113.7',
    });

    expect(key).toBe(ipKeyGenerator('198.51.100.10'));
  });

  it('falls back to req.ip when the Cloudflare header is absent', () => {
    const key = cloudflareIpRateLimitKeyGenerator({
      headers: {},
      ip: '203.0.113.7',
    });

    expect(key).toBe(ipKeyGenerator('203.0.113.7'));
  });

  it('returns anon when neither header nor req.ip is present', () => {
    const key = cloudflareIpRateLimitKeyGenerator({
      headers: {},
    });

    expect(key).toBe('anon');
  });
});

const { transportPeerRateLimitKeyGenerator, authenticatedUserRateLimitKeyGenerator } = require('../../../middleware/ipRateLimit');

describe('account mutation quota keys', () => {
  it('uses the transport peer despite conflicting forwarding headers', () => {
    expect(transportPeerRateLimitKeyGenerator({ socket: { remoteAddress: '192.0.2.4' },
      ip: '203.0.113.5', headers: { 'cf-connecting-ip': '198.51.100.6' } }))
      .toBe(ipKeyGenerator('192.0.2.4'));
  });
  it('uses the authenticated account rather than bearer or forwarding headers', () => {
    expect(authenticatedUserRateLimitKeyGenerator({ userId: 'one', headers: { authorization: 'rotated' } }))
      .toBe('user:one');
    expect(authenticatedUserRateLimitKeyGenerator({ userId: 'two' })).toBe('user:two');
  });
});
