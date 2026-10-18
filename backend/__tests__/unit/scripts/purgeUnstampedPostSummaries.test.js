/**
 * purge-unstamped-post-summaries removes exactly one class: a pod-less 'posts'
 * summary without the feed stamp whose window holds a pod post. The survivors
 * are the discriminating observation, so each neighbouring class is present.
 */
const mongoose = require('mongoose');

const Summary = require('../../../models/Summary');
const Post = require('../../../models/Post');
const { purge } = require('../../../scripts/purge-unstamped-post-summaries');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const HOUR = 60 * 60 * 1000;
const at = (h) => new Date(Date.UTC(2026, 9, 18, h));
const summary = (fields) => Summary.create({ title: 't', content: 'c', ...fields });

describe('purge-unstamped-post-summaries', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  afterEach(async () => { await clearMongoDb(); });

  test('deletes only unstamped pod-less posts summaries whose window holds a pod post', async () => {
    const userId = new mongoose.Types.ObjectId();
    const podId = new mongoose.Types.ObjectId();
    await Post.create({ userId, content: 'p', podId, createdAt: new Date(at(2).getTime() + 10 * 60 * 1000) });
    await Post.create({ userId, content: 'f', createdAt: new Date(at(5).getTime() + 10 * 60 * 1000) });
    const window = (h) => ({ start: at(h), end: new Date(at(h).getTime() + HOUR) });

    const target = await summary({ type: 'posts', timeRange: window(2), metadata: { totalItems: 1 } });
    const feedHour = await summary({ type: 'posts', timeRange: window(5), metadata: { totalItems: 1 } });
    const stamped = await summary({ type: 'posts', timeRange: window(2), metadata: { totalItems: 0, source: 'feed-posts' } });
    const podChats = await summary({ type: 'chats', podId, timeRange: window(2), metadata: { totalItems: 1 } });

    const dry = await purge({ apply: false });
    expect(dry).toMatchObject({ podless: 3, unstamped: 2, targets: [String(target._id)], deleted: 0 });
    expect(await Summary.countDocuments({})).toBe(4);

    const run = await purge({ apply: true });
    expect(run).toMatchObject({ podless: 3, deleted: 1, after: 2 });
    const left = (await Summary.find({}, { _id: 1 }).lean()).map((s) => String(s._id)).sort();
    expect(left).toEqual([feedHour, stamped, podChats].map((s) => String(s._id)).sort());

    const again = await purge({ apply: true });
    expect(again).toMatchObject({ targets: [], deleted: 0 });
  });
});
