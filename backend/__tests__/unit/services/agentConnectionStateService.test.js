const { deriveAgentConnection } = require('../../../services/agentConnectionStateService');

const now = Date.parse('2026-10-23T16:00:00Z');
const seen = (minutes) => new Date(now - minutes * 60_000);

describe('agent connection verdict', () => {
  it('calls a revoked BYO key disconnected even after its bearer is removed', () => {
    expect(deriveAgentConnection({ runtimeType: 'webhook', credentials: [{ status: 'revoked' }], now }))
      .toEqual({ state: 'revoked', lastSeenAt: null });
  });

  it('uses the newest active key when an old key was revoked', () => {
    expect(deriveAgentConnection({ runtimeType: 'webhook', credentials: [
      { status: 'revoked' }, { status: 'active', lastUsedAt: seen(2) },
    ], now }).state).toBe('connected');
  });

  it('marks a listener unseen after five minutes', () => {
    expect(deriveAgentConnection({ runtimeType: 'webhook', credentials: [
      { status: 'active', lastUsedAt: seen(6) },
    ], now }).state).toBe('stale');
  });

  it('uses machine heartbeat for a wrapper', () => {
    expect(deriveAgentConnection({ runtimeType: 'wrapper', credentials: [
      { status: 'active' },
    ], machineCredentials: [{ status: 'active' }], machineLastSeenAt: seen(2), now }).state).toBe('stale');
  });

  it('does not let a live machine mask the agent runtime key being revoked', () => {
    expect(deriveAgentConnection({ runtimeType: 'wrapper', credentials: [
      { status: 'revoked' },
    ], machineCredentials: [{ status: 'active' }], machineLastSeenAt: seen(0), now }).state)
      .toBe('revoked');
  });

  it('does not call a live daemon an agent connection before a runtime key exists', () => {
    expect(deriveAgentConnection({ runtimeType: 'wrapper', credentials: [],
      machineCredentials: [{ status: 'active' }], machineLastSeenAt: seen(0), now }).state)
      .toBe('never');
  });

  it('preserves pre-ledger embedded tokens', () => {
    expect(deriveAgentConnection({ runtimeType: 'webhook', credentials: [], embeddedTokens: [
      { lastUsedAt: seen(2) },
    ], now }).state).toBe('connected');
  });
});
