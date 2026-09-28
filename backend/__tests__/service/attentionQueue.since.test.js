const mongoose = require('mongoose');
const Pod = require('../../models/Pod');
const AttentionItem = require('../../models/AttentionItem');
const service = require('../../services/attentionItemService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

/**
 * `since` opens a WINDOW on the open queue: work created at or after an instant.
 * It exists so an operator watcher tick is one request instead of paging the whole
 * queue (550 open items is eleven requests) against a limiter of 60 requests a
 * minute keyed on the client IP that every session on the host shares with the
 * person's own Activity page.
 *
 * What is asserted here, and why each one is discriminating:
 *
 *  1. The window is INCLUSIVE of its own millisecond (`createdAt >= since`). A
 *     caller's cursor cannot know about a row inserted at its own millisecond
 *     after it was written; an exclusive bound would drop that row from that read
 *     and from every later one. The arm plants a second row on the boundary and
 *     ticks from the `nextSince` the first tick returned.
 *  2. The COUNTS DO NOT NARROW. `count`, `countsByKind` and `countsByPod` keep
 *     describing the whole open set, so an Activity badge and an unfiltered caller
 *     are unchanged; the window size travels in `windowCount`. An arm with an
 *     EMPTY window asserts the total is still reported, which is what makes this
 *     a real constraint rather than a comment.
 *  3. `nextSince` is the newest instant DELIVERED — the max over the page, not
 *     over the window — because a caller resumes from it and must not skip past a
 *     value it has not seen. A one-row page is what separates those two.
 *  4. Pagination happens WITHIN the window, so `remaining`/`hasMore` can reach
 *     zero; rows outside the window are never delivered, so counting them would be
 *     an unworkable page count.
 *  5. A bound the server cannot read narrows NOTHING. It must not empty the queue:
 *     a watcher that received "nothing" would believe the queue was quiet. The
 *     route refuses such a value with a 400, so this is the second line.
 *
 * The rows are inserted with explicit `createdAt` values purely to place them in
 * time — the production writer (`recordForRecipients`) sets it from the model's
 * own `now` at insert. Nothing here asserts that a BACKDATED row survives a bound;
 * that gap is the caller's lookback window W, and it is bounded rather than
 * closed.
 */

const BASE = new Date('2026-09-01T00:00:00Z');
const at = (minutes) => new Date(BASE.getTime() + minutes * 60 * 1000);

describe('the open queue window (createdAt >= since)', () => {
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
      // Another recipient's row on the boundary, so the recipient scope and the
      // time scope cannot be mistaken for each other.
      { ...make('theirs', podA, 'mention', BASE), recipientUserId: other },
    ]);
    return { recipient, podA, podB };
  };

  // Whole-set order: priority first, then newest first.
  const UNNARROWED = ['bound', 'new', 'mid', 'old'];
  const WHOLE_KINDS = { approval: 1, handoff: 1, mention: 2 };

  it('windows the page but leaves every count describing the whole open set', async () => {
    const { recipient, podA, podB } = await plant();

    const all = await service.getOpenQueue(recipient);
    expect(all.items.map((item) => item.id)).toEqual(UNNARROWED);
    expect(all.count).toBe(4);
    expect(all.windowCount).toBe(4);
    expect(all.countsByKind).toEqual(WHOLE_KINDS);
    expect(all.countsByPod).toEqual({ [podA.id]: 2, [podB.id]: 2 });
    expect(all.nextSince).toBe(at(120).toISOString());

    const windowed = await service.getOpenQueue(recipient, { since: BASE });
    expect(windowed.items.map((item) => item.id)).toEqual(['bound', 'new', 'mid']);
    expect(windowed.windowCount).toBe(3);
    // The three that did NOT narrow: this is the arm that kills a filter placed
    // on the counts.
    expect(windowed.count).toBe(4);
    expect(windowed.countsByKind).toEqual(WHOLE_KINDS);
    expect(windowed.countsByPod).toEqual({ [podA.id]: 2, [podB.id]: 2 });
  });

  it('pages within the window, so remaining can reach zero while count stays whole', async () => {
    const { recipient } = await plant();

    const first = await service.getOpenQueue(recipient, { since: BASE, limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(['bound', 'new']);
    expect(first.windowCount).toBe(3);
    expect(first.count).toBe(4);
    expect(first.remaining).toBe(1);
    expect(first.hasMore).toBe(true);

    const second = await service.getOpenQueue(recipient, { since: BASE, limit: 2, offset: 2 });
    expect(second.items.map((item) => item.id)).toEqual(['mid']);
    expect(second.remaining).toBe(0);
    expect(second.hasMore).toBe(false);
  });

  it('returns nextSince as the newest instant delivered, not the newest in the window', async () => {
    const { recipient } = await plant();

    const one = await service.getOpenQueue(recipient, { since: BASE, limit: 1 });
    expect(one.items.map((item) => item.id)).toEqual(['bound']);
    expect(one.nextSince).toBe(BASE.toISOString());

    const rest = await service.getOpenQueue(recipient, { since: BASE });
    expect(rest.nextSince).toBe(at(120).toISOString());
  });

  it('keeps a row that shares the instant the cursor resumes from', async () => {
    const { recipient, podB } = await plant();
    await AttentionItem.create({
      recipientUserId: recipient,
      podId: podB._id,
      kind: 'mention',
      status: 'open',
      source: { type: 'message', id: 'twin' },
      title: 'twin',
      createdAt: BASE,
    });

    // Tick one: the newest row at or after the cursor... the approval at BASE.
    const tickOne = await service.getOpenQueue(recipient, { since: BASE, limit: 1 });
    expect(tickOne.items.map((item) => item.id)).toEqual(['bound']);
    expect(tickOne.nextSince).toBe(BASE.toISOString());

    // Tick two resumes from nextSince. The twin WAS inserted at that same
    // millisecond after tick one was built (it is created above, but the point is
    // the boundary: what matters is that the bound includes it).
    const tickTwo = await service.getOpenQueue(recipient, { since: tickOne.nextSince });
    expect(tickTwo.items.map((item) => item.id)).toContain('twin');
  });

  it('returns rows inside the caller lookback and not rows behind it', async () => {
    const { recipient } = await plant();

    // A caller resuming from the newest delivered instant, looking back 60s.
    const lookback = new Date(at(120).getTime() - 60 * 1000);
    const wide = await service.getOpenQueue(recipient, { since: lookback });
    expect(wide.items.map((item) => item.id)).toEqual(['new']);

    // The control: a bound behind that lookback returns the row that fell out,
    // so the arm above cannot pass on a query that ignores the bound.
    const wider = await service.getOpenQueue(recipient, { since: at(60) });
    expect(wider.items.map((item) => item.id)).toEqual(['new', 'mid']);
  });

  it('reports an empty window without emptying the counts, and reads a Date or a string', async () => {
    const { recipient, podA, podB } = await plant();

    const empty = await service.getOpenQueue(recipient, { since: at(600) });
    expect(empty.items).toEqual([]);
    expect(empty.windowCount).toBe(0);
    expect(empty.nextSince).toBeNull();
    expect(empty.count).toBe(4);
    expect(empty.countsByKind).toEqual(WHOLE_KINDS);
    expect(empty.countsByPod).toEqual({ [podA.id]: 2, [podB.id]: 2 });
    expect(empty.hasMore).toBe(false);

    expect((await service.getOpenQueue(recipient, { since: BASE.toISOString() })).windowCount).toBe(3);
    expect((await service.getOpenQueue(recipient, { since: BASE })).windowCount).toBe(3);

    // A bound the server cannot read narrows nothing: every row here is still the
    // caller's, and "nothing" would read as a quiet queue.
    const unusable = ['not-a-date', '', '   ', new Date('nonsense')];
    await Promise.all(unusable.map(async (value) => {
      const queue = await service.getOpenQueue(recipient, { since: value });
      expect(queue.items.map((item) => item.id)).toEqual(UNNARROWED);
      expect(queue.windowCount).toBe(4);
    }));
  });
});
