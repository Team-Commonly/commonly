// @ts-nocheck

// The migration suite needs testUtils' Mongo harness, not JWT behavior.
jest.mock('jsonwebtoken', () => ({}));

import mongoose from 'mongoose';

const {
  encryptDiscordWebhookUrls,
  formatReport,
} = require('../../../scripts/encrypt-discord-webhook-url');
const { get } = require('../../../services/connectorSecrets');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

const URL_A = 'https://discord.com/api/webhooks/111/token-aaa';
const URL_B = 'https://discord.com/api/webhooks/222/token-bbb';
const URL_C = 'https://example.test/not-a-discord-webhook';

const key = (fill) => Buffer.alloc(32, fill).toString('base64');

const discordRows = () => mongoose.connection.collection('discord_integrations');
const integrationRows = () => mongoose.connection.collection('integrations');

const seedDiscordRow = (overrides = {}) => ({
  integrationId: new mongoose.Types.ObjectId(),
  serverId: 'srv',
  serverName: 'Server',
  channelId: 'chan',
  channelName: 'channel',
  webhookId: 'wh1',
  ...overrides,
});

/** A platform row plus the Integration row it belongs to. */
const seedPair = async ({ platform = {}, config = {} } = {}) => {
  const integrationId = new mongoose.Types.ObjectId();
  const platformRow = seedDiscordRow({ integrationId, ...platform });
  await discordRows().insertOne(platformRow);
  await integrationRows().insertOne({
    _id: integrationId,
    type: 'discord',
    isActive: true,
    config,
  });
  return { integrationId, platformId: platformRow._id };
};

describe('encrypt-discord-webhook-url', () => {
  const originalKeys = process.env.CONNECTOR_SECRET_KEYS;
  const originalActiveKey = process.env.CONNECTOR_SECRET_ACTIVE_KEY;

  beforeAll(async () => setupMongoDb());
  afterAll(async () => {
    await closeMongoDb();
    process.env.CONNECTOR_SECRET_KEYS = originalKeys;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = originalActiveKey;
  });
  beforeEach(async () => {
    await clearMongoDb();
    process.env.CONNECTOR_SECRET_KEYS = `k1:${key(1)}`;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k1';
  });

  it('replaces the plaintext platform copy with a ref that resolves to it, and clears both stores', async () => {
    const { integrationId, platformId } = await seedPair({
      platform: { webhookUrl: URL_A },
      config: { channelId: 'chan', webhookUrl: '' },
    });

    const result = await encryptDiscordWebhookUrls({ apply: true });

    expect(result).toMatchObject({ rows: 1, candidates: 1, migrated: 1, alreadyEncrypted: 0 });
    const integration = await integrationRows().findOne({ _id: integrationId });
    expect(integration.config.webhookUrlRef).toBeTruthy();
    expect(integration.config).not.toHaveProperty('webhookUrl');
    expect(await get(integration.config.webhookUrlRef)).toBe(URL_A);
    const platform = await discordRows().findOne({ _id: platformId });
    expect(platform).not.toHaveProperty('webhookUrl');
    expect(platform.webhookId).toBe('wh1'); // not a secret; untouched
  });

  it('encrypts the legacy Integration.config.webhookUrl store too, and reports it apart', async () => {
    // The second store: a row whose platform document carries no URL. wren 74127
    // is why this exists — `Integration.config.webhookUrl` is a Discord store, not
    // registry config, and the migration that read only the platform document
    // would have left this value in the clear.
    const { integrationId } = await seedPair({
      config: { channelId: 'chan', webhookUrl: URL_B },
    });

    const result = await encryptDiscordWebhookUrls({ apply: true });

    expect(result).toMatchObject({ candidates: 1, migrated: 1, configCopies: 1 });
    const integration = await integrationRows().findOne({ _id: integrationId });
    expect(integration.config).not.toHaveProperty('webhookUrl');
    expect(await get(integration.config.webhookUrlRef)).toBe(URL_B);
  });

  it('is idempotent: a second apply finds nothing to migrate', async () => {
    await seedPair({ platform: { webhookUrl: URL_A } });

    const first = await encryptDiscordWebhookUrls({ apply: true });
    const second = await encryptDiscordWebhookUrls({ apply: true });

    expect(first.migrated).toBe(1);
    expect(second).toMatchObject({ candidates: 0, migrated: 0, alreadyEncrypted: 1 });
  });

  it('writes nothing on a dry run but still names the work', async () => {
    const { integrationId, platformId } = await seedPair({ platform: { webhookUrl: URL_A } });

    const result = await encryptDiscordWebhookUrls({ apply: false });

    expect(result).toMatchObject({ candidates: 1, migrated: 0 });
    const integration = await integrationRows().findOne({ _id: integrationId });
    expect(integration.config).not.toHaveProperty('webhookUrlRef');
    expect((await discordRows().findOne({ _id: platformId })).webhookUrl).toBe(URL_A);
  });

  it('keeps a non-Discord-shaped value out of the report but still encrypts it', async () => {
    const { integrationId } = await seedPair({ platform: { webhookUrl: URL_C } });

    const result = await encryptDiscordWebhookUrls({ apply: true });

    expect(result).toMatchObject({ candidates: 1, migrated: 1, unexpectedFormat: 1 });
    const integration = await integrationRows().findOne({ _id: integrationId });
    expect(await get(integration.config.webhookUrlRef)).toBe(URL_C);
  });

  it('refuses to write anything when the key ring is unusable', async () => {
    // The destructive half of this migration is the $unset. A run that cannot
    // encrypt must not reach it: losing the plaintext without storing a ref
    // leaves the live credential unrecoverable.
    process.env.CONNECTOR_SECRET_KEYS = '';
    const { integrationId, platformId } = await seedPair({ platform: { webhookUrl: URL_A } });

    await expect(encryptDiscordWebhookUrls({ apply: true })).rejects.toThrow();

    const integration = await integrationRows().findOne({ _id: integrationId });
    expect(integration.config).not.toHaveProperty('webhookUrlRef');
    expect((await discordRows().findOne({ _id: platformId })).webhookUrl).toBe(URL_A);
  });

  it('identifies each URL without reproducing it', async () => {
    await seedPair({ platform: { webhookUrl: URL_A } });
    await seedPair({ platform: { webhookUrl: URL_B } });

    const result = await encryptDiscordWebhookUrls({ apply: false });

    result.digests.forEach((entry) => {
      expect(entry).toMatch(/^[0-9a-f]{12} \(\d+ chars\)$/);
    });
    const logged = result.digests.join(' ');
    expect(logged).not.toContain(URL_A);
    expect(logged).not.toContain('token-aaa');
    expect(new Set(result.digests).size).toBe(2);
  });

  it('labels every count it prints, including the two that are not actions', () => {
    const lines = formatReport({
      rows: 3,
      candidates: 1,
      migrated: 1,
      alreadyEncrypted: 1,
      withoutWebhook: 1,
      unexpectedFormat: 1,
      configCopies: 1,
      digests: ['abcdef123456 (45 chars)'],
    }, true);

    expect(lines[0]).toBe(
      '[encrypt-discord-webhook-url] APPLY rows=3 candidates=1 migrated=1',
    );
    expect(lines[1]).toBe('  plaintext webhook abcdef123456 (45 chars)');
    expect(lines).toContain('[encrypt-discord-webhook-url] already encrypted (ref, no plaintext): 1');
    expect(lines).toContain('[encrypt-discord-webhook-url] no webhook at all: 1');
    expect(lines).toContain(
      '[encrypt-discord-webhook-url] plaintext found in Integration.config.webhookUrl '
      + '(the legacy second store): 1',
    );
    expect(lines).toContain(
      '[encrypt-discord-webhook-url] candidates not matching the Discord webhook URL shape '
      + '(encrypted anyway): 1',
    );
    expect(lines).not.toContain('DRY RUN — nothing written. Re-run with --apply.');
    expect(formatReport({
      rows: 0,
      candidates: 0,
      migrated: 0,
      alreadyEncrypted: 0,
      withoutWebhook: 0,
      unexpectedFormat: 0,
      configCopies: 0,
      digests: [],
    }, false)).toContain('DRY RUN — nothing written. Re-run with --apply.');
  });
});
