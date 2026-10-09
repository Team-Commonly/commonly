/**
 * TASK-124 part 2 — the Discord webhook URL is stored encrypted, and this file
 * pins the one definition of how it is resolved.
 *
 * The URL is a bearer credential (it embeds the webhook's own token), so the
 * writers put it in the connector-secret envelope and the row keeps a ref. Two
 * plaintext stores survive on rows connected before the migration — the platform
 * document's `webhookUrl` and the legacy `Integration.config.webhookUrl` — and
 * they are read here as FALLBACKS behind the ref.
 *
 * The case that carries the weight is the last one: a ref that cannot be read
 * must THROW rather than fall through to a plaintext copy. Falling back would
 * keep a connector sending to a URL nothing manages, and a webhook URL that is
 * wrong does not fail authentication — it authenticates as a different
 * connector. A missing secret is loud; a substituted one is not (vera 74141).
 */
const mongoose = require('mongoose');

const { resolveDiscordWebhookUrl, hasDiscordWebhookUrl } = require('../../../utils/discordWebhookUrl');
const { put, revoke } = require('../../../services/connectorSecrets');
const { DISCORD_WEBHOOK_URL } = require('../../../services/connectorSecretKinds');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const URL_A = 'https://discord.com/api/webhooks/111/token-aaa';
const URL_B = 'https://discord.com/api/webhooks/222/token-bbb';
const URL_C = 'https://discord.com/api/webhooks/333/token-ccc';

const key = (fill) => Buffer.alloc(32, fill).toString('base64');

describe('resolveDiscordWebhookUrl', () => {
  const savedKeys = process.env.CONNECTOR_SECRET_KEYS;
  const savedActiveKey = process.env.CONNECTOR_SECRET_ACTIVE_KEY;

  beforeAll(async () => {
    await setupMongoDb();
  });
  afterAll(async () => {
    await closeMongoDb();
    process.env.CONNECTOR_SECRET_KEYS = savedKeys;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = savedActiveKey;
  });
  beforeEach(async () => {
    await clearMongoDb();
    process.env.CONNECTOR_SECRET_KEYS = `k1:${key(1)}`;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k1';
  });

  it('reads through the encrypted ref, which wins over a plaintext copy beside it', async () => {
    const ref = await put(new mongoose.Types.ObjectId().toString(), DISCORD_WEBHOOK_URL, URL_A);

    await expect(resolveDiscordWebhookUrl(ref, URL_B, URL_C)).resolves.toBe(URL_A);
  });

  it('falls back to the platform plaintext store, then to the legacy config one', async () => {
    await expect(resolveDiscordWebhookUrl(undefined, URL_B, URL_C)).resolves.toBe(URL_B);
    await expect(resolveDiscordWebhookUrl(undefined, undefined, URL_C)).resolves.toBe(URL_C);
  });

  it('treats an empty ref as absent, the same way the writers do', async () => {
    await expect(resolveDiscordWebhookUrl('', URL_B)).resolves.toBe(URL_B);
  });

  it('answers undefined when there is no webhook anywhere', async () => {
    await expect(resolveDiscordWebhookUrl(undefined, '', null)).resolves.toBeUndefined();
  });

  it('THROWS on a ref it cannot read instead of using the plaintext copy behind it', async () => {
    const ref = await put(new mongoose.Types.ObjectId().toString(), DISCORD_WEBHOOK_URL, URL_A);
    await revoke(ref);

    await expect(resolveDiscordWebhookUrl(ref, URL_B)).rejects.toThrow();
  });

  it('throws rather than returning an empty value when a stored secret resolves to nothing', async () => {
    // Reachable through the trim: `put` refuses an empty string, not a blank one,
    // so a blank stored value is the shape a corrupt or hand-edited row has.
    const ref = await put(new mongoose.Types.ObjectId().toString(), DISCORD_WEBHOOK_URL, '   ');

    await expect(resolveDiscordWebhookUrl(ref)).rejects.toThrow(/empty value/);
  });

  it('hasDiscordWebhookUrl answers presence without decrypting or needing the ring', async () => {
    const ref = await put(new mongoose.Types.ObjectId().toString(), DISCORD_WEBHOOK_URL, URL_A);
    process.env.CONNECTOR_SECRET_KEYS = '';

    // A ref whose key is gone still counts as present: the sweep's job is to mark
    // the row unavailable, and a presence test is not the place to discover it.
    expect(hasDiscordWebhookUrl(ref)).toBe(true);
    expect(hasDiscordWebhookUrl(undefined, URL_B)).toBe(true);
    expect(hasDiscordWebhookUrl(undefined, '', null)).toBe(false);
  });
});
