/**
 * An acknowledgement must be scoped to the recipient who owns the row, and a
 * malformed caller id must be refused rather than thrown.
 *
 * `acknowledgeAttention` filters on `recipientUserId` beside `_id`, and the
 * guard `getOpenQueue` carries on its recipient (`:466`) was missing here.
 *
 * Measured on `bbab5c31` with a throwaway probe, because the claim that
 * motivated this had to be checked rather than repeated:
 *
 *   caller=undefined      -> {success:false,'Attention item not found'}  row open
 *   caller=null           -> {success:false,'Attention item not found'}  row open
 *   caller=''             -> THREW CastError                             row open
 *   caller='not-an-id'    -> THREW CastError                             row open
 *   caller=<the owner id> -> {success:true}                              row resolved
 *
 * So the cross-recipient acknowledgement this was proposed for does NOT happen:
 * the undefined and null filters are refused and the other person's row keeps
 * its `open` status. What does happen is a CastError out of the update for a
 * non-ObjectId id, which the route reports as a 500 — a client-side fact
 * answered as a server fault, and the shape the guard now puts beside the
 * item-id refusal.
 */

const mongoose = require('mongoose');
const Pod = require('../../models/Pod');
const AttentionItem = require('../../models/AttentionItem');
const service = require('../../services/attentionItemService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const makeAttention = (sourceId, recipientUserId, podId) => ({
  recipientUserId,
  podId,
  kind: 'mention',
  status: 'open',
  source: { type: 'message', id: sourceId },
  title: sourceId,
  createdAt: new Date('2026-09-01T00:00:00Z'),
});

describe('acknowledging an attention item is scoped to its recipient', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(clearMongoDb);

  it('a caller with no usable recipient id is refused, not thrown', async () => {
    const owner = new mongoose.Types.ObjectId();
    const stranger = new mongoose.Types.ObjectId();
    const pod = await Pod.create({
      name: 'Room', type: 'team', createdBy: owner, members: [owner, stranger],
    });

    // One item per caller shape, so one failing case cannot mask the next.
    const callers = [undefined, null, '', 'not-an-id'];
    await AttentionItem.insertMany(callers.map((_, index) => makeAttention(`theirs-${index}`, stranger, pod._id)));

    const rows = await AttentionItem.find({ 'source.id': /^theirs-/ }).sort({ 'source.id': 1 });
    expect(rows).toHaveLength(callers.length);

    for (let index = 0; index < callers.length; index += 1) {
      const result = await service.acknowledgeAttention(callers[index], String(rows[index]._id));
      expect(result).toMatchObject({ success: false });
    }

    const after = await AttentionItem.find({ 'source.id': /^theirs-/ }).lean();
    expect(after.map((row) => row.status)).toEqual(['open', 'open', 'open', 'open']);
  });

  it('a malformed attention id is refused before any update', async () => {
    const owner = new mongoose.Types.ObjectId();
    const pod = await Pod.create({ name: 'Room', type: 'team', createdBy: owner, members: [owner] });
    await AttentionItem.create(makeAttention('mine', owner, pod._id));

    expect(await service.acknowledgeAttention(owner, 'not-an-id')).toMatchObject({ success: false });
    expect(await service.acknowledgeAttention(owner, '')).toMatchObject({ success: false });
    expect((await AttentionItem.findOne({ 'source.id': 'mine' })).status).toBe('open');
  });

  it('the owner still resolves their own item, and only once', async () => {
    const owner = new mongoose.Types.ObjectId();
    const pod = await Pod.create({ name: 'Room', type: 'team', createdBy: owner, members: [owner] });
    const item = await AttentionItem.create(makeAttention('mine', owner, pod._id));

    expect(await service.acknowledgeAttention(owner, String(item._id))).toMatchObject({ success: true });
    const row = await AttentionItem.findById(item._id).lean();
    expect(row.status).toBe('resolved');
    expect(row.resolvedBy).toBe('acknowledged');
    // A second acknowledgement is not a second success: the selector requires
    // status 'open', so an already-resolved row is not found.
    expect(await service.acknowledgeAttention(owner, String(item._id))).toMatchObject({ success: false });
  });
});
