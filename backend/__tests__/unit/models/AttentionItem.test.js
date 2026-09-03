const mongoose = require('mongoose');
const AttentionItem = require('../../../models/AttentionItem');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('AttentionItem', () => {
  const recipient = new mongoose.Types.ObjectId();
  const pod = new mongoose.Types.ObjectId();

  it('keeps a recipient/source fact unique and persists source snapshots', async () => {
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
});
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  afterEach(async () => { await clearMongoDb(); });
