const {
  AGENT_AUTH_REFUSAL_REASONS, agentAuthRefusalCounts, credentialRefusalReason, recordAgentAuthRefusal,
  refusalFingerprint, refusalRoute, resetAgentAuthRefusalsForTest,
} = require('../../../services/agentAuthRefusals');

const HASH = 'deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb';

describe('agentAuthRefusals (TASK-712)', () => {
  let warn;
  beforeEach(() => {
    resetAgentAuthRefusalsForTest();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const lines = () => warn.mock.calls.map(([, json]) => JSON.parse(json));

  test('maps every fixed credential-gate message to a bounded reason', () => {
    expect(credentialRefusalReason('Token revoked')).toBe('token_revoked');
    expect(credentialRefusalReason('Credential owner is being deleted')).toBe('credential_owner_deleting');
    expect(credentialRefusalReason('Session token expired')).toBe('session_expired');
    expect(credentialRefusalReason('Issuing credential revoked')).toBe('issuing_credential_revoked');
    expect(credentialRefusalReason('Machine access revoked')).toBe('machine_access_revoked');
    expect(credentialRefusalReason('Invalid agent credential')).toBe('credential_invalid');
    expect(credentialRefusalReason('something unexpected')).toBe('credential_invalid');
  });

  test('fingerprint is the first 8 hex of the hash, and none without a token', () => {
    expect(refusalFingerprint(HASH)).toBe('deadbeef');
    expect(refusalFingerprint(undefined)).toBe('none');
    expect(refusalFingerprint(null)).toBe('none');
  });

  test('route is the mount prefix plus the route pattern, never a concrete url', () => {
    expect(refusalRoute({ baseUrl: '/api/agents/runtime', route: { path: '/pods/:podId/messages' } }))
      .toBe('/api/agents/runtime/pods/:podId/messages');
    expect(refusalRoute({ baseUrl: '/api/agents/runtime' })).toBe('/api/agents/runtime');
    expect(refusalRoute({})).toBe('unknown');
  });

  test('logs one line with the reason, route, method and fingerprint, and no token', () => {
    recordAgentAuthRefusal({ reason: 'invalid_token', route: '/r', method: 'POST', tokenHash: HASH, now: 1000 });
    expect(lines()).toEqual([{
      reason: 'invalid_token', route: '/r', method: 'POST', fingerprint: 'deadbeef', repeatsSinceLastLog: 0,
    }]);
  });

  test('rate-limits per reason and fingerprint, and reports the repeats on the next line', () => {
    const at = (ms) => recordAgentAuthRefusal({ reason: 'invalid_token', route: '/r', tokenHash: HASH, now: ms });
    at(0); at(1000); at(59_000);
    expect(lines()).toHaveLength(1);
    at(61_000);
    expect(lines()).toHaveLength(2);
    expect(lines()[1].repeatsSinceLastLog).toBe(2);
  });

  test('a different fingerprint or reason is its own line', () => {
    recordAgentAuthRefusal({ reason: 'invalid_token', route: '/r', tokenHash: HASH, now: 0 });
    recordAgentAuthRefusal({ reason: 'invalid_token', route: '/r', tokenHash: 'ffffffff' + HASH.slice(8), now: 0 });
    recordAgentAuthRefusal({ reason: 'agent_not_installed', route: '/r', tokenHash: HASH, now: 0 });
    expect(lines()).toHaveLength(3);
  });

  test('a spray of distinct tokens is capped by a global line budget, and counts keep counting', () => {
    for (let i = 0; i < 150; i += 1) {
      recordAgentAuthRefusal({
        reason: 'invalid_token', route: '/r', tokenHash: i.toString(16).padStart(8, '0') + HASH.slice(8), now: 0,
      });
    }
    expect(lines()).toHaveLength(100);
    expect(agentAuthRefusalCounts().counts.invalid_token).toBe(150);
  });

  test('counts are readable per reason, with every reason present and zeroed', () => {
    recordAgentAuthRefusal({ reason: 'missing_token', route: '/r', now: 0 });
    const { since, counts } = agentAuthRefusalCounts();
    expect(new Date(since).toString()).not.toBe('Invalid Date');
    expect(Object.keys(counts).sort()).toEqual([...AGENT_AUTH_REFUSAL_REASONS].sort());
    expect(counts.missing_token).toBe(1);
    expect(counts.token_revoked).toBe(0);
  });
});
