// F648: "Needs you" holds only what still needs this person. Observed on prod
// 2026-11-26: a ruled decision still listed, and a 19-day-old "Hopper is
// blocked" row nothing would ever clear.
const mongoose = require('mongoose');
const Pod = require('../../models/Pod');
const AttentionItem = require('../../models/AttentionItem');
const DecisionRequest = require('../../models/DecisionRequest');
const service = require('../../services/attentionItemService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const DAY = 24 * 60 * 60 * 1000;

describe('Needs you drops settled decisions and stale blocked rows (F648)', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(clearMongoDb);

  const ids = () => ({
    sam: new mongoose.Types.ObjectId(),
    ada: new mongoose.Types.ObjectId(),
    agent: new mongoose.Types.ObjectId(),
  });

  const decision = (pod, who, status) => DecisionRequest.create({
    podId: pod._id, agentUserId: who.agent, agentName: 'hopper', instanceId: 'default',
    decisionClass: Object.values(DecisionRequest.schema.path('decisionClass').enumValues)[0],
    title: `Ship it? (${status})`, question: 'Ship now or hold?',
    options: [{ label: 'Ship' }, { label: 'Hold' }], status, messageId: `m-${status}`,
    deciders: [{ userId: who.sam, username: 'sam' }, { userId: who.ada, username: 'ada' }],
    ...(status === 'ruled' ? { ruling: { value: 'Ship', byUserId: who.sam, byUsername: 'sam', at: new Date() } } : {}),
  });

  const decisionRow = (pod, recipient, d) => ({
    recipientUserId: recipient, podId: pod._id, kind: 'decision', status: 'open',
    source: { type: 'decision_request', id: String(d._id) }, title: d.title, messageId: d.messageId,
  });

  it('a ruled decision leaves the ruler\'s Needs you and the other decider\'s, even when its rows still read open', async () => {
    const who = ids();
    const pod = await Pod.create({ name: 'Launch', type: 'team', createdBy: who.sam, members: [who.sam, who.ada] });
    const ruled = await decision(pod, who, 'ruled');
    const pending = await decision(pod, who, 'pending');
    // The projection chooseDecision is meant to close but did not (its
    // resolve is best-effort): both deciders' rows for the ruled card are open.
    await AttentionItem.insertMany([
      decisionRow(pod, who.sam, ruled), decisionRow(pod, who.ada, ruled),
      decisionRow(pod, who.sam, pending), decisionRow(pod, who.ada, pending),
    ]);

    for (const person of [who.sam, who.ada]) {
      const queue = await service.getOpenQueue(person);
      expect(queue.items.map((item) => item.id)).toEqual([String(pending._id)]);
      expect(queue.count).toBe(1);
      expect(queue.countsByKind).toEqual({ decision: 1 });
    }
    // The stale rows are closed in the store too, so every other reader agrees.
    const left = await AttentionItem.find({ 'source.id': String(ruled._id) }).lean();
    expect(left.map((row) => row.status)).toEqual(['resolved', 'resolved']);
    // History keeps the ruling: the source row is untouched.
    expect((await DecisionRequest.findById(ruled._id).lean()).status).toBe('ruled');
  });

  const blockedRow = (pod, who, messageId, ageDays, extra = {}) => ({
    recipientUserId: who.sam, podId: pod._id, kind: 'blocked', status: 'open',
    source: { type: 'message', id: messageId }, title: 'Hopper is blocked',
    actorUserId: who.agent, messageId, threadRootId: messageId,
    sourceCreatedAt: new Date(Date.now() - ageDays * DAY), ...extra,
  });

  it('an agent\'s [BLOCKED] row past the cutoff leaves Needs you but stays in the store; a fresh one stays', async () => {
    const who = ids();
    const pod = await Pod.create({ name: 'Launch', type: 'team', createdBy: who.sam, members: [who.sam] });
    await AttentionItem.insertMany([
      blockedRow(pod, who, '901', 19),
      blockedRow(pod, who, '902', 1),
    ]);

    const result = await service.sweepStaleBlockedAttention();
    expect(result.aged).toBe(1);

    const queue = await service.getOpenQueue(who.sam);
    expect(queue.items.map((item) => item.id)).toEqual(['902']);
    expect(queue.count).toBe(1);

    // Still in history: the row is kept, resolved as `missed` (never counted
    // as acted on), not deleted.
    const stale = await AttentionItem.findOne({ 'source.id': '901' }).lean();
    expect(stale).toMatchObject({ status: 'resolved', resolvedBy: 'missed' });
  });

  it('keeps a long-blocked task and a hosted-MCP drift: each has its own clear and may still need the person', async () => {
    const who = ids();
    const pod = await Pod.create({ name: 'Launch', type: 'team', createdBy: who.sam, members: [who.sam] });
    await AttentionItem.insertMany([
      { recipientUserId: who.sam, podId: pod._id, kind: 'blocked', status: 'open', source: { type: 'task', id: 'task-1:u1' }, title: 'Deploy', createdAt: new Date(Date.now() - 19 * DAY) },
      { recipientUserId: who.sam, podId: pod._id, kind: 'blocked', status: 'open', source: { type: 'hosted_mcp', id: 'pin-1' }, title: 'Pin drifted', createdAt: new Date(Date.now() - 19 * DAY) },
    ]);
    await service.sweepStaleBlockedAttention();
    const queue = await service.getOpenQueue(who.sam);
    expect(queue.items.map((item) => item.id).sort()).toEqual(['pin-1', 'task-1:u1']);
  });

  it('the person\'s reply in a blocked post\'s thread clears it, like a mention', async () => {
    const who = ids();
    const pod = await Pod.create({ name: 'Launch', type: 'team', createdBy: who.sam, members: [who.sam] });
    await AttentionItem.insertMany([blockedRow(pod, who, '903', 1)]);

    const closed = await service.resolveMentionAttentionForReply({
      recipientUserId: who.sam, podId: pod._id, repliedAt: new Date(), threadRootId: '903',
    });
    expect(closed).toBe(1);
    expect((await service.getOpenQueue(who.sam)).items).toEqual([]);
    expect(await AttentionItem.findOne({ 'source.id': '903' }).lean()).toMatchObject({ status: 'resolved', resolvedBy: 'replied' });
  });
});
