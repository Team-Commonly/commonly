const { formatRelativeTime } = require('../../utils/formatRelativeTime');

describe('formatRelativeTime', () => {
  const now = new Date('2026-06-26T12:00:00.000Z');

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('returns minutes and hours for recent dates', () => {
    expect(formatRelativeTime(new Date('2026-06-26T11:58:00.000Z'))).toBe('2m');
    expect(formatRelativeTime(new Date('2026-06-26T09:00:00.000Z'))).toBe('3h');
  });

  it('returns Yesterday for the prior day', () => {
    expect(formatRelativeTime(new Date('2026-06-25T18:00:00.000Z'))).toBe('Yesterday');
  });
});
