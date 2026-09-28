/**
 * An acknowledgement must be scoped to the recipient who owns the row, and an
 * id that is not a canonical 24-hex user id must be refused rather than cast.
 *
 * `acknowledgeAttention` carries the item-id guard but not the recipient guard
 * `getOpenQueue` has (`attentionItemService.ts:466`). What that omission does was
 * MEASURED with a probe on `bbab5c31`, acking a row owned by another recipient,
 * because the claim that motivated it had to be checked rather than repeated:
 *
 *   caller=undefined      -> {success:false,'Attention item not found'}  row open
 *   caller=null           -> {success:false,'Attention item not found'}  row open
 *   caller=''             -> THREW CastError                            row open
 *   caller='not-an-id'    -> THREW CastError                            row open
 *   caller='507f191e810c' -> casts to 353037663139316538313063 (its own ASCII bytes
 *                            read as the 12-byte form), i.e. a valid ObjectId that
 *                            is not anybody — measured, not assumed
 *   caller=<the owner id> -> {success:true}                             row resolved
 *
 * So the cross-recipient acknowledgement this was first proposed for does NOT
 * happen: `undefined` and `null` are refused and the other person's row keeps its
 * `open` status. **Those two shapes are deliberately not arms here** — they pass
 * against unguarded code, so an arm asserting them would witness nothing about
 * the guard. What the guard buys is a TYPED refusal for an id that cannot be a
 * user id, in place of a CastError the route reports as a 500 and in place of a
 * 12-character string silently casting to somebody else's ObjectId.
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

  it('an id that cannot be a user id is refused by name, never thrown', async () => {
    const owner = new mongoose.Types.ObjectId();
    const stranger = new mongoose.Types.ObjectId();
    const pod = await Pod.create({
      name: 'Room', type: 'team', createdBy: owner, members: [owner, stranger],
    });

    // One item per caller shape, so one case cannot mask the next. The third is
    // mongoose's legacy 12-byte form: it casts to a valid ObjectId that is not
    // anybody, which is why the length is checked and not just the cast.
    const callers = ['', 'not-an-id', '507f191e810c'];
    await AttentionItem.insertMany(callers.map((_, index) => makeAttention(`theirs-${index}`, stranger, pod._id)));

    const rows = await AttentionItem.find({ 'source.id': /^theirs-/ }).sort({ 'source.id': 1 });
    expect(rows).toHaveLength(callers.length);

    for (let index = 0; index < callers.length; index += 1) {
      const result = await service.acknowledgeAttention(callers[index], String(rows[index]._id));
      expect(result).toEqual({ success: false, error: 'Invalid recipient' });
    }

    const after = await AttentionItem.find({ 'source.id': /^theirs-/ }).lean();
    expect(after.map((row) => row.status)).toEqual(['open', 'open', 'open']);
  });

  it('a valid id belonging to somebody else cannot acknowledge this recipient\'s row', async () => {
    const owner = new mongoose.Types.ObjectId();
    const stranger = new mongoose.Types.ObjectId();
    const pod = await Pod.create({
      name: 'Room', type: 'team', createdBy: owner, members: [owner, stranger],
    });
    const item = await AttentionItem.create(makeAttention('mine', owner, pod._id));

    expect(await service.acknowledgeAttention(stranger, String(item._id)))
      .toEqual({ success: false, error: 'Attention item not found' });
    expect((await AttentionItem.findById(item._id).lean()).status).toBe('open');

    // The positive control: the same call with the owner resolves it, so the
    // refusal above is about the recipient and not about the row being unackable.
    expect(await service.acknowledgeAttention(owner, String(item._id))).toEqual({ success: true });
    const resolved = await AttentionItem.findById(item._id).lean();
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedBy).toBe('acknowledged');
    // And a second acknowledgement is not a second success: the selector
    // requires status 'open'.
    expect(await service.acknowledgeAttention(owner, String(item._id)))
      .toEqual({ success: false, error: 'Attention item not found' });
  });

  it('a malformed attention id is refused before any update', async () => {
    const owner = new mongoose.Types.ObjectId();
    const pod = await Pod.create({ name: 'Room', type: 'team', createdBy: owner, members: [owner] });
    await AttentionItem.create(makeAttention('mine', owner, pod._id));

    expect(await service.acknowledgeAttention(owner, 'not-an-id'))
      .toEqual({ success: false, error: 'Invalid attention item' });
    expect(await service.acknowledgeAttention(owner, ''))
      .toEqual({ success: false, error: 'Invalid attention item' });
    expect((await AttentionItem.findOne({ 'source.id': 'mine' })).status).toBe('open');
  });
});
