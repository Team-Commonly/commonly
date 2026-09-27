/**
 * TASK-140 item 3 — the token a runtime is handed comes from the environment for
 * Telegram, never from the row. For Slack it is now handed nothing at all
 * (TASK-151): the instance-wide `SLACK_BOT_TOKEN` fallback is retired, and the
 * env keys stay in `ENV_KEYS` below precisely so these cases prove the helper
 * ignores them.
 *
 * `config.botToken` has no writer since TASK-139, and every live Telegram path
 * already reads `process.env.TELEGRAM_BOT_TOKEN` — the webhook route
 * (`routes/webhooks/telegram.ts`), the bridge
 * (`services/telegramBridgeService.ts`), `decisionCardReconcileService`, and
 * both provisioners. This helper was the last reader that preferred the stored
 * copy, which is the stale-credential defect TASK-124 fixed one hop further in:
 * the gateway authenticated as a token the backend never used, so rotating the
 * real one did not reach the runtime.
 *
 * Discord is deliberately different and unchanged: its resolver
 * (`utils/discordBotToken.ts`) is env-FIRST with the stored copy as a documented
 * fallback for rows that predate the retirement, so `:249` keeps its argument
 * (the sibling test `registry.helpers.discordChannelToken.test.js` covers the
 * precedence with an env token present; the last case here covers the fallback).
 */
const { buildOpenClawIntegrationChannels } = require('../../../routes/registry/helpers');

const ENV_KEYS = [
  'SLACK_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN',
  'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'TELEGRAM_SECRET_TOKEN',
];
const saved = {};

const telegramRow = (config = {}) => ([{ _id: 'tg-1', type: 'telegram', config: { chatTitle: 'ops', ...config } }]);
const slackRow = (config = {}) => ([{ _id: 'sl-1', type: 'slack', config: { channelName: 'general', ...config } }]);

describe('buildOpenClawIntegrationChannels — token sources', () => {
  beforeEach(() => {
    ENV_KEYS.forEach((key) => { saved[key] = process.env[key]; });
    process.env.SLACK_BOT_TOKEN = 'xoxb-instance';
    process.env.TELEGRAM_BOT_TOKEN = 'tg-instance';
    process.env.SLACK_APP_TOKEN = 'xapp-instance';
    process.env.SLACK_SIGNING_SECRET = 'slack-secret-instance';
    process.env.TELEGRAM_SECRET_TOKEN = 'tg-secret-instance';
  });

  afterEach(() => {
    ENV_KEYS.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  });

  it('binds the instance telegram token even when the row carries an old copy', () => {
    const channels = buildOpenClawIntegrationChannels(telegramRow({ botToken: 'tg-stale-row-copy' }));

    expect(channels.telegram).toHaveLength(1);
    expect(channels.telegram[0].botToken).toBe('tg-instance');
  });

  it('hands the gateway no slack channel at all (TASK-151)', () => {
    const channels = buildOpenClawIntegrationChannels(slackRow({
      botToken: 'xoxb-stale-row-copy',
      appToken: 'xapp-stale-row-copy',
      signingSecret: 'slack-secret-stale-row-copy',
      channelId: 'C0456',
    }));

    // `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` and `SLACK_SIGNING_SECRET` are all
    // set by `beforeEach`, so a restored reader shows up here as a non-empty
    // array. The key itself stays an array for consumers that iterate it.
    expect(channels.slack).toEqual([]);
  });

  it('binds nothing for either type when only the retired stored copy exists', () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;

    const channels = buildOpenClawIntegrationChannels([
      ...telegramRow({ botToken: 'tg-stale-row-copy' }),
      ...slackRow({ botToken: 'xoxb-stale-row-copy' }),
    ]);

    expect(channels.telegram).toEqual([]);
    // Slack is empty on both paths now: this half is no longer evidence of the
    // env rule, only of the stored copy staying unread.
    expect(channels.slack).toEqual([]);
  });

  it('hands the gateway no slack verification credential either (TASK-151)', () => {
    // The signing secret is still an env var, and still verifies every webhook
    // (`routes/webhooks/slack.ts` reads it directly) — it is simply no longer
    // projected into a runtime's channel config. Cutting only the token lines
    // out of `helpers.ts` leaves this case red.
    const channels = buildOpenClawIntegrationChannels(slackRow({
      appToken: 'xapp-stale-row-copy',
      signingSecret: 'slack-secret-stale-row-copy',
    }));

    expect(channels.slack).toEqual([]);
  });

  it('binds the instance telegram webhook secret even when the row carries an old copy', () => {
    const channels = buildOpenClawIntegrationChannels(telegramRow({ secretToken: 'tg-secret-stale-row-copy' }));

    expect(channels.telegram[0].webhookSecret).toBe('tg-secret-instance');
  });

  it('leaves every verification credential absent when the environment has none, whatever the row holds', () => {
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.TELEGRAM_SECRET_TOKEN;

    const slack = buildOpenClawIntegrationChannels(slackRow({
      appToken: 'xapp-stale-row-copy',
      signingSecret: 'slack-secret-stale-row-copy',
    }));
    const telegram = buildOpenClawIntegrationChannels(telegramRow({ secretToken: 'tg-secret-stale-row-copy' }));

    expect(slack.slack).toEqual([]);
    expect(telegram.telegram[0].webhookSecret).toBeUndefined();
  });

  it('keeps the retained channel binding the row still supplies', () => {
    const channels = buildOpenClawIntegrationChannels(telegramRow({ chatId: '4242' }));

    expect(channels.telegram[0].chatId).toBe('4242');
  });

  it('leaves discord on its env-first resolver, including the stored fallback', () => {
    delete process.env.DISCORD_BOT_TOKEN;
    const channels = buildOpenClawIntegrationChannels([{
      _id: 'disc-1',
      type: 'discord',
      config: { channelId: '123456789012345679', botToken: 'disc-stored-fallback' },
    }]);

    expect(channels.discord[0].token).toBe('disc-stored-fallback');
  });
});
