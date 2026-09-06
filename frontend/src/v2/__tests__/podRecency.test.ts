import {
  POD_VISITS_KEY, podInitials, readPodVisits, recordPodVisit, relativeTime,
} from '../lib/podRecency';

describe('podRecency', () => {
  beforeEach(() => localStorage.clear());

  test('relativeTime is one number and one unit, never a date', () => {
    const now = Date.parse('2026-09-06T12:00:00.000Z');
    expect(relativeTime('2026-09-06T11:59:40.000Z', now)).toBe('now');
    expect(relativeTime('2026-09-06T11:51:00.000Z', now)).toBe('9m');
    expect(relativeTime('2026-09-06T09:00:00.000Z', now)).toBe('3h');
    expect(relativeTime('2026-09-04T12:00:00.000Z', now)).toBe('2d');
    expect(relativeTime('2026-08-20T12:00:00.000Z', now)).toBe('2w');
    expect(relativeTime('2026-07-07T12:00:00.000Z', now)).toBe('2mo');
    expect(relativeTime('2024-09-06T12:00:00.000Z', now)).toBe('2y');
    expect(relativeTime(null, now)).toBe('');
    expect(relativeTime('not a date', now)).toBe('');
  });

  test('a future timestamp reads as now, not as a negative age', () => {
    const now = Date.parse('2026-09-06T12:00:00.000Z');
    expect(relativeTime('2026-09-06T12:05:00.000Z', now)).toBe('now');
  });

  test('the visit log survives a round trip and ignores garbage', () => {
    expect(readPodVisits()).toEqual({});
    recordPodVisit('a', 10);
    recordPodVisit('b', 20);
    expect(readPodVisits()).toEqual({ a: 10, b: 20 });
    localStorage.setItem(POD_VISITS_KEY, '{"a": "ten", "c": 30, "d": null}');
    expect(readPodVisits()).toEqual({ c: 30 });
    localStorage.setItem(POD_VISITS_KEY, 'not json');
    expect(readPodVisits()).toEqual({});
  });

  test('podInitials takes two words, or two letters of one', () => {
    expect(podInitials('Connectors v2')).toBe('CV');
    expect(podInitials('Sharpen')).toBe('SH');
    expect(podInitials('  Payments — memory demo ')).toBe('P—');
    expect(podInitials('')).toBe('·');
  });
});
