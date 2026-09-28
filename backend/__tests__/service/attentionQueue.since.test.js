const mongoose = require('mongoose');
const Pod = require('../../models/Pod');
const AttentionItem = require('../../models/AttentionItem');
const service = require('../../services/attentionItemService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

/**
 * `since` narrows the open queue to work created AT OR AFTER an instant, so an
 * operator watcher can ask "what is new" once instead of paging the whole queue
 * eleven times a tick.
 *
 * Two properties are the whole point, and both are asserted against numbers that
 * would differ if the narrowing happened anywhere else:
 *
 *  1. INCLUSIVE of its own millisecond. A caller's cursor sitting at T cannot
 *     know about a row inserted at T after it was written, so an exclusive bound
 *     would drop that row from every later read — silently and for good. This is
 *     the same failure the CLI cursor had to fix (`cli/src/lib/inbox.js`), one
 *     layer down.
 *  2. Applied BEFORE the counts and before pagination, so `count`,
 *     `countsByKind`, `countsByPod`, `remaining` and `hasMore` all describe the
 *     narrowed view. A count that contradicts the rows is worse than a slow
 *     query, and the pod scope already follows exactly this rule.
 */

const BASE = new Date('2026-09-01T00:00:00Z');
const at = (minutes) => new Date(BASE.getTime() + minutes * 60 * 1000);

describe('the open queue can be narrowed to a created-since instant', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(clearMongoDb);

  const plant = async () => {
    const recipient = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    const [podA, podB] = await Pod.create([
      {
        name: 'A', type: 'team', createdBy: recipient, members: [recipient],
      },
      {
        name: 'B', type: 'team', createdBy: recipient, members: [recipient],
      },
    ]);
    const sourceTypes = {
      mention: 'message', approval: 'approval', decision: 'task', handoff: 'task',
    };
    const make = (id, pod, kind, createdAt) => ({
      recipientUserId: recipient,
      podId: pod._id,
      kind,
      status: 'open',
      source: { type: sourceTypes[kind], id },
      title: id,
      createdAt,
    });
    await AttentionItem.insertMany([
      make('old', podA, 'mention', at(-60)),
      make('bound', podB, 'approval', BASE),
      make('mid', podA, 'mention', at(60)),
      make('new', podB, 'handoff', at(120)),
      // Another recipient's row at the same instant, to keep the recipient scope
      // and the timestamp scope from being confused for each other.
      { ...make('theirs', podA, 'mention', BASE), recipientUserId: other },
    ]);
    return { recipient, podA, podB };
  };

  // Priority order, then newest first: approval, handoff, then mentions.
  const UNNARROWED = ['bound', 'new', 'mid', 'old'];

  it('keeps the item that sits exactly on the bound, and drops only what is older', async () => {
    const { recipient } = await plant();

    const all = await service.getOpenQueue(recipient);
    expect(all.items.map((item) => item.id)).toEqual(UNNARROWED);

    const narrowed = await service.getOpenQueue(recipient, { since: BASE });
    expect(narrowed.items.map((item) => item.id)).toEqual(['bound', 'new', 'mid']);

    // Just past the boundary: now the boundary row itself goes, which is what
    // separates `$gte` from a filter that never drops anything.
    const past = await service.getOpenQueue(recipient, { since: new Date(BASE.getTime() + 1) });
    expect(past.items.map((item) => item.id)).toEqual(['new', 'mid']);
  });

  it('reports every count for the narrowed view, not for the whole queue', async () => {
    const { recipient, podA, podB } = await plant();

    const narrowed = await service.getOpenQueue(recipient, { since: BASE });
    expect(narrowed.count).toBe(3);
    expect(narrowed.countsByKind).toEqual({
      approval: 1, handoff: 1, mention: 1,
    });
    expect(narrowed.countsByPod).toEqual({ [podA.id]: 1, [podB.id]: 2 });
    // Both are read from the narrowed set, so a filter applied after the page
    // was sliced cannot produce them: three rows are visible and three fit.
    const paged = await service.getOpenQueue(recipient, { since: BASE, limit: 3 });
    expect(paged.items).toHaveLength(3);
    expect(paged.remaining).toBe(0);
    expect(paged.hasMore).toBe(false);

    const shortPage = await service.getOpenQueue(recipient, { since: BASE, limit: 2 });
    expect(shortPage.items.map((item) => item.id)).toEqual(['bound', 'new']);
    expect(shortPage.count).toBe(3);
    expect(shortPage.remaining).toBe(1);
    expect(shortPage.hasMore).toBe(true);
  });

  it('takes an instant as a Date or as a string, and narrows with neither when it cannot read one', async () => {
    const { recipient } = await plant();

    expect((await service.getOpenQueue(recipient, { since: BASE.toISOString() })).items.map((item) => item.id))
      .toEqual(['bound', 'new', 'mid']);
    expect((await service.getOpenQueue(recipient, { since: BASE })).items.map((item) => item.id))
      .toEqual(['bound', 'new', 'mid']);

    // A bound the server cannot read narrows nothing. It must not empty the
    // queue: every row here is still the caller's, and a watcher that received
    // "nothing" would believe the queue was quiet. The route refuses these with
    // a 400, so this is the second line rather than the only one.
    const unusable = ['not-a-date', '', '   ', new Date('nonsense')];
    await Promise.all(unusable.map(async (value) => {
      const queue = await service.getOpenQueue(recipient, { since: value });
      expect(queue.items.map((item) => item.id)).toEqual(UNNARROWED);
    }));
  });
});
