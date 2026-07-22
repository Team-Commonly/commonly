const mockScheduledCallbacks = new Map();

jest.mock('node-cron', () => ({
  schedule: jest.fn((expression, callback) => {
    mockScheduledCallbacks.set(expression, callback);
    return { start: jest.fn(), stop: jest.fn() };
  }),
}));
jest.mock('../../../services/agentProvisionerServiceK8s', () => ({
  refreshCodexOAuthTokenIfNeeded: jest.fn(),
}));
jest.mock('../../../services/summarizerService', () => ({}));
jest.mock('../../../models/Integration', () => ({}));
jest.mock('../../../services/integrationSummaryService', () => ({}));
jest.mock('../../../services/agentEventService', () => ({
  getSessionResetIntervalHours: jest.fn(() => 24),
}));
jest.mock('../../../services/podAssetService', () => ({}));
jest.mock('../../../services/externalFeedService', () => ({ syncExternalFeeds: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: {} }));
jest.mock('../../../models/AgentEvent', () => ({}));
jest.mock('../../../services/agentEnsembleService', () => ({}));
jest.mock('../../../services/podCurationService', () => ({}));
jest.mock('../../../services/agentAutoJoinService', () => ({}));
jest.mock('../../../models/pg/Message', () => ({}));
jest.mock('../../../models/Post', () => ({}));
jest.mock('../../../services/skillsRefreshService', () => ({ refreshSkillsIndex: jest.fn() }));
jest.mock('../../../services/chatSummarizerService', () => ({}));
jest.mock('../../../services/dailyDigestService', () => ({
  generateAllDailyDigests: jest.fn(),
}));
jest.mock('../../../services/digestEmailService', () => ({
  sendDigestEmails: jest.fn(),
}));

const dailyDigestService = require('../../../services/dailyDigestService');
const digestEmailService = require('../../../services/digestEmailService');
const schedulerService = require('../../../services/schedulerService');

describe('scheduler daily digest delivery', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockScheduledCallbacks.clear();
    jest.clearAllMocks();
    schedulerService.isRunning = false;
    schedulerService.jobs = [];
  });

  afterEach(() => {
    schedulerService.stop();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('delivers only the summaries returned by the current generation run', async () => {
    const currentRun = [{ success: true, digest: { _id: 'digest-1' } }];
    dailyDigestService.generateAllDailyDigests.mockResolvedValue(currentRun);
    digestEmailService.sendDigestEmails.mockResolvedValue({ sent: 1 });
    schedulerService.start();

    const dailyDigestCallback = mockScheduledCallbacks.get('0 6 * * *');
    await dailyDigestCallback();

    expect(dailyDigestService.generateAllDailyDigests).toHaveBeenCalledTimes(1);
    expect(digestEmailService.sendDigestEmails).toHaveBeenCalledWith(currentRun);
    expect(dailyDigestService.generateAllDailyDigests.mock.invocationCallOrder[0])
      .toBeLessThan(digestEmailService.sendDigestEmails.mock.invocationCallOrder[0]);
  });
});
