/**
 * agentStateService.deriveAgentState — the ONE bucket vocabulary (Raft
 * comparison P4). Pinned here so a surface-local rewrite of the thresholds
 * shows up as a red test, not as two surfaces disagreeing in front of a
 * user asking "is my agent connected?".
 */
const { deriveAgentState } = require('../../../services/agentStateService');

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);

describe('deriveAgentState', () => {
  test('no signal + webhook runtime = never-connected (the connect step was not finished)', () => {
    expect(deriveAgentState(null, 'webhook')).toBe('never-connected');
    expect(deriveAgentState(undefined, 'moltbot')).toBe('never-connected');
  });

  test('no signal + native runtime = ready — native agents have no connection to make (#915 lesson)', () => {
    expect(deriveAgentState(null, 'native')).toBe('ready');
  });

  test('seen within 10 minutes = active', () => {
    expect(deriveAgentState(minutesAgo(3), 'webhook')).toBe('active');
  });

  test('seen within a day = idle', () => {
    expect(deriveAgentState(minutesAgo(120), 'webhook')).toBe('idle');
  });

  test('silent for over a day = stale', () => {
    expect(deriveAgentState(minutesAgo(60 * 25), 'webhook')).toBe('stale');
  });
});
