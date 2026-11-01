const mongoose = require('mongoose');

const ConnectorSecret = require('../../../models/ConnectorSecret');
const {
  ConnectorSecretKeyMissing,
  ConnectorSecretStaleWrite,
  get,
  put,
  putIfAbsent,
  rewrap,
  revoke,
  revokeOwnWrite,
} = require('../../../services/connectorSecrets');
const {
  DISCORD_WEBHOOK_URL,
  GROUPME_ACCESS_TOKEN,
  SLACK_BOT_TOKEN,
} = require('../../../services/connectorSecretKinds');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const key = (fill) => Buffer.alloc(32, fill).toString('base64');

describe('connectorSecrets', () => {
  const originalKeys = process.env.CONNECTOR_SECRET_KEYS;
  const originalActiveKey = process.env.CONNECTOR_SECRET_ACTIVE_KEY;

  beforeAll(async () => {
    await setupMongoDb();
    await ConnectorSecret.syncIndexes();
  });

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

  it('encrypts with a fresh IV and keeps material out of the document', async () => {
    const integrationId = new mongoose.Types.ObjectId().toString();
    const first = await put(integrationId, SLACK_BOT_TOKEN, 'xoxb-secret');
    const second = await put(integrationId, SLACK_BOT_TOKEN, 'xoxb-secret');

    expect(second).toBe(first);
    const stored = await ConnectorSecret.findById(first).lean();
    expect(stored).toMatchObject({ provider: 'slack', kind: 'slack-bot-token', keyId: 'k1' });
    expect(stored.ciphertext).not.toContain('xoxb-secret');
    expect(stored.iv).toHaveLength(16); // base64 of a fresh 96-bit IV
    expect(await get(first)).toBe('xoxb-secret');
  });

  it('keys a secret by the PAIR (integrationId, kind), so a second kind does not overwrite the first', async () => {
    // The corruption this guards: with a filter on `integrationId` alone the
    // second put does not collide — it matches the first kind's document and
    // $sets the new ciphertext onto it, so the first ref stays valid and starts
    // decrypting to the second secret. Varying the kind is the
    // whole test; the refs and both plaintexts must differ.
    const integrationId = new mongoose.Types.ObjectId().toString();
    const slackRef = await put(integrationId, SLACK_BOT_TOKEN, 'xoxb-secret');
    const webhook = 'https://discord.com/api/webhooks/1/token';
    const discordRef = await put(integrationId, DISCORD_WEBHOOK_URL, webhook);

    expect(discordRef).not.toBe(slackRef);
    expect(await ConnectorSecret.countDocuments({ integrationId })).toBe(2);
    expect(await get(slackRef)).toBe('xoxb-secret');
    expect(await get(discordRef)).toBe(webhook);
  });

  it('refuses an older authorization after a newer generation owns the same secret ref', async () => {
    const integrationId = new mongoose.Types.ObjectId().toString();
    const ref = await put(integrationId, SLACK_BOT_TOKEN, 'new-token', 2);
    await expect(put(integrationId, SLACK_BOT_TOKEN, 'old-token', 1))
      .rejects.toBeInstanceOf(ConnectorSecretStaleWrite);
    expect(await get(ref)).toBe('new-token');
    expect((await ConnectorSecret.findById(ref).lean()).writeGeneration).toBe(2);
  });

  it('declares exactly one index, on the pair — a leftover single-field unique would still be enforced at boot', async () => {
    // `syncIndexes()` keeps every declared index, so a `unique: true` left on
    // `integrationId` while the compound index is added leaves the OLD key
    // enforced: the second kind is rejected by an index whose name no longer
    // says what it does.
    const declared = ConnectorSecret.schema.indexes();
    expect(declared).toHaveLength(1);
    const [spec, options] = declared[0];
    expect(spec).toEqual({ integrationId: 1, kind: 1 });
    expect(options).toMatchObject({ unique: true });
  });

  it('fails closed when ciphertext authentication fails', async () => {
    const ref = await put(new mongoose.Types.ObjectId().toString(), SLACK_BOT_TOKEN, 'xoxb-secret');
    await ConnectorSecret.updateOne({ _id: ref }, { $set: { tag: Buffer.alloc(16, 9).toString('base64') } });

    await expect(get(ref)).rejects.toThrow();
  });

  it('rewraps under the active key before the former key is removed', async () => {
    const ref = await put(new mongoose.Types.ObjectId().toString(), SLACK_BOT_TOKEN, 'xoxb-secret');
    process.env.CONNECTOR_SECRET_KEYS = `k1:${key(1)},k2:${key(2)}`;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k2';

    await rewrap(ref);
    process.env.CONNECTOR_SECRET_KEYS = `k2:${key(2)}`;
    expect(await get(ref)).toBe('xoxb-secret');
  });

  it('raises a typed error for a key removed without a rewrap', async () => {
    const ref = await put(new mongoose.Types.ObjectId().toString(), SLACK_BOT_TOKEN, 'xoxb-secret');
    process.env.CONNECTOR_SECRET_KEYS = `k2:${key(2)}`;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k2';

    await expect(get(ref)).rejects.toBeInstanceOf(ConnectorSecretKeyMissing);
  });

  it('deletes the secret by its opaque reference', async () => {
    const ref = await put(new mongoose.Types.ObjectId().toString(), SLACK_BOT_TOKEN, 'xoxb-secret');
    await revoke(ref);
    expect(await ConnectorSecret.findById(ref)).toBeNull();
  });

  // TASK-539: the import path. Insert-only, so a secret a live edit stored
  // first is never replaced with an older copy.
  // A writer cleaning up after itself: the ref is stable per (integration,
  // kind), so a newer writer may already own it by the time the older one
  // deletes, and a delete by ref alone would destroy that writer's key.
  it('revokeOwnWrite deletes a secret only while it still holds that write', async () => {
    const integrationId = new mongoose.Types.ObjectId().toString();
    const ref = await put(integrationId, SLACK_BOT_TOKEN, 'older', 1_000_000);
    expect(await put(integrationId, SLACK_BOT_TOKEN, 'newer', 2_000_000)).toBe(ref);

    await revokeOwnWrite(ref, 1_000_000);
    await expect(get(ref)).resolves.toBe('newer');

    await revokeOwnWrite(ref, 2_000_000);
    expect(await ConnectorSecret.findById(ref).lean()).toBeNull();
  });

  it('putIfAbsent inserts when the pair is free and reports it created', async () => {
    const integrationId = new mongoose.Types.ObjectId().toString();
    const { ref, created } = await putIfAbsent(integrationId, GROUPME_ACCESS_TOKEN, 'imported');

    expect(created).toBe(true);
    expect(await get(ref)).toBe('imported');
  });

  it('putIfAbsent returns the existing ref and keeps its material when the pair is taken', async () => {
    const integrationId = new mongoose.Types.ObjectId().toString();
    const live = await put(integrationId, GROUPME_ACCESS_TOKEN, 'live-edit');

    const { ref, created } = await putIfAbsent(integrationId, GROUPME_ACCESS_TOKEN, 'older-copy');

    expect(created).toBe(false);
    expect(ref).toBe(live);
    expect(await get(live)).toBe('live-edit');
    expect(await ConnectorSecret.countDocuments({ integrationId })).toBe(1);
  });
});
