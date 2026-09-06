const mongoose = require('mongoose');
const Pod = require('../../models/Pod');
const AttentionItem = require('../../models/AttentionItem');
const service = require('../../services/attentionItemService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

describe('uncapped attention counts — persisted query and membership', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(clearMongoDb);

  it('counts beyond 80, excludes revoked membership and other recipients, and recounts after acknowledgement', async () => {
    const recipient = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    const [busy, omitted, revoked] = await Pod.create([
      { name: 'Busy', type: 'team', createdBy: recipient, members: [recipient] },
      { name: 'Outside display cap', type: 'team', createdBy: other, members: [recipient] },
      { name: 'Revoked', type: 'team', createdBy: other, members: [other] },
    ]);
    const make = (id, pod, kind = 'mention', who = recipient, status = 'open') => ({
      recipientUserId: who, podId: pod._id, kind, status,
      source: { type: kind === 'mention' ? 'message' : 'approval', id }, title: id,
      createdAt: new Date('2026-09-01T00:00:00Z'),
    });
    await AttentionItem.insertMany([
      ...Array.from({ length: 90 }, (_, i) => make(`mention-${i}`, busy)),
      ...Array.from({ length: 4 }, (_, i) => make(`approval-${i}`, busy, 'approval')),
      { ...make('oldest', omitted), createdAt: new Date('2020-01-01') },
      make('revoked', revoked), make('other-user', busy, 'mention', other),
      make('closed', busy, 'mention', recipient, 'resolved'),
    ]);
    const queue = await service.getOpenQueue(recipient);
    expect(queue.count).toBe(95);
    expect(queue.countsByPod).toEqual({ [busy.id]: 94, [omitted.id]: 1 });
    expect(queue.items).toHaveLength(12);
    expect(queue.items.filter((item) => item.kind === 'mention')).toHaveLength(8);
    expect(queue.items.some((item) => item.podId === omitted.id)).toBe(false);

    const old = await AttentionItem.findOne({ 'source.id': 'oldest' });
    expect(await service.acknowledgeMention(other, old.id)).toMatchObject({ success: false });
    expect(await service.acknowledgeMention(recipient, old.id)).toMatchObject({ success: true });
    const next = await service.getOpenQueue(recipient);
    expect(next.count).toBe(94);
    expect(next.countsByPod).toEqual({ [busy.id]: 94 });
  });

  it('returns an authoritative empty shape for invalid recipients', async () => {
    expect(await service.getOpenQueue('invalid')).toEqual({ items: [], count: 0, countsByPod: {}, composePodId: null });
  });
});
