const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MONGO_BINARY_VERSION, MONGOMS_DOWNLOAD_DIR } = require('../../utils/mongoBinaryConfig');
const AgentFirstContact = require('../../../models/AgentFirstContact');

describe('AgentFirstContact model', () => {
  test('enforces one durable marker per user and agent identity', () => {
    const relationshipIndex = AgentFirstContact.schema.indexes().find(([fields]) => (
      fields.userId === 1 && fields.agentName === 1 && fields.instanceId === 1
    ));

    expect(relationshipIndex).toBeDefined();
    expect(relationshipIndex[1]).toEqual(expect.objectContaining({ unique: true }));
    expect(AgentFirstContact.schema.path('instanceId').options).toEqual(expect.objectContaining({
      required: true,
      lowercase: true,
      trim: true,
    }));
  });
});

describe('AgentFirstContact hosted greeting claim', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({
      binary: { version: MONGO_BINARY_VERSION, downloadDir: MONGOMS_DOWNLOAD_DIR, skipMD5: true },
      instance: { dbName: 'agent-first-contact-greeting-claim-test' },
    });
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  test('a dated claim is atomic and can be renewed after the repeat window', async () => {
    const userId = new mongoose.Types.ObjectId();
    const podId = new mongoose.Types.ObjectId();
    const key = `greetedAtByPod.${podId}`;
    const identity = { userId, agentName: 'scout', instanceId: 'default' };
    await AgentFirstContact.create({ ...identity, firstPodId: podId });

    const claim = async (now) => AgentFirstContact.findOneAndUpdate(
      {
        ...identity,
        $or: [
          { [key]: { $exists: false } },
          { [key]: { $lt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) } },
        ],
      },
      { $set: { [key]: now } },
      { new: false, includeResultMetadata: true },
    );

    const now = new Date('2026-10-23T00:00:00Z');
    const [first, second] = await Promise.all([claim(now), claim(now)]);
    expect([first?.value, second?.value].filter(Boolean)).toHaveLength(1);

    const tooSoon = await claim(new Date('2026-11-01T00:00:00Z'));
    expect(tooSoon.value).toBeNull();

    const renewed = await claim(new Date('2026-11-24T00:00:00Z'));
    expect(renewed.value).not.toBeNull();
  });
});
