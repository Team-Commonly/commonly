// stop() must clear the one-shot startup runs as well as the cron jobs. Before
// TASK-030 it stopped only the crons, so a test that called the real start()
// and stop() left a 30 s refreshSkillsIndex armed in the jest worker. That
// refresh fetched live GitHub data and rewrote the checked-in skills catalog.
jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
}));
jest.mock('../../../services/skillsRefreshService', () => ({
  refreshSkillsIndex: jest.fn().mockResolvedValue({
    refreshed: 0, reposUpdated: 0, reposTotal: 0, errors: [],
  }),
}));

const { refreshSkillsIndex } = require('../../../services/skillsRefreshService');
const scheduler = require('../../../services/schedulerService');

describe('scheduler: stop() clears the startup timers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    scheduler.stop();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('arms the startup runs on start()', () => {
    scheduler.start();
    expect(jest.getTimerCount()).toBeGreaterThanOrEqual(8);
  });

  it('leaves no timer pending after stop(), so the catalog refresh never fires', () => {
    scheduler.start();
    scheduler.stop();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(31000);
    expect(refreshSkillsIndex).not.toHaveBeenCalled();
  });
});
