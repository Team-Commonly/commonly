import { localizeRelativeTime, relativeTime } from '../utils/localizeRelativeTime';

const translate = ((key: string, options: { defaultValue: string }) => ({
  'time.justNow': '刚刚',
  'time.inAMoment': '即将',
  'time.minutesAgo': `${options.defaultValue}（本地化）`,
}[key] || options.defaultValue)) as any;

describe('localizeRelativeTime', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-16T08:00:00.000Z').getTime()));
  afterEach(() => jest.restoreAllMocks());

  it('localizes missing connector timestamps and clamps future connector timestamps', () => {
    expect(localizeRelativeTime(undefined, translate, { includeFuture: false, missing: 'just now', rounding: 'floor' })).toBe('刚刚');
    expect(localizeRelativeTime('2026-09-16T08:02:00.000Z', translate, { includeFuture: false, missing: 'just now', rounding: 'floor' })).toBe('刚刚');
  });

  it('keeps future output for tools while sharing the same formatter', () => {
    expect(relativeTime('2026-09-16T08:02:00.000Z')).toBe('2m from now');
    expect(localizeRelativeTime('2026-09-16T08:02:00.000Z', translate)).toBe('2m from now');
  });
});
