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
