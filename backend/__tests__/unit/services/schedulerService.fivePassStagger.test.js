// The heavier five-minute passes each start on their own minute. On
// 2026-11-02 two readiness windows lined up with the :30 and :35 ticks, where
// ensemble, onboarding-silence, installable-reconciler and stalled-connect all
// started in the same second. These tests read the schedules through
// node-cron's own matcher, the code that decides when a job fires: node-cron
// 3.0.3 accepts `2-59/5` but fires it at :05, :10, …, so checking the strings
// alone would pass a schedule that still stacks.
jest.mock('node-cron', () => ({
  ...jest.requireActual('node-cron'),
  schedule: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
}));

const TimeMatcher = require('node-cron/src/time-matcher');
const cron = require('node-cron');
const scheduler = require('../../../services/schedulerService');

const { FIVE_MINUTE_PASS_SCHEDULES } = scheduler;
const KERNEL_SWEEP = '4,14,24,34,44,54 * * * *';

const minutesOf = (expression) => {
  const matcher = new TimeMatcher(expression, 'UTC');
  const minutes = [];
  for (let m = 0; m < 60; m += 1) {
    if (matcher.match(new Date(Date.UTC(2026, 10, 2, 3, m, 0)))) minutes.push(m);
  }
  return minutes;
};

describe('five-minute pass stagger', () => {
  it('still runs each pass every five minutes', () => {
    for (const [name, expression] of Object.entries(FIVE_MINUTE_PASS_SCHEDULES)) {
      const minutes = minutesOf(expression);
      expect({ name, count: minutes.length }).toEqual({ name, count: 12 });
      expect(minutes.slice(1).map((m, i) => m - minutes[i])).toEqual(Array(11).fill(5));
    }
  });

  it('never starts two of them, or one and kernel-sweep, in the same minute', () => {
    const owner = new Map();
    for (const [name, expression] of [...Object.entries(FIVE_MINUTE_PASS_SCHEDULES), ['kernelSweep', KERNEL_SWEEP]]) {
      for (const m of minutesOf(expression)) {
        expect({ minute: m, also: owner.get(m) || null, name }).toEqual({ minute: m, also: null, name });
        owner.set(m, name);
      }
    }
  });

  it('is what start() hands to node-cron, and kernel-sweep is where this test assumes', () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    scheduler.start();
    try {
      const expressions = cron.schedule.mock.calls.map(([expression]) => expression);
      for (const expression of Object.values(FIVE_MINUTE_PASS_SCHEDULES)) {
        expect(expressions).toContain(expression);
      }
      expect(expressions).toContain(KERNEL_SWEEP);
    } finally {
      scheduler.stop();
      jest.restoreAllMocks();
    }
  });
});
