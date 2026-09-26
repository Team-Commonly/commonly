const { manifests } = require('../../../integrations/manifests');
const { providerReadiness } = require('../../../services/installable/installableCatalogService');

const READINESS_ENV = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
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

  // Discord is a shipping connector (routes/discord.ts; discordProvider.ts). It
  // was absent from the channel catalog only because it declared no readiness(),
  // which is the predicate providerInstallableIds() filters on — so the defect
  // was a missing declaration, not a missing capability. These assert the
  // consequence through the real service rather than through a re-implementation
  // of its filter.
  it('reports Discord as an answerable provider, not an unknown Installable', () => {
    expect(providerReadiness('discord')).toEqual({ available: false, reason: 'not_configured' });

    process.env.DISCORD_BOT_TOKEN = 'configured';
    process.env.DISCORD_CLIENT_ID = 'configured';
    process.env.DISCORD_CLIENT_SECRET = 'configured';

    expect(providerReadiness('discord')).toEqual({ available: true });
  });

  it('requires all three of the keys the Discord install route reads', () => {
    process.env.DISCORD_BOT_TOKEN = 'configured';
    process.env.DISCORD_CLIENT_ID = 'configured';
    expect(providerReadiness('discord')).toEqual({ available: false, reason: 'not_configured' });

    process.env.DISCORD_CLIENT_SECRET = 'configured';
    expect(providerReadiness('discord')).toEqual({ available: true });

    process.env.DISCORD_CLIENT_SECRET = '   ';
    expect(providerReadiness('discord')).toEqual({ available: false, reason: 'not_configured' });
  });

  it('leaves groupme undeclared, so this change cannot silently widen the catalog', () => {
    process.env.DISCORD_BOT_TOKEN = 'configured';
    process.env.DISCORD_CLIENT_ID = 'configured';
    process.env.DISCORD_CLIENT_SECRET = 'configured';

    expect(providerReadiness('groupme')).toBeNull();
  });

  it('describes Telegram as one chat connected to one pod', () => {
    expect(manifests.telegram.catalog.description).toBe('One Telegram chat, one pod.');
    expect(manifests.telegram.catalog.description).not.toMatch(/ingest|summar/i);
  });
});
