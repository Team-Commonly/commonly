// @ts-nocheck
// ADR-003 Phase 4: agentRateLimit key-generator tests.
//
// The express-rate-limit invocation itself is inlined in
// routes/agentsRuntime.ts (so CodeQL recognises it). This module only
// exposes the key generator — these tests cover that the same caller
// produces a stable key across requests, and that different callers
// produce distinct keys.

const crypto = require('crypto');
const { agentRateLimitKeyGenerator } = require('../../../middleware/agentRateLimit');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('agentRateLimitKeyGenerator', () => {
  it('uses agentTokenHash when set (the common case after agentRuntimeAuth)', () => {
    const k = agentRateLimitKeyGenerator({
      agentTokenHash: 'abc123',
      headers: { authorization: 'Bearer raw' },
      ip: '10.0.0.1',
    });
    expect(k).toBe('tok:abc123');
  });

  it('falls back to a hash of the Authorization header when agentTokenHash absent', () => {
    const k = agentRateLimitKeyGenerator({
      headers: { authorization: 'Bearer raw-token-xyz' },
      ip: '10.0.0.1',
    });
    expect(k).toBe(`hdr:${sha('Bearer raw-token-xyz')}`);
  });

  it('falls back to remote IP when no token-bearing header is present', () => {
    const k = agentRateLimitKeyGenerator({
      headers: {},
      ip: '203.0.113.7',
    });
    expect(k).toBe('ip:203.0.113.7');
  });

  // #652 ERR_ERL_KEY_GEN_IPV6: two addresses inside the same IPv6 prefix must
  // share one bucket, or a client rotating within its allocation bypasses the
  // limit entirely.
  it('collapses IPv6 addresses in the same prefix to one key', () => {
    const a = agentRateLimitKeyGenerator({
      headers: {},
      ip: '2001:db8:85a3:8d3:1319:8a2e:370:7348',
    });
    const b = agentRateLimitKeyGenerator({
      headers: {},
      ip: '2001:db8:85a3:8d3:aaaa:bbbb:cccc:dddd',
    });
    expect(a).toBe(b);
    expect(a).not.toBe('ip:2001:db8:85a3:8d3:1319:8a2e:370:7348');
  });

  it('returns the same key for two requests with the same token', () => {
    const req = {
      agentTokenHash: 'same-hash',
      headers: { authorization: 'Bearer raw' },
      ip: '10.0.0.1',
    };
    expect(agentRateLimitKeyGenerator(req)).toBe(agentRateLimitKeyGenerator({ ...req }));
  });

  it('returns different keys for different tokens', () => {
    const a = agentRateLimitKeyGenerator({ agentTokenHash: 'alice' });
    const b = agentRateLimitKeyGenerator({ agentTokenHash: 'bob' });
    expect(a).not.toBe(b);
  });

  it('handles the x-commonly-agent-token header alongside Authorization', () => {
    const k = agentRateLimitKeyGenerator({
      headers: { 'x-commonly-agent-token': 'xtok' },
      ip: '10.0.0.1',
    });
    expect(k).toBe(`hdr:${sha('xtok')}`);
  });
});
