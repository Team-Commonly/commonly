// F668: on 2026-11-26 the prod event loop stalled 3-4 s at 15:00:12 and
// 15:00:22 with nothing else on the box. Every job that ran hourly or every
// 10/15 minutes fired on :00 together: the hourly summarizer, the social-feed
// sync, agent-event GC and the spend alarm, on top of the per-minute and
// five-minute passes. These tests pin the cron table so the sparse jobs (six
// or fewer runs in an hour) each own their minutes. Schedules are read through
// node-cron's own matcher, the code that decides when a job fires.
jest.mock('node-cron', () => ({
  ...jest.requireActual('node-cron'),
  schedule: jest.fn((expression, fn) => ({
    expression, fn, start: jest.fn(), stop: jest.fn(),
  })),
}));

const TimeMatcher = require('node-cron/src/time-matcher');
const cron = require('node-cron');
const scheduler = require('../../../services/schedulerService');

const minutesIn = (expression, hour) => {
  const matcher = new TimeMatcher(expression, 'UTC');
  const minutes = [];
  for (let m = 0; m < 60; m += 1) {
    if (matcher.match(new Date(Date.UTC(2026, 10, 26, hour, m, 0)))) minutes.push(m);
  }
  return minutes;
};

let expressions;
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  cron.schedule.mockClear();
  scheduler.start();
  expressions = cron.schedule.mock.calls.map(([expression]) => expression);
  scheduler.stop();
});
afterAll(() => jest.restoreAllMocks());

describe('cron table (F668)', () => {
  it('registered the jobs this test reasons about', () => {
    expect(expressions.length).toBeGreaterThanOrEqual(20);
  });

  it('no two sparse jobs start in the same minute, in any hour of the day', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const owner = new Map();
      expressions.forEach((expression, index) => {
        const minutes = minutesIn(expression, hour);
        if (minutes.length === 0 || minutes.length > 6) return;
        for (const m of minutes) {
          expect({ hour, minute: m, also: owner.get(m) || null, expression })
            .toEqual({ hour, minute: m, also: null, expression });
          owner.set(m, `${index}:${expression}`);
        }
      });
    }
  });

  it('no job that runs every hour, every 10 or every 15 minutes starts on :00', () => {
    expressions.forEach((expression) => {
      const perHour = Array.from({ length: 24 }, (_, h) => minutesIn(expression, h));
      const everyHour = perHour.every((ms) => ms.length > 0);
      const sparse = perHour.every((ms) => ms.length <= 6);
      if (!everyHour || !sparse) return;
      expect({ expression, onTheHour: perHour[0].includes(0) }).toEqual({ expression, onTheHour: false });
    });
  });

  it('keeps each moved job at its frequency, evenly spaced', () => {
    const { SPREAD_JOB_SCHEDULES } = scheduler;
    const expected = {
      summarizer: 1, externalFeed: 6, agentEventGc: 6, spendAlarm: 4,
    };
    for (const [name, count] of Object.entries(expected)) {
      const minutes = minutesIn(SPREAD_JOB_SCHEDULES[name], 3);
      expect({ name, count: minutes.length }).toEqual({ name, count });
      const gap = 60 / count;
      expect(minutes.slice(1).map((m, i) => m - minutes[i])).toEqual(Array(count - 1).fill(gap));
      expect(expressions).toContain(SPREAD_JOB_SCHEDULES[name]);
    }
  });
});
