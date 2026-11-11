// F406: deleting a pod removes its external links and the QR images they
// stored in the object store, and leaves another pod's alone. A real mongod and
// the real Mongo object-store driver, because the claim is about what survives.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

jest.mock('../../services/starterTaskService', () => ({ completeConnectAgentStarterTask: jest.fn() }));

const Pod = require('../../models/Pod');
const ExternalLink = require('../../models/ExternalLink');
const { getObjectStore } = require('../../services/objectStore');
const { deletePodCascade } = require('../../services/podDeletionService');

const ownerId = new mongoose.Types.ObjectId();
const makePod = (name) => Pod.create({ name, type: 'chat', createdBy: ownerId, members: [ownerId] });
const addQr = async (pod) => {
  const key = `qr/${pod._id}/${new mongoose.Types.ObjectId()}.png`;
  await getObjectStore().put(key, Buffer.from('png'), 'image/png');
  await ExternalLink.create({ podId: pod._id, name: 'WeChat', type: 'wechat', qrCodeKey: key, createdBy: ownerId });
  return key;
};

describe('deleting a pod removes its QR codes', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => { await clearMongoDb(); });

  test('its links and stored images go; another pod keeps its own', async () => {
    const doomed = await makePod('Doomed');
    const kept = await makePod('Kept');
    const doomedKey = await addQr(doomed);
    const keptKey = await addQr(kept);

    await deletePodCascade(String(doomed._id));

    expect(await getObjectStore().get(doomedKey)).toBeNull();
    expect(await ExternalLink.countDocuments({ podId: doomed._id })).toBe(0);
    expect(await getObjectStore().get(keptKey)).not.toBeNull();
    expect(await ExternalLink.countDocuments({ podId: kept._id })).toBe(1);
  });
});
