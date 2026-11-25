// F627: a failed command-service step is logged as message and status, never
// the error object (which can be an AxiosError carrying request headers).
jest.mock('../../../models/Integration');
jest.mock('../../../models/DiscordSummaryHistory', () => jest.fn());
jest.mock('../../../models/Summary', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/discordService');
jest.mock('../../../services/summarizerService');
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));

const Integration = require('../../../models/Integration');
const DiscordCommandService = require('../../../services/discordCommandService');
const { fakeAxiosError, printed, expectNoSecrets } = require('../../utils/fakeAxiosError');

describe('discordCommandService failure logging (F627)', () => {
  it('initialize logs the label and message, not the request, and returns false', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    Integration.findOne.mockRejectedValue(fakeAxiosError('lookup failed'));
    const service = new DiscordCommandService({ integrationId: 'i1', guildId: 'g1', channelId: 'c1' });
    await expect(service.initialize()).resolves.toBe(false);
    const text = printed(errSpy);
    expect(text).toContain('Error initializing Discord command service:');
    expect(text).toContain('lookup failed');
    expectNoSecrets(text);
    errSpy.mockRestore();
  });
});
