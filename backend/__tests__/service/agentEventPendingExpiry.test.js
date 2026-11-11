// F381: a pending event nobody claimed within the retention window is marked
// 'expired' and kept, never deleted, and a first_contact stays pending. A real
// mongod, because the claim is about which stored rows survive and in what state.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

const AgentEvent = require('../../models/AgentEvent');
const AgentEventService = require('../../services/agentEventService');

const POD = new mongoose.Types.ObjectId();
const DAY = 24 * 60 * 60 * 1000;
const event = async (type, ageMs) => {
  const row = await AgentEvent.create({
    agentName: 'maya', instanceId: 'default', podId: POD, type, payload: {},
  });
  const at = new Date(Date.now() - ageMs);
  await AgentEvent.collection.updateOne({ _id: row._id }, { $set: { createdAt: at, updatedAt: at } });
  return row._id;
};
const statusOf = async (id) => (await AgentEvent.findById(id).lean())?.status ?? 'deleted';

describe('pending events past the window', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    await clearMongoDb();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test('an old pending wake is expired and kept; a recent one and an old first_contact stay pending', async () => {
    const old = await event('chat.mention', 8 * DAY);
    const recent = await event('chat.mention', 2 * DAY);
    const greeting = await event('first_contact', 8 * DAY);

    const result = await AgentEventService.garbageCollect({});

    expect(await statusOf(old)).toBe('expired');
    expect((await AgentEvent.findById(old).lean()).expiredAt).toBeInstanceOf(Date);
    expect(await statusOf(recent)).toBe('pending');
    expect(await statusOf(greeting)).toBe('pending');
    expect(result.expiredPending).toBe(1);
    expect(result.deletedPending).toBe(0);
  });

  test('an expired event is still there after another pass, and is not listed as work', async () => {
    const old = await event('chat.mention', 8 * DAY);
    await AgentEventService.garbageCollect({});
    await AgentEventService.garbageCollect({});

    expect(await statusOf(old)).toBe('expired');
    const listed = await AgentEventService.list({ agentName: 'maya', instanceId: 'default' });
    expect((listed || []).map((e) => String(e._id))).not.toContain(String(old));
  });
});
