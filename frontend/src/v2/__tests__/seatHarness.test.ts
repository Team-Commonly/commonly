import { seatHarness } from '../components/V2AgentBYO';

// F353: the harness a reconnect opens on, read from the roster's runtime.
test('names the harness agent run --adapter takes, preferring what the seat reports over its declared type', () => {
  expect(seatHarness({ runtimeType: 'codex' })).toBe('codex');
  expect(seatHarness({ runtimeType: 'claude-code' })).toBe('claude');
  expect(seatHarness({ runtimeType: 'wrapper', adapter: 'opencode' })).toBe('opencode');
  expect(seatHarness({ runtimeType: 'claude-code', reportedCli: 'codex' })).toBe('codex');
  // A declared adapter is a binding, so it beats the poller's self-report.
  expect(seatHarness({ runtimeType: 'webhook', adapter: 'codex', reportedCli: 'claude' })).toBe('codex');
});

test('says nothing when the runtime names no known harness', () => {
  expect(seatHarness({ runtimeType: 'webhook' })).toBeNull();
  expect(seatHarness(undefined)).toBeNull();
});
