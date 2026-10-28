// @ts-nocheck
// ADR-002 Phase 1: MongoObjectStore driver contract.

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../../utils/testUtils');
const { MongoObjectStore } = require('../../../../services/objectStore/drivers/mongoDriver');

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('MongoObjectStore (ADR-002 Phase 1)', () => {
  let store;

  beforeAll(async () => {
    await setupMongoDb();
  });
  afterAll(async () => {
    await closeMongoDb();
  });
  afterEach(async () => {
    await clearMongoDb();
  });

  beforeEach(() => {
    store = new MongoObjectStore();
  });

  it('exposes driver name and a default max size', () => {
    expect(store.capabilities.name).toBe('mongo');
    expect(store.capabilities.maxObjectBytes).toBeGreaterThan(0);
  });

  it('round-trips bytes and mime through put/get', async () => {
    const body = Buffer.from('hello-commonly');
    await store.put('k1.jpg', body, 'image/jpeg');

    const got = await store.get('k1.jpg');
    expect(got).not.toBeNull();
    expect(got.mime).toBe('image/jpeg');
    expect(got.size).toBe(body.length);
    const bytes = await streamToBuffer(got.stream);
    expect(bytes.equals(body)).toBe(true);
  });

  it('returns null for a missing key', async () => {
    const got = await store.get('does-not-exist.png');
    expect(got).toBeNull();
  });

  it('put is idempotent per key (overwrite)', async () => {
    await store.put('same.png', Buffer.from('v1'), 'image/png');
    await store.put('same.png', Buffer.from('v2-longer'), 'image/png');

    const got = await store.get('same.png');
    const bytes = await streamToBuffer(got.stream);
    expect(bytes.toString()).toBe('v2-longer');
    expect(got.size).toBe(9);
  });

  it('delete removes a previously stored key', async () => {
    await store.put('to-delete.gif', Buffer.from('bye'), 'image/gif');
    await store.delete('to-delete.gif');
    const got = await store.get('to-delete.gif');
    expect(got).toBeNull();
  });

  it('deletes only an exact ownership namespace and refuses an empty prefix', async () => {
    await store.put('user-abc-one.png', Buffer.from('a'), 'image/png');
    await store.put('user-abc-two.png', Buffer.from('b'), 'image/png');
    await store.put('user-abcd-keep.png', Buffer.from('c'), 'image/png');
    await expect(store.deletePrefix('')).rejects.toThrow('prefix');
    expect(await store.get('user-abc-one.png')).not.toBeNull();
    await store.deletePrefix('user-abc-');
    expect(await store.get('user-abc-one.png')).toBeNull();
    expect(await store.get('user-abc-two.png')).toBeNull();
    expect(await store.get('user-abcd-keep.png')).not.toBeNull();
  });

  it('delete is a no-op for a missing key', async () => {
    await expect(store.delete('never-existed')).resolves.toBeUndefined();
  });
});
