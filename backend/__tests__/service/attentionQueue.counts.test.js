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
      source: { type: kind === 'mention' ? 'message' : kind === 'approval' ? 'approval' : 'task', id }, title: id,
      createdAt: new Date('2026-09-01T00:00:00Z'),
    });
    await AttentionItem.insertMany([
      ...Array.from({ length: 90 }, (_, i) => make(`mention-${i}`, busy)),
      ...Array.from({ length: 4 }, (_, i) => make(`approval-${i}`, busy, 'approval')),
      ...Array.from({ length: 3 }, (_, i) => make(`handoff-${i}`, busy, 'handoff')),
      make('legacy-handoff', busy, 'decision'),
      { ...make('decision-request', busy, 'decision'), source: { type: 'decision_request', id: 'decision-request' } },
      { ...make('oldest', omitted), createdAt: new Date('2020-01-01') },
      ...Array.from({ length: 51 }, (_, i) => make(`omitted-mention-${i}`, omitted)),
      make('revoked', revoked), make('other-user', busy, 'mention', other),
      make('closed', busy, 'mention', recipient, 'resolved'),
    ]);
    const queue = await service.getOpenQueue(recipient);
    expect(queue.count).toBe(151);
    expect(queue.countsByPod).toEqual({ [busy.id]: 99, [omitted.id]: 52 });
    expect(queue.countsByKind).toEqual({ mention: 142, approval: 4, handoff: 4, decision: 1 });
    expect(queue.items).toHaveLength(50);
    expect(queue.items.filter((item) => item.kind === 'mention')).toHaveLength(41);
    expect(queue.remaining).toBe(101);
    expect(queue.hasMore).toBe(true);

    const nextPage = await service.getOpenQueue(recipient, { offset: 50 });
    expect(nextPage.items).toHaveLength(50);
    expect(nextPage.remaining).toBe(51);
    expect(nextPage.hasMore).toBe(true);

    const scoped = await service.getOpenQueue(recipient, { podId: omitted.id.toString() });
    expect(scoped.count).toBe(52);
    expect(scoped.items).toHaveLength(50);
    expect(scoped.items[0].podId).toBe(omitted.id.toString());
    expect(scoped.countsByKind).toEqual({ mention: 52 });
    expect(scoped.remaining).toBe(2);

    const busyScoped = await service.getOpenQueue(recipient, { podId: busy.id.toString(), limit: 50 });
    expect(busyScoped.count).toBe(99);
    expect(busyScoped.countsByKind).toEqual({ mention: 90, approval: 4, handoff: 4, decision: 1 });
    expect(Object.values(busyScoped.countsByKind).reduce((sum, value) => sum + value, 0)).toBe(busyScoped.count);

    const old = await AttentionItem.findOne({ 'source.id': 'oldest' });
    expect(await service.acknowledgeMention(other, old.id)).toMatchObject({ success: false });
    expect(await service.acknowledgeMention(recipient, old.id)).toMatchObject({ success: true });
    const next = await service.getOpenQueue(recipient);
    expect(next.count).toBe(150);
    expect(next.countsByPod).toEqual({ [busy.id]: 99, [omitted.id]: 51 });
  });

  it('returns an authoritative empty shape for invalid recipients', async () => {
    expect(await service.getOpenQueue('invalid')).toEqual({
      items: [], count: 0, countsByPod: {}, countsByKind: {}, composePodId: null,
      offset: 0, limit: 50, remaining: 0, hasMore: false,
    });
  });

  it('acknowledges mentions and handoffs but never a decision request or approval', async () => {
    const recipient = new mongoose.Types.ObjectId();
    const pod = await Pod.create({ name: 'Authority', type: 'team', createdBy: recipient, members: [recipient] });
    const make = (kind, sourceType, id) => ({
      recipientUserId: recipient,
      podId: pod._id,
      kind,
      source: { type: sourceType, id },
      title: id,
      status: 'open',
    });
    const [mention, handoff, legacy, decision, approval] = await AttentionItem.create([
      make('mention', 'message', 'mention-1'),
      make('handoff', 'task', 'task-1:update-1'),
      make('decision', 'task', 'task-2:update-1'),
      make('decision', 'decision_request', 'decision-1'),
      make('approval', 'approval', 'approval-1'),
    ]);

    await expect(service.acknowledgeMention(recipient, mention.id)).resolves.toEqual({ success: true });
    await expect(service.acknowledgeMention(recipient, handoff.id)).resolves.toEqual({ success: true });
    await expect(service.acknowledgeMention(recipient, legacy.id)).resolves.toEqual({ success: true });
    await expect(service.acknowledgeMention(recipient, decision.id)).resolves.toEqual({ success: false, error: 'Attention item not found' });
    await expect(service.acknowledgeMention(recipient, approval.id)).resolves.toEqual({ success: false, error: 'Attention item not found' });

    await expect(AttentionItem.find({ recipientUserId: recipient }).sort({ createdAt: 1 }).lean()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ _id: mention._id, status: 'resolved', resolvedBy: 'acknowledged' }),
      expect.objectContaining({ _id: handoff._id, status: 'resolved', resolvedBy: 'acknowledged' }),
      expect.objectContaining({ _id: legacy._id, status: 'resolved', resolvedBy: 'acknowledged' }),
      expect.objectContaining({ _id: decision._id, status: 'open' }),
      expect.objectContaining({ _id: approval._id, status: 'open' }),
    ]));
  });
});
