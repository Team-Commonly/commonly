/* eslint-disable import/extensions, import/no-unresolved -- backend TypeScript modules expose CJS exports. */
const mongoose = require('mongoose');
const Message = require('../../models/Message');
require('../../models/User');
const Cursor = require('../../models/AgentPodReadCursor');
const Freshness = require('../../services/agentSendFreshness');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

describe('agent freshness: delayed Mongo-only write', () => {
  const originalPgHost = process.env.PG_HOST;
  const podId = new mongoose.Types.ObjectId();
  const agentId = new mongoose.Types.ObjectId();
  const peerId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    delete process.env.PG_HOST;
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
    if (originalPgHost === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = originalPgHost;
  });

  beforeEach(async () => {
    await Message.deleteMany({});
    await Cursor.deleteMany({});
  });

  it('ignores claim lines for sends and cursor advancement but still holds ordinary peer chat', async () => {
    await Message.collection.insertOne({ podId, userId: peerId, content: 'peer claimed TASK-406',
      messageType: 'system', payload: { kind: 'system-action' }, createdAt: new Date(), freshnessCommittedAt: new Date(), freshnessPending: false });
    expect(await Freshness.unseenMessages(agentId, podId)).toBeNull();
    const start = await Freshness.readStart(podId);
    await Freshness.recordRead(agentId, podId, start, []);
    expect(await Cursor.findById(`${agentId}:${podId}`).lean()).not.toBeNull();
    await Message.collection.insertOne({ podId, userId: peerId, content: 'ordinary peer chat',
      messageType: 'text', createdAt: new Date(), freshnessPending: true });
    const hold = await Freshness.unseenMessages(agentId, podId);
    expect(hold).toMatchObject({ unseenCount: 1, messages: [{ content: 'ordinary peer chat' }] });
  });

  it('holds an insert whose createdAt predates a successful read but whose save finishes later', async () => {
    const peerMessage = new Message({
      podId,
      userId: peerId,
      content: 'late commit',
      createdAt: new Date(Date.now() - 1000),
    });
    const insert = Message.collection.insertOne.bind(Message.collection);
    let resumeInsert;
    let notifyInsert;
    const paused = new Promise((resolve) => { notifyInsert = resolve; });
    const gate = new Promise((resolve) => { resumeInsert = resolve; });
    const spy = jest.spyOn(Message.collection, 'insertOne').mockImplementation(async (...args) => {
      notifyInsert();
      await gate;
      return insert(...args);
    });

    let start;
    try {
      const saving = peerMessage.save();
      await paused;
      start = await Freshness.readStart(podId);
      expect(await Message.find({ podId }).lean()).toHaveLength(0);
      await Freshness.recordRead(agentId, podId, start, []);
      resumeInsert();
      await saving;
    } finally {
      resumeInsert();
      spy.mockRestore();
    }

    const stored = await Message.findById(peerMessage._id).lean();
    expect(stored.freshnessPending).toBe(false);
    expect(stored.freshnessCommittedAt.getTime()).toBeGreaterThanOrEqual(start.at.getTime());
    const hold = await Freshness.unseenMessages(agentId, podId);
    expect(hold).toMatchObject({ code: 'unseen_messages', unseenCount: 1 });
    expect(hold.messages[0].content).toBe('late commit');
  });

  it('holds a persisted write left pending if its commit stamp fails', async () => {
    const start = await Freshness.readStart(podId);
    await Freshness.recordRead(agentId, podId, start, []);
    await Message.collection.insertOne({
      podId,
      userId: peerId,
      content: 'pending commit',
      messageType: 'text',
      createdAt: new Date(Date.now() - 1000),
      freshnessPending: true,
    });
    expect(await Freshness.unseenMessages(agentId, podId))
      .toMatchObject({ code: 'unseen_messages', unseenCount: 1 });
  });

  it('does not clear a hold when a delayed commit falls outside the returned tail', async () => {
    const now = Date.now();
    const previousAt = new Date(now - 60000);
    await Cursor.create({
      _id: `${agentId}:${podId}`, agentUserId: agentId, podId, readAt: previousAt,
    });
    const newer = Array.from({ length: 21 }, (_, i) => ({
      podId,
      userId: peerId,
      content: `newer ${i}`,
      messageType: 'text',
      createdAt: new Date(now - 20000 + i),
      freshnessPending: false,
      freshnessCommittedAt: new Date(now - 10000 + i),
    }));
    await Message.collection.insertMany([
      ...newer,
      {
        podId,
        userId: peerId,
        content: 'delayed older timestamp',
        messageType: 'text',
        createdAt: new Date(now - 30000),
        freshnessPending: false,
        freshnessCommittedAt: new Date(now - 1000),
      },
    ]);

    const start = await Freshness.readStart(podId);
    const returnedTail = await Message.find({ podId }).sort({ createdAt: -1 }).limit(20).lean();
    expect(returnedTail.map((message) => message.content)).not.toContain('delayed older timestamp');
    await Freshness.recordRead(agentId, podId, start, returnedTail.map((message) => String(message._id)));
    expect((await Cursor.findById(`${agentId}:${podId}`)).readAt).toEqual(previousAt);
    const hold = await Freshness.unseenMessages(agentId, podId);
    expect(hold.unseenCount).toBe(22);
    expect(hold.messages[0].content).toBe('delayed older timestamp');
  });
  it.each([false, true])('explicitly catches up thousands of rows (existing cursor: %s), preserving later commits', async (existing) => {
    const old = new Date(Date.now() - 60000);
    if (existing) await Cursor.create({
      _id: `${agentId}:${podId}`, agentUserId: agentId, podId, readAt: new Date(0),
    });
    await Message.collection.insertMany(Array.from({ length: 2400 }, (_, i) => ({
      podId, userId: peerId, content: `history ${i}`, messageType: 'text',
      createdAt: new Date(old.getTime() + i),
    })));
    const start = await Freshness.readStart(podId);
    const tail = await Message.find({ podId }).sort({ createdAt: -1 }).limit(20).lean();
    const ids = tail.map((row) => String(row._id));
    await Freshness.recordRead(agentId, podId, start, ids);
    expect((await Freshness.unseenMessages(agentId, podId)).unseenCount).toBe(2400);
    await Message.collection.insertOne({
      podId, userId: peerId, content: 'late commit with old timestamp', messageType: 'text',
      createdAt: old, freshnessPending: false,
      freshnessCommittedAt: new Date(start.at.getTime() + 1),
    });
    expect(await Freshness.recordCatchUp(agentId, podId, start, ids)).toEqual({ skippedCount: 2380 });
    const hold = await Freshness.unseenMessages(agentId, podId);
    expect(hold).toMatchObject({ unseenCount: 1 });
    expect(hold.messages[0].content).toBe('late commit with old timestamp');
    // Replaying an older receipt never rolls the cursor back.
    await Freshness.recordCatchUp(agentId, podId, { at: old }, []);
    expect((await Cursor.findById(`${agentId}:${podId}`)).readAt).toEqual(start.at);
  });

});
