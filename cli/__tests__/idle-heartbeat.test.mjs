/**
 * 11-10: an idle seat and a wedged one printed the same nothing, so six healthy
 * seats were read as wedged. A seat that keeps polling and finds nothing now
 * says so on a slow cadence.
 */
import { jest } from '@jest/globals';
import { createIdleHeartbeat, resolveIdleLineMs, IDLE_LINE_DEFAULT_MS } from '../src/lib/poll-liveness.js';

const at = (iso) => Date.parse(iso);

describe('createIdleHeartbeat', () => {
  test('one line per cadence while idle, naming the count and when the quiet began', () => {
    let now = at('2026-11-10T03:52:00Z');
    const log = jest.fn();
    const beat = createIdleHeartbeat({ everyMs: 10 * 60 * 1000, log, now: () => now });

    beat.empty();
    for (let i = 0; i < 119; i += 1) { now += 5000; beat.empty(); }
    expect(log).not.toHaveBeenCalled();
    now += 5000;
    beat.empty();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith('polling ok (121 empty polls since 03:52Z)');

    now += 5000;
    beat.empty();
    expect(log).toHaveBeenCalledTimes(1);
  });

  test('work restarts the count, so a busy seat prints nothing extra', () => {
    let now = at('2026-11-10T04:00:00Z');
    const log = jest.fn();
    const beat = createIdleHeartbeat({ everyMs: 1000, log, now: () => now });
    beat.empty();
    now += 900;
    beat.busy();
    now += 900;
    beat.empty();
    expect(log).not.toHaveBeenCalled();
    now += 1000;
    beat.empty();
    expect(log).toHaveBeenLastCalledWith('polling ok (2 empty polls since 04:00Z)');
  });

  test('the cadence comes from the option, then COMMONLY_IDLE_LINE_MS, then ten minutes', () => {
    expect(resolveIdleLineMs(500, {})).toBe(500);
    expect(resolveIdleLineMs(undefined, { COMMONLY_IDLE_LINE_MS: '2000' })).toBe(2000);
    expect(resolveIdleLineMs(undefined, { COMMONLY_IDLE_LINE_MS: 'x' })).toBe(IDLE_LINE_DEFAULT_MS);
    expect(IDLE_LINE_DEFAULT_MS).toBe(10 * 60 * 1000);
  });
});
