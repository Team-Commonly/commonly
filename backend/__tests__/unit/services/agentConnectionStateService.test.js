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

  it('calls a polling listener on a computer connected while the daemon is silent', () => {
    expect(deriveAgentConnection({ runtimeType: 'wrapper', credentials: [
      { status: 'active', lastUsedAt: new Date(now - 10_000) },
    ], machineCredentials: [{ status: 'active' }], machineLastSeenAt: null, now }).state).toBe('connected');
  });

  it('does not let a live daemon stand in for a listener that stopped polling', () => {
    expect(deriveAgentConnection({ runtimeType: 'wrapper', credentials: [
      { status: 'active', lastUsedAt: seen(10) },
    ], machineCredentials: [{ status: 'active' }], machineLastSeenAt: seen(0), now }).state).toBe('stale');
  });

  it('never calls a computer agent connected from the heartbeat alone', () => {
    expect(deriveAgentConnection({ runtimeType: 'wrapper', credentials: [
      { status: 'active' },
    ], machineCredentials: [{ status: 'active' }], machineLastSeenAt: seen(0), now }).state).toBe('never');
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

  it('does not trust an embedded copy after its ledger row is revoked', () => {
    expect(deriveAgentConnection({ runtimeType: 'webhook', credentials: [
      { tokenHash: 'revoked-hash', status: 'revoked' },
    ], embeddedTokens: [{ tokenHash: 'revoked-hash', lastUsedAt: seen(0) }], now }))
      .toEqual({ state: 'revoked', lastSeenAt: null });
  });
});
