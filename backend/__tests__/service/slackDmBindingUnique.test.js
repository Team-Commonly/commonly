/* eslint-disable import/extensions, import/no-unresolved */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Integration = require('../../models/Integration');

describe('one active Slack connection per workspace DM', () => {
  let mongod;
  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Integration.createIndexes();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  const row = (createdBy, isActive = true) => ({
    scope: 'user',
    type: 'slack',
    status: 'connected',
    isActive,
    createdBy,
    config: {
      teamId: 'T1', chatId: 'D1', chatType: 'im', liveRelay: true,
    },
  });

  test('refuses a concurrent second bind and releases the key when the first is inactive', async () => {
    const first = await Integration.create(row(new mongoose.Types.ObjectId()));
    const secondOwner = new mongoose.Types.ObjectId();

    await expect(Integration.create(row(secondOwner))).rejects.toMatchObject({ code: 11000 });
    await Integration.updateOne({ _id: first._id }, { $set: { isActive: false } });
    await expect(Integration.create(row(secondOwner))).resolves.toMatchObject({
      type: 'slack', isActive: true,
    });
  });

  test('a paused relay still reserves its active DM', async () => {
    await Integration.deleteMany({});
    const paused = row(new mongoose.Types.ObjectId());
    paused.config.liveRelay = false;
    await Integration.create(paused);
    await expect(Integration.create(row(new mongoose.Types.ObjectId()))).rejects.toMatchObject({ code: 11000 });
  });
});
