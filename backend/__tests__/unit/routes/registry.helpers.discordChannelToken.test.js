/**
 * TASK-124 — the channel binding handed to a runtime must carry the CURRENT
 * bot token, not the copy an integration row was created with.
 *
 * `buildOpenClawIntegrationChannels` is what the provisioner turns into
 * `channels.discord.accounts[...]` in `moltbot.json`, so a stale value here is
 * a connector that authenticates as a revoked token after a rotation - the same
 * defect class as the read sites, one hop further out (the consumer).
 */
const { buildOpenClawIntegrationChannels } = require('../../../routes/registry/helpers');

const ENV_TOKEN = 'env-token-after-rotation';
const STORED_TOKEN = 'stored-token-from-before-rotation';

describe('buildOpenClawIntegrationChannels — discord token', () => {
  const savedEnv = process.env.DISCORD_BOT_TOKEN;

  const legacyRow = () => ([{
    _id: 'disc-1',
    type: 'discord',
    config: {
      channelName: 'general',
      channelId: '123456789012345679',
      botToken: STORED_TOKEN,
    },
  }]);

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = savedEnv;
  });

  it('binds the env token when a legacy row carries the old copy', () => {
    process.env.DISCORD_BOT_TOKEN = ENV_TOKEN;

    const channels = buildOpenClawIntegrationChannels(legacyRow());

    expect(channels.discord).toHaveLength(1);
    expect(channels.discord[0].token).toBe(ENV_TOKEN);
    expect(channels.discord[0].accountId).toBe('disc-1');
  });

  it('binds the stored copy only when the env var is absent', () => {
    delete process.env.DISCORD_BOT_TOKEN;

    const channels = buildOpenClawIntegrationChannels(legacyRow());

    expect(channels.discord[0].token).toBe(STORED_TOKEN);
  });

  it('binds nothing when neither the environment nor the row has a token', () => {
    delete process.env.DISCORD_BOT_TOKEN;

    const channels = buildOpenClawIntegrationChannels([{
      _id: 'disc-2',
      type: 'discord',
      config: { channelName: 'general', channelId: '123456789012345679' },
    }]);

    expect(channels.discord).toHaveLength(0);
  });
});
