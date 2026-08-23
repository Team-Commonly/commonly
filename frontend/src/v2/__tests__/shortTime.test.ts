import { shortTimeSince } from '../utils/shortTime';

const NOW = new Date('2026-08-22T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60000;
const HOUR = 60 * MIN;

describe('shortTimeSince', () => {
  test('under a minute reads "now", not "0m"', () => {
    expect(shortTimeSince(ago(30000), NOW)).toBe('now');
  });

  test('minutes below an hour', () => {
    expect(shortTimeSince(ago(2 * MIN), NOW)).toBe('2m');
    expect(shortTimeSince(ago(59 * MIN), NOW)).toBe('59m');
  });

  test('the minute/hour boundary is exactly 60', () => {
    expect(shortTimeSince(ago(60 * MIN), NOW)).toBe('1h');
  });

  test('hours below a day', () => {
    expect(shortTimeSince(ago(23 * HOUR), NOW)).toBe('23h');
  });

  test('past a day falls to the calendar comparison', () => {
    // 25h before noon is 11:00 the previous date.
    expect(shortTimeSince(ago(25 * HOUR), NOW)).toBe('Yesterday');
  });

  test('two days back is not Yesterday', () => {
    expect(shortTimeSince(ago(49 * HOUR), NOW)).toBe('2d');
  });

  test('a week or more reads in weeks', () => {
    expect(shortTimeSince(ago(8 * 24 * HOUR), NOW)).toBe('1w');
  });

  test('a future timestamp reads "now" rather than a negative age', () => {
    // Server/browser clock skew, not an error worth surfacing in six chars.
    expect(shortTimeSince(new Date(NOW.getTime() + 5 * MIN), NOW)).toBe('now');
  });

  test('missing or unparseable input renders nothing', () => {
    expect(shortTimeSince(undefined, NOW)).toBe('');
    expect(shortTimeSince(null, NOW)).toBe('');
    expect(shortTimeSince('not a date', NOW)).toBe('');
  });
});
