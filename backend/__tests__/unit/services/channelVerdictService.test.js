const mockChannelVerdict = { updateOne: jest.fn(), updateMany: jest.fn() };
jest.mock('../../../models/ChannelVerdict', () => mockChannelVerdict);

const {
  record, markReachedHuman, markRuled, CHANNEL_VERDICT_RETENTION_MS,
} = require('../../../services/channelVerdictService');

describe('channelVerdictService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChannelVerdict.updateOne.mockResolvedValue({ acknowledged: true });
    mockChannelVerdict.updateMany.mockResolvedValue({ matchedCount: 1 });
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
    expect(mockChannelVerdict.updateOne.mock.calls[0][1].$setOnInsert).not.toHaveProperty('expiresAt');
  });

  it('expires completed verdicts a quarter after their own event time', async () => {
    const at = new Date('2026-09-05T13:00:00.000Z');
    await record({
      integrationId: 'integration-a', podId: 'pod-a', provider: 'telegram',
      event: { kind: 'chat.message', podMessageId: '701' },
      verdict: 'hold', reason: 'muted', at,
    });

    expect(mockChannelVerdict.updateOne.mock.calls[0][1].$setOnInsert.expiresAt)
      .toEqual(new Date(at.getTime() + CHANNEL_VERDICT_RETENTION_MS));
  });

  it('stamps only the channel that supplied a ruling', async () => {
    mockChannelVerdict.updateOne.mockResolvedValueOnce({ matchedCount: 1 });
    await markReachedHuman({
      integrationId: 'integration-b', podMessageId: '700', ruledVia: 'slack',
    });

    expect(mockChannelVerdict.updateOne).toHaveBeenCalledWith(
      { integrationId: 'integration-b', 'event.podMessageId': '700' },
      { $set: expect.objectContaining({ ruledVia: 'slack', reachedHumanAt: expect.any(Date) }) },
    );
    expect(mockChannelVerdict.updateMany).toHaveBeenCalledWith(
      { 'event.podMessageId': '700' },
      { $set: expect.objectContaining({ ruledVia: 'slack', expiresAt: expect.any(Date) }) },
    );
  });

  it('marks every copy ruled without inventing a channel receipt', async () => {
    await markRuled({ podMessageId: '700', ruledVia: 'workspace' });

    expect(mockChannelVerdict.updateMany).toHaveBeenCalledWith(
      { 'event.podMessageId': '700' },
      { $set: expect.objectContaining({ ruledVia: 'workspace', expiresAt: expect.any(Date) }) },
    );
    expect(mockChannelVerdict.updateOne).not.toHaveBeenCalled();
  });

  it('logs a missing channel instead of stamping its sibling copies', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockChannelVerdict.updateOne.mockResolvedValueOnce({ matchedCount: 0 });

    await markReachedHuman({
      integrationId: 'expired-integration', podMessageId: 'expired-card', ruledVia: 'telegram',
    });

    expect(mockChannelVerdict.updateMany).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[channel-verdict] reach stamp matched no channel:', 'expired-card',
    );
    warn.mockRestore();
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
