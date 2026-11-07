jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: {} }));
jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));

const {
  CATCH_UP_MINUTES,
  SCHEDULE_PROMPT_MAX_CHARS,
  buildScheduleContent,
  dueDay,
  invalidScheduleField,
  takesSchedule,
} = require('../../../services/agentScheduleService');

const LA = 'America/Los_Angeles';
const valid = {
  enabled: true, time: '07:47', timezone: LA, prompt: 'Post the morning count.',
};

describe('invalidScheduleField', () => {
  it('accepts a whole schedule', () => {
    expect(invalidScheduleField(valid)).toBeNull();
  });

  it.each([
    ['enabled', { enabled: 'yes' }],
    ['time', { time: '7:47' }],
    ['time', { time: '24:00' }],
    ['time', { time: 747 }],
    ['timezone', { timezone: 'Mars/Olympus' }],
    ['timezone', { timezone: '' }],
    ['prompt', { prompt: '   ' }],
    ['prompt', { prompt: 'x'.repeat(SCHEDULE_PROMPT_MAX_CHARS + 1) }],
  ])('names %s', (field, change) => {
    expect(invalidScheduleField({ ...valid, ...change }).field).toBe(field);
  });
});

describe('dueDay', () => {
  it('is due at the local time, not the UTC one', () => {
    // 07:50 in Los Angeles during PST.
    expect(dueDay(valid, new Date('2026-11-07T15:50:00Z'))).toBe('2026-11-07');
    expect(dueDay(valid, new Date('2026-11-07T07:50:00Z'))).toBeNull();
  });

  it('follows daylight saving', () => {
    // 07:50 PDT, a day before the clocks changed.
    expect(dueDay(valid, new Date('2026-10-31T14:50:00Z'))).toBe('2026-10-31');
  });

  it('is not due before the time', () => {
    expect(dueDay(valid, new Date('2026-11-07T15:40:00Z'))).toBeNull();
  });

  it('catches up inside the window and gives the day up past it', () => {
    const edge = new Date(Date.parse('2026-11-07T15:47:00Z') + CATCH_UP_MINUTES * 60 * 1000);
    expect(dueDay(valid, edge)).toBe('2026-11-07');
    expect(dueDay(valid, new Date(edge.getTime() + 60 * 1000))).toBeNull();
  });

  it('counts a wake set near midnight against the day it was set for', () => {
    const late = { time: '23:55', timezone: 'UTC' };
    expect(dueDay(late, new Date('2026-11-08T00:00:00Z'))).toBe('2026-11-07');
    expect(dueDay(late, new Date('2026-11-07T23:56:00Z'))).toBe('2026-11-07');
  });

  it('crosses a month and a year when it looks back a day', () => {
    expect(dueDay({ time: '23:55', timezone: 'UTC' }, new Date('2027-01-01T00:05:00Z'))).toBe('2026-12-31');
  });
});

describe('buildScheduleContent', () => {
  it('carries the owner\'s words, the pod, and the way to stay quiet', () => {
    const content = buildScheduleContent('Post the morning count.', 'pod-1');
    expect(content).toContain('Post the morning count.');
    expect(content).toContain('podId: pod-1');
    expect(content).toContain('NO_REPLY');
  });
});

describe('takesSchedule', () => {
  const runtime = (config) => ({ config: { runtime: config } });

  it.each([
    [{ runtimeType: 'local-cli', host: 'byo' }],
    [{ runtimeType: 'local-cli' }],
    [{ runtimeType: 'webhook' }],
  ])('takes an agent you run yourself: %j', (config) => {
    expect(takesSchedule(runtime(config))).toBe(true);
  });

  it.each([
    [{ runtimeType: 'moltbot' }],
    [{ runtimeType: 'internal' }],
    [{ runtimeType: 'native' }],
    [{ runtimeType: 'hosted' }],
    [{}],
  ])('refuses the rest: %j', (config) => {
    expect(takesSchedule(runtime(config))).toBe(false);
  });
});

describe('a wake in a daylight saving gap', () => {
  it('fires at the first tick after the jump', () => {
    const schedule = { time: '02:30', timezone: 'America/Los_Angeles' };
    expect(dueDay(schedule, new Date('2026-03-08T09:59:00Z'))).toBeNull();
    expect(dueDay(schedule, new Date('2026-03-08T10:00:00Z'))).toBe('2026-03-08');
  });
});
