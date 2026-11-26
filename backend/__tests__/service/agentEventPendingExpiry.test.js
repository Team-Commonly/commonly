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

// An agent that never listens (a key never used, or one used only over MCP)
// leaves a person's mention to wait out the window. It expires with the
// unanswered line, and an MCP-only agent's first_contact is retired too.
describe('expiry for an agent that never listens', () => {
  const User = require('../../models/User');
  const unanswered = require('../../services/unansweredMentionService');

  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    await clearMongoDb();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const bot = (agentName, tokens) => User.create({
    username: `${agentName}-bot`,
    email: `${agentName}@agents.test`,
    password: 'x'.repeat(12),
    isBot: true,
    botMetadata: { agentName, instanceId: 'default' },
    agentRuntimeTokens: tokens,
  });
  const eventFor = async (agentName, type, ageMs) => {
    const row = await AgentEvent.create({
      agentName, instanceId: 'default', podId: POD, type, payload: {},
    });
    const at = new Date(Date.now() - ageMs);
    await AgentEvent.collection.updateOne({ _id: row._id }, { $set: { createdAt: at, updatedAt: at } });
    return row._id;
  };

  test('a person\'s mention that expires unclaimed gets the unanswered line and is marked told', async () => {
    const note = jest.spyOn(unanswered, 'noteUnansweredMention').mockResolvedValue(true);
    const old = await event('chat.mention', 8 * DAY);

    const result = await AgentEventService.garbageCollect({});

    expect(note).toHaveBeenCalledTimes(1);
    expect(String(note.mock.calls[0][0]._id)).toBe(String(old));
    const row = await AgentEvent.findById(old).lean();
    expect(row.status).toBe('expired');
    expect(row.unansweredNoticeAt).toBeInstanceOf(Date);
    expect(result.expiredPending).toBe(1);
  });

  test('a row whose person was already told gets no second line; no line owed means no mark', async () => {
    const note = jest.spyOn(unanswered, 'noteUnansweredMention').mockResolvedValue(false);
    const told = await event('chat.mention', 8 * DAY);
    await AgentEvent.collection.updateOne({ _id: told }, { $set: { unansweredNoticeAt: new Date() } });
    const silent = await event('dm.message', 8 * DAY);
    const heartbeat = await event('heartbeat', 8 * DAY);

    const result = await AgentEventService.garbageCollect({});

    expect(note.mock.calls.map(([row]) => String(row._id))).toEqual([String(silent)]);
    expect(await statusOf(told)).toBe('expired');
    expect(await statusOf(heartbeat)).toBe('expired');
    expect((await AgentEvent.findById(silent).lean()).unansweredNoticeAt).toBeFalsy();
    expect(result.expiredPending).toBe(3);
  });

  test('a failed line still expires the row', async () => {
    jest.spyOn(unanswered, 'noteUnansweredMention').mockRejectedValue(new Error('pg down'));
    const old = await event('thread.mention', 8 * DAY);
    await AgentEventService.garbageCollect({});
    expect(await statusOf(old)).toBe('expired');
  });

  test('an MCP-only agent\'s old first_contact expires; a never-used or listened key keeps it pending', async () => {
    const seen = new Date(Date.now() - DAY);
    await bot('desk', [{ tokenHash: 'a', lastUsedAt: seen, lastMcpSeenAt: seen }]);
    await bot('fresh', [{ tokenHash: 'b' }]);
    await bot('both', [{ tokenHash: 'c', lastMcpSeenAt: seen, lastListenedAt: seen }]);
    const mcpOnly = await eventFor('desk', 'first_contact', 8 * DAY);
    const recentMcpOnly = await eventFor('desk', 'first_contact', 2 * DAY);
    const neverUsed = await eventFor('fresh', 'first_contact', 8 * DAY);
    const listened = await eventFor('both', 'first_contact', 8 * DAY);

    await AgentEventService.garbageCollect({});

    expect(await statusOf(mcpOnly)).toBe('expired');
    expect(await statusOf(recentMcpOnly)).toBe('pending');
    expect(await statusOf(neverUsed)).toBe('pending');
    expect(await statusOf(listened)).toBe('pending');
  });
});
