const mockChannelVerdict = { updateOne: jest.fn() };
jest.mock('../../../models/ChannelVerdict', () => mockChannelVerdict);

const { record, markReachedHuman } = require('../../../services/channelVerdictService');

describe('channelVerdictService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChannelVerdict.updateOne.mockResolvedValue({ acknowledged: true });
  });

  it('upserts an interrupt receipt on its channel and workspace message', async () => {
    const at = new Date('2026-09-05T13:00:00.000Z');
    await record({
      integrationId: 'integration-a',
      installationId: 'installation-a',
      podId: 'pod-a',
      provider: 'telegram',
      event: { kind: 'decision_request', podMessageId: '700' },
      verdict: 'interrupt',
      reason: 'card',
      at,
    });

    expect(mockChannelVerdict.updateOne).toHaveBeenCalledWith(
      { integrationId: 'integration-a', 'event.podMessageId': '700' },
      {
        $setOnInsert: expect.objectContaining({
          integrationId: 'integration-a', installationId: 'installation-a', podId: 'pod-a',
          provider: 'telegram', event: { kind: 'decision_request', podMessageId: '700' },
          verdict: 'interrupt', reason: 'card', at,
        }),
      },
      { upsert: true },
    );
  });

  it('stamps only the channel that supplied a ruling', async () => {
    await markReachedHuman({
      integrationId: 'integration-b', podMessageId: '700', ruledVia: 'slack',
    });

    expect(mockChannelVerdict.updateOne).toHaveBeenCalledWith(
      { integrationId: 'integration-b', 'event.podMessageId': '700' },
      { $set: expect.objectContaining({ ruledVia: 'slack', reachedHumanAt: expect.any(Date) }) },
    );
  });

  it('keeps a failed observational write out of the bridge outcome', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockChannelVerdict.updateOne.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(record({
      integrationId: 'integration-a', podId: 'pod-a', provider: 'telegram',
      event: { kind: 'decision_request', podMessageId: '700' },
      verdict: 'interrupt', reason: 'card',
    })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('[channel-verdict] record failed:', 'database unavailable');
    warn.mockRestore();
  });
});
