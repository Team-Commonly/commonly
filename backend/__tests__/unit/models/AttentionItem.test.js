const mongoose = require('mongoose');
const AttentionItem = require('../../../models/AttentionItem');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('AttentionItem', () => {
  const recipient = new mongoose.Types.ObjectId();
  const pod = new mongoose.Types.ObjectId();

  it('keeps a recipient/source fact unique and persists source snapshots', async () => {
    // The uniqueness this test asserts lives in an index, and Mongoose builds
    // indexes in the background after the model is first used. Without waiting
    // for the build, the duplicate insert below races the index and resolves
    // instead of rejecting (main went red on exactly that, 2026-09-03).
    await AttentionItem.syncIndexes();
    await AttentionItem.create({
      recipientUserId: recipient,
      podId: pod,
      kind: 'mention',
      source: { type: 'message', id: '42' },
      title: 'Ada mentioned you',
      detail: '@sam please review',
      messageId: '42',
      threadRootId: '41',
    });

    await expect(AttentionItem.create({
      recipientUserId: recipient,
      podId: pod,
      kind: 'mention',
      source: { type: 'message', id: '42' },
      title: 'duplicate',
    })).rejects.toMatchObject({ code: 11000 });

    const row = await AttentionItem.findOne({ recipientUserId: recipient }).lean();
    expect(row).toMatchObject({
      status: 'open', kind: 'mention', messageId: '42', threadRootId: '41',
      source: { type: 'message', id: '42' },
    });
  });

  it('accepts a task source as a recipient-owned board attention fact', async () => {
    const row = new AttentionItem({
      recipientUserId: recipient,
      podId: pod,
      kind: 'decision',
      source: { type: 'task', id: 'task-1:update-1' },
      title: 'Choose a deploy shape',
    });

    await expect(row.validate()).resolves.toBeUndefined();
  });
});
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  afterEach(async () => { await clearMongoDb(); });
