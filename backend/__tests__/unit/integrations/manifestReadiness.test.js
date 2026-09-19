const { manifests } = require('../../../integrations/manifests');

const READINESS_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_SECRET_TOKEN',
  'TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_SIGNING_SECRET',
  'CONNECTOR_SECRET_KEYS',
  'CONNECTOR_SECRET_ACTIVE_KEY',
];

describe('installable connector manifest readiness', () => {
  const original = {};

  beforeAll(() => {
    READINESS_ENV.forEach((key) => { original[key] = process.env[key]; });
  });

  beforeEach(() => {
    READINESS_ENV.forEach((key) => { delete process.env[key]; });
  });

  afterAll(() => {
    READINESS_ENV.forEach((key) => {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    });
  });

  it('uses only a safe enum when Slack is not configured', () => {
    expect(manifests.slack.readiness()).toEqual({ available: false, reason: 'not_configured' });
  });

  it('requires every Slack runtime secret before marking the provider available', () => {
    const required = [
      'SLACK_CLIENT_ID',
      'SLACK_CLIENT_SECRET',
      'SLACK_SIGNING_SECRET',
      'CONNECTOR_SECRET_KEYS',
      'CONNECTOR_SECRET_ACTIVE_KEY',
    ];
    required.forEach((key) => { process.env[key] = 'configured'; });

    expect(manifests.slack.readiness()).toEqual({ available: true });

    delete process.env.CONNECTOR_SECRET_ACTIVE_KEY;
    expect(manifests.slack.readiness()).toEqual({ available: false, reason: 'not_configured' });
  });

  it('accepts Telegram only with its secret token or the explicit unverified override', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'configured';
    expect(manifests.telegram.readiness()).toEqual({ available: false, reason: 'not_configured' });

    process.env.TELEGRAM_SECRET_TOKEN = 'configured';
    expect(manifests.telegram.readiness()).toEqual({ available: true });

    delete process.env.TELEGRAM_SECRET_TOKEN;
    process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED = 'true';
    expect(manifests.telegram.readiness()).toEqual({ available: true });
  });

  it('describes Telegram as one chat connected to one pod', () => {
    expect(manifests.telegram.catalog.description).toBe('One Telegram chat, one pod.');
    expect(manifests.telegram.catalog.description).not.toMatch(/ingest|summar/i);
  });

  it('ships the first-party locale copy beside each canonical catalog description', () => {
    expect(manifests.telegram.catalog.descriptions).toEqual({
      en: 'One Telegram chat, one pod.',
      'zh-CN': '一个 Telegram 聊天，一个 Pod。',
    });
    expect(manifests.slack.catalog.descriptions).toEqual({
      en: 'Your Slack DM, every pod you\'re in.',
      'zh-CN': '你的 Slack 私信，你所在的每个 Pod。',
    });
    expect(manifests.discord.catalog.descriptions['zh-CN']).toBe('接入 Discord 频道动态，发布 Pod 摘要。');
    expect(manifests.groupme.catalog.descriptions['zh-CN']).toBe('缓存 GroupMe 消息，汇总进 Pod。');
  });
});
