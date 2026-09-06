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
});
