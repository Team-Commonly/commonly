/* eslint-disable import/extensions, import/no-unresolved -- backend TypeScript modules expose CJS exports. */
const mongoose = require('mongoose');
const Message = require('../../models/Message');
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
      await Freshness.recordRead(agentId, podId, start);
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
    await Freshness.recordRead(agentId, podId, start);
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
});
