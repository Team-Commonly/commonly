const mongoose = require('mongoose');

const ConnectorSecret = require('../../../models/ConnectorSecret');
const {
  ConnectorSecretKeyMissing,
  get,
  put,
  rewrap,
  revoke,
} = require('../../../services/connectorSecrets');
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
    const first = await put(integrationId, 'slack', 'xoxb-secret');
    const second = await put(integrationId, 'slack', 'xoxb-secret');

    expect(second).toBe(first);
    const stored = await ConnectorSecret.findById(first).lean();
    expect(stored).toMatchObject({ provider: 'slack', keyId: 'k1' });
    expect(stored.ciphertext).not.toContain('xoxb-secret');
    expect(stored.iv).toHaveLength(16); // base64 of a fresh 96-bit IV
    expect(await get(first)).toBe('xoxb-secret');
  });

  it('fails closed when ciphertext authentication fails', async () => {
    const ref = await put(new mongoose.Types.ObjectId().toString(), 'slack', 'xoxb-secret');
    await ConnectorSecret.updateOne({ _id: ref }, { $set: { tag: Buffer.alloc(16, 9).toString('base64') } });

    await expect(get(ref)).rejects.toThrow();
  });

  it('rewraps under the active key before the former key is removed', async () => {
    const ref = await put(new mongoose.Types.ObjectId().toString(), 'slack', 'xoxb-secret');
    process.env.CONNECTOR_SECRET_KEYS = `k1:${key(1)},k2:${key(2)}`;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k2';

    await rewrap(ref);
    process.env.CONNECTOR_SECRET_KEYS = `k2:${key(2)}`;
    expect(await get(ref)).toBe('xoxb-secret');
  });

  it('raises a typed error for a key removed without a rewrap', async () => {
    const ref = await put(new mongoose.Types.ObjectId().toString(), 'slack', 'xoxb-secret');
    process.env.CONNECTOR_SECRET_KEYS = `k2:${key(2)}`;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k2';

    await expect(get(ref)).rejects.toBeInstanceOf(ConnectorSecretKeyMissing);
  });

  it('deletes the secret by its opaque reference', async () => {
    const ref = await put(new mongoose.Types.ObjectId().toString(), 'slack', 'xoxb-secret');
    await revoke(ref);
    expect(await ConnectorSecret.findById(ref)).toBeNull();
  });
});
