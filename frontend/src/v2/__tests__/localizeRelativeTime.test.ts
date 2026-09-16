import { localizeRelativeTime, relativeParts, relativeTime } from '../utils/localizeRelativeTime';

const translate = jest.fn((key: string, options: { defaultValue: string }) => options.defaultValue) as any;

const at = (iso: string) => new Date(iso).toISOString();

describe('localizeRelativeTime', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-16T08:00:00.000Z').getTime()));
  afterEach(() => {
    jest.restoreAllMocks();
    translate.mockClear();
  });

  it('localizes missing connector timestamps and clamps future connector timestamps', () => {
    const options = { includeFuture: false, missing: 'just now', rounding: 'floor' } as const;
    expect(relativeParts(undefined, options)).toEqual({ kind: 'missing' });
    expect(localizeRelativeTime(undefined, translate, options)).toBe('just now');
    expect(translate).not.toHaveBeenCalled();
    expect(relativeParts(at('2026-09-16T08:02:00.000Z'), options)).toEqual({ kind: 'now', future: false });
    expect(localizeRelativeTime(at('2026-09-16T08:02:00.000Z'), translate, options)).toBe('just now');
    expect(translate).toHaveBeenCalledWith('time.justNow', { defaultValue: 'just now' });
  });

  it.each([
    ['minutes ago', '2026-09-16T07:58:00.000Z', { kind: 'rel', unit: 'minute', count: 2, future: false }, 'time.minutesAgo', '2m ago'],
    ['hours ago', '2026-09-16T06:00:00.000Z', { kind: 'rel', unit: 'hour', count: 2, future: false }, 'time.hoursAgo', '2h ago'],
    ['days ago', '2026-09-14T08:00:00.000Z', { kind: 'rel', unit: 'day', count: 2, future: false }, 'time.daysAgo', '2d ago'],
    ['minutes from now', '2026-09-16T08:02:00.000Z', { kind: 'rel', unit: 'minute', count: 2, future: true }, 'time.minutesFromNow', '2m from now'],
    ['hours from now', '2026-09-16T10:00:00.000Z', { kind: 'rel', unit: 'hour', count: 2, future: true }, 'time.hoursFromNow', '2h from now'],
    ['days from now', '2026-09-18T08:00:00.000Z', { kind: 'rel', unit: 'day', count: 2, future: true }, 'time.daysFromNow', '2d from now'],
  ])('formats %s from the same relative parts in English and localized output', (_label, date, expectedParts, key, expectedEnglish) => {
    const options = { rounding: 'floor' } as const;
    expect(relativeParts(at(date as string), options)).toEqual(expectedParts);
    expect(relativeTime(at(date as string), options)).toBe(expectedEnglish);
    expect(localizeRelativeTime(at(date as string), translate, options)).toBe(expectedEnglish);
    expect(translate).toHaveBeenCalledWith(key, { count: 2, defaultValue: expectedEnglish });
  });
});
