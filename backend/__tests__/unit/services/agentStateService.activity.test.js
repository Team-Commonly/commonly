/**
 * agentStateService.deriveActivityBucket — the coarse activity vocabulary
 * (Raft P4). SEPARATE file from agentStateService.test.js on purpose: the
 * first version of this suite was written AT that path and silently
 * replaced the #891 honesty-rules suite — which is exactly why the clobber
 * it should have caught shipped (2026-08-13 live incident).
 */
const { deriveActivityBucket } = require('../../../services/agentStateService');

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);

describe('deriveActivityBucket', () => {
  test('no signal + webhook runtime = never-connected (the connect step was not finished)', () => {
    expect(deriveActivityBucket(null, 'webhook')).toBe('never-connected');
    expect(deriveActivityBucket(undefined, 'moltbot')).toBe('never-connected');
  });

  test('no signal + native runtime = ready — native agents have no connection to make (#915 lesson)', () => {
    expect(deriveActivityBucket(null, 'native')).toBe('ready');
  });

  test('seen within 5 minutes = active', () => {
    expect(deriveActivityBucket(minutesAgo(3), 'webhook')).toBe('active');
  });

  test('the five-minute boundary: active at exactly 5 minutes, idle just past it', () => {
    const now = new Date('2026-10-30T12:00:00Z').getTime();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(deriveActivityBucket(new Date(now - 5 * 60 * 1000), 'webhook')).toBe('active');
      expect(deriveActivityBucket(new Date(now - 5 * 60 * 1000 - 1), 'webhook')).toBe('idle');
    } finally {
      spy.mockRestore();
    }
  });

  test('seen seven minutes ago = idle, matching the five-minute connection window', () => {
    expect(deriveActivityBucket(minutesAgo(7), 'webhook')).toBe('idle');
  });

  test('seen within a day = idle', () => {
    expect(deriveActivityBucket(minutesAgo(120), 'webhook')).toBe('idle');
  });

  test('silent for over a day = stale', () => {
    expect(deriveActivityBucket(minutesAgo(60 * 25), 'webhook')).toBe('stale');
  });
});
