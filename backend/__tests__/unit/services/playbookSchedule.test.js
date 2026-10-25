const { latestScheduleSlot, validateSchedule } = require('../../../services/playbooks/schedule');
const before = new Date('2026-01-01T00:00:00Z');
const schedule = (cron) => ({ cron, timezone: 'America/Los_Angeles' });

test.each(['0 9 * * *', '5 16 * * 1-5', '59 23 * * 0'])('accepts a supported schedule %s', (cron) => {
  expect(validateSchedule(schedule(cron))).toEqual(schedule(cron));
});
test.each(['*/5 * * * *', '60 9 * * *', '0 24 * * *', '0 9 1 * *', '0 9 * * 1,3', '0 9 * * 7', '@daily'])('refuses arbitrary cron %s', (cron) => {
  expect(() => validateSchedule(schedule(cron))).toThrow('HH:MM');
});
test('refuses invalid timezone', () => {
  expect(() => validateSchedule({ cron: '0 9 * * *', timezone: 'not/a/timezone' })).toThrow('IANA');
});
test('fires the spring-forward 02:30 slot at 03:00 and retains its nominal key', () => {
  const slot = latestScheduleSlot(schedule('30 2 * * *'), before, new Date('2026-03-08T10:00:00Z'));
  expect(slot.key).toBe('schedule:2026-03-08T02:30');
  expect(slot.at.toISOString()).toBe('2026-03-08T10:00:00.000Z');
  expect(latestScheduleSlot(schedule('30 2 * * *'), before, new Date('2026-03-08T09:59:00Z'))).toBeNull();
});
test('the repeated fall-back hour is one slot and never becomes an hour-late new slot', () => {
  const first = latestScheduleSlot(schedule('30 1 * * *'), before, new Date('2026-11-01T08:30:00Z'));
  expect(first.key).toBe('schedule:2026-11-01T01:30');
  expect(latestScheduleSlot(schedule('30 1 * * *'), before, new Date('2026-11-01T09:30:00Z'))).toBeNull();
  // Turning On during the repeated hour must not resurrect a pre-On slot.
  expect(latestScheduleSlot(schedule('30 1 * * *'), new Date('2026-11-01T09:00:00Z'), new Date('2026-11-01T09:31:00Z'))).toBeNull();
});
test('runs after onAt, less than one hour late, and only on the selected weekday', () => {
  expect(latestScheduleSlot(schedule('0 9 * * 1'), before, new Date('2026-10-26T16:59:59Z'))?.key).toBe('schedule:2026-10-26T09:00');
  expect(latestScheduleSlot(schedule('0 9 * * 1'), before, new Date('2026-10-26T17:00:00Z'))).toBeNull();
  expect(latestScheduleSlot(schedule('0 9 * * 1'), new Date('2026-10-26T16:00:00Z'), new Date('2026-10-26T16:01:00Z'))).toBeNull();
  expect(latestScheduleSlot(schedule('0 9 * * 1-5'), before, new Date('2026-10-25T16:00:00Z'))).toBeNull();
});

test('catches a midnight spring gap across the local date boundary', () => {
  const slot = latestScheduleSlot({ cron: '30 0 * * 0', timezone: 'America/Santiago' }, before, new Date('2026-09-06T04:00:00Z'));
  expect(slot.key).toBe('schedule:2026-09-06T00:30');
  expect(slot.at.toISOString()).toBe('2026-09-06T04:00:00.000Z');
});
