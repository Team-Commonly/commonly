/**
 * F610 — a pod file's reference lookup counts only references that can grant.
 *
 * For a pod-scoped file (File.podId set), a post or chat message referencing
 * it grants a read only while the reference's author is the file's uploader or
 * a current member of the file's pod (#4290). The lookup reads a bounded window
 * of references per store. That window must be filled with references that
 * could grant, not with whichever references come first, or references from
 * authors who don't qualify push the one real reference out of the window and
 * a legitimate viewer loses access.
 *
 * Real MongoMemoryServer for User/Post/Pod/File; pg-mem for the messages
 * table, so the SQL's WHERE and LIMIT run for real. pg-mem's DISTINCT does not
 * keep insertion order, so the case that needs the eligible message to sit
 * past the window uses an insertion-ordered double of the same table.
 */
const mongoose = require('mongoose');

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

jest.mock('../../config/db-pg', () => {
  // eslint-disable-next-line global-require
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  const real = new Pool();
  // Delegates to pg-mem; one case swaps in an insertion-ordered table double.
  return { pool: { real, query: jest.fn((...args) => real.query(...args)) } };
});

const { pool } = require('../../config/db-pg');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Post = require('../../models/Post');
const File = require('../../models/File');
const { canReadAttachment } = require('../../services/attachmentAccess');

// More refused references than the per-store window holds.
const FLOOD = 21;

describe('F610: the reference window holds only references that can grant a pod file', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      pod_id VARCHAR(24) NOT NULL,
      user_id VARCHAR(24) NOT NULL,
      content TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
    await pool.query('DELETE FROM messages');
    jest.restoreAllMocks();
    pool.query.mockReset();
    pool.query.mockImplementation((...args) => pool.real.query(...args));
  });

  let seq = 0;
  async function makeUser() {
    seq += 1;
    const tag = `${seq}-${Math.random().toString(36).slice(2, 8)}`;
    return User.create({
      username: `f610-${tag}`,
      email: `f610-${tag}@test.com`,
      password: 'Password123!',
    });
  }

  // File F lives in private pod P, uploaded by `owner`; `member` is in P;
  // `viewer` is outside P; `outsiders` are outside P and never uploaded F.
  async function seed(fileName) {
    const owner = await makeUser();
    const member = await makeUser();
    const viewer = await makeUser();
    const outsiders = [await makeUser(), await makeUser(), await makeUser()];
    const pod = await Pod.create({
      name: 'private', type: 'chat', createdBy: owner._id, members: [owner._id, member._id],
    });
    await File.create({
      fileName,
      originalName: fileName,
      contentType: 'image/png',
      size: 10,
      uploadedBy: owner._id,
      podId: pod._id,
    });
    return { owner, member, viewer, outsiders, pod };
  }

  async function floodPosts(outsiders, fileName, n = FLOOD) {
    for (let i = 0; i < n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Post.create({
        userId: outsiders[i % outsiders.length]._id,
        content: `ref ${i} /api/uploads/${fileName}`,
      });
    }
  }

  const insertMessage = (podId, userId, content) => pool.query(
    'INSERT INTO messages (pod_id, user_id, content) VALUES ($1, $2, $3)',
    [String(podId), String(userId), content],
  );

  async function floodMessages(outsiders, podId, fileName, n = FLOOD) {
    // Distinct (pod_id, user_id) pairs, so DISTINCT can't fold them together.
    for (let i = 0; i < n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await insertMessage(podId, new mongoose.Types.ObjectId(), `ref ${i} /api/uploads/${fileName}`);
    }
    for (const o of outsiders) {
      // eslint-disable-next-line no-await-in-loop
      await insertMessage(podId, o._id, `x /api/uploads/${fileName}`);
    }
  }

  it('grants through an eligible public post that comes after more than a window of refused posts', async () => {
    const fileName = 'f610-1-pod.png';
    const { member, viewer, outsiders } = await seed(fileName);
    await floodPosts(outsiders, fileName);
    await Post.create({ userId: member._id, content: `real /api/uploads/${fileName}` });

    await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(true);
  });

  // Insertion-ordered stand-in for `messages`: evaluates the reference query
  // shape the service sends (ILIKE needle, optional `user_id = ANY($n)`,
  // DISTINCT (pod_id, user_id), LIMIT as the last parameter) in row order, so
  // the window position of each row is fixed.
  function orderedMessagesDouble(rows) {
    return async (sql, params = []) => {
      if (!/FROM messages/i.test(sql)) return { rows: [] };
      const needle = String(params[0]).replace(/^%|%$/g, '').toLowerCase();
      const anyMatch = /user_id\s*=\s*ANY\(\$(\d+)/i.exec(sql);
      const allowed = anyMatch ? new Set(params[Number(anyMatch[1]) - 1].map(String)) : null;
      const podMatch = /pod_id\s*=\s*ANY\(\$(\d+)/i.exec(sql);
      const pods = podMatch ? new Set(params[Number(podMatch[1]) - 1].map(String)) : null;
      const limit = params[params.length - 1];
      const seen = new Set();
      const out = [];
      for (const r of rows) {
        if (!r.content.toLowerCase().includes(needle)) continue;
        if (allowed && !allowed.has(r.user_id)) continue;
        if (pods && !pods.has(r.pod_id)) continue;
        const key = `${r.pod_id}:${r.user_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ pod_id: r.pod_id, user_id: r.user_id });
        if (out.length >= limit) break;
      }
      return { rows: out };
    };
  }

  it('grants through an eligible PG message that comes after more than a window of refused messages', async () => {
    const fileName = 'f610-2-pod.png';
    const { member, viewer, outsiders } = await seed(fileName);
    const shared = await Pod.create({
      name: 'shared', type: 'chat', createdBy: member._id, members: [member._id, viewer._id],
    });
    const rows = [];
    for (let i = 0; i < FLOOD; i += 1) {
      rows.push({
        pod_id: String(shared._id),
        // A few real outside accounts, the rest fresh ids: distinct pairs.
        user_id: String(i < outsiders.length ? outsiders[i]._id : new mongoose.Types.ObjectId()),
        content: `ref ${i} /api/uploads/${fileName}`,
      });
    }
    rows.push({ pod_id: String(shared._id), user_id: String(member._id), content: `real /api/uploads/${fileName}` });
    pool.query.mockImplementation(orderedMessagesDouble(rows));

    await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(true);
  });

  it('grants through an eligible PG message on the real SQL engine', async () => {
    const fileName = 'f610-8-pod.png';
    const { member, viewer, outsiders } = await seed(fileName);
    const shared = await Pod.create({
      name: 'shared', type: 'chat', createdBy: member._id, members: [member._id, viewer._id],
    });
    await floodMessages(outsiders, shared._id, fileName);
    await insertMessage(shared._id, member._id, `real /api/uploads/${fileName}`);

    await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(true);
  });

  it("keeps the uploader's own late reference granting behind a flood, after the uploader leaves", async () => {
    const fileName = 'f610-3-pod.png';
    const { owner, viewer, outsiders, pod } = await seed(fileName);
    await floodPosts(outsiders, fileName);
    await Post.create({ userId: owner._id, content: `real /api/uploads/${fileName}` });
    await Pod.updateOne({ _id: pod._id }, { $pull: { members: owner._id } });

    await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(true);
  });

  it('still refuses when only refused references exist, however many, in both stores', async () => {
    const fileName = 'f610-4-pod.png';
    const { viewer, outsiders } = await seed(fileName);
    const viewerPod = await Pod.create({
      name: 'viewer-pod',
      type: 'chat',
      createdBy: viewer._id,
      members: [viewer._id, ...outsiders.map((o) => o._id)],
    });
    await floodPosts(outsiders, fileName, 45);
    await floodMessages(outsiders, viewerPod._id, fileName, 45);

    await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(false);
    for (const o of outsiders) {
      // eslint-disable-next-line no-await-in-loop
      await expect(canReadAttachment(fileName, String(o._id))).resolves.toBe(false);
    }
  });

  it('stops granting through a late reference once its author leaves the pod', async () => {
    const fileName = 'f610-5-pod.png';
    const { member, viewer, outsiders, pod } = await seed(fileName);
    await floodPosts(outsiders, fileName);
    await Post.create({ userId: member._id, content: `real /api/uploads/${fileName}` });
    await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(true);

    await Pod.updateOne({ _id: pod._id }, { $pull: { members: member._id } });

    await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(false);
  });

  it('grants through a single eligible reference with nothing else present', async () => {
    const fileName = 'f610-6-pod.png';
    const { member, viewer } = await seed(fileName);
    await Post.create({ userId: member._id, content: `only /api/uploads/${fileName}` });

    await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(true);
  });

  it('reads one bounded window from each store, whatever the number of references', async () => {
    const fileName = 'f610-7-pod.png';
    const { viewer, outsiders, pod } = await seed(fileName);
    // A pod of the viewer's own, so the message store is queried at all (F618).
    await Pod.create({ name: 'viewer-own', type: 'chat', createdBy: viewer._id, members: [viewer._id] });
    await floodPosts(outsiders, fileName, 30);
    await floodMessages(outsiders, pod._id, fileName, 30);
    const findSpy = jest.spyOn(Post, 'find');
    const querySpy = jest.spyOn(pool, 'query');

    await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(false);

    expect(findSpy).toHaveBeenCalledTimes(1);
    const { limit } = findSpy.mock.results[0].value.getOptions();
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(20);

    const refCalls = querySpy.mock.calls.filter(([sql]) => /FROM messages/i.test(sql));
    expect(refCalls).toHaveLength(1);
    expect(refCalls[0][0]).toMatch(/LIMIT \$\d/);
    const params = refCalls[0][1];
    expect(params[params.length - 1]).toBeLessThanOrEqual(20);
  });

  // F618: an eligible author (a current member of the file's pod) can write
  // any number of references in pods the viewer can't read. Those must not
  // fill the window either: it holds only references THIS viewer can see.
  describe("F618: the window holds only references the viewer can see", () => {
    async function memberPods(member, n) {
      const pods = [];
      for (let i = 0; i < n; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        pods.push(await Pod.create({
          name: `hidden-${i}`, type: 'chat', createdBy: member._id, members: [member._id],
        }));
      }
      return pods;
    }

    it("grants through a post in the viewer's pod behind a window of the member's posts in hidden pods", async () => {
      const fileName = 'f618-1-pod.png';
      const { member, viewer } = await seed(fileName);
      const hidden = await memberPods(member, FLOOD);
      for (const p of hidden) {
        // eslint-disable-next-line no-await-in-loop
        await Post.create({ userId: member._id, podId: p._id, content: `hidden /api/uploads/${fileName}` });
      }
      const shared = await Pod.create({
        name: 'shared', type: 'chat', createdBy: member._id, members: [member._id, viewer._id],
      });
      await Post.create({ userId: member._id, podId: shared._id, content: `real /api/uploads/${fileName}` });

      await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(true);
    });

    it("grants through a message in the viewer's pod behind a window of hidden-pod messages", async () => {
      const fileName = 'f618-2-pod.png';
      const { member, viewer } = await seed(fileName);
      const hidden = await memberPods(member, FLOOD);
      const shared = await Pod.create({
        name: 'shared', type: 'chat', createdBy: member._id, members: [member._id, viewer._id],
      });
      const rows = hidden.map((p) => ({
        pod_id: String(p._id), user_id: String(member._id), content: `hidden /api/uploads/${fileName}`,
      }));
      rows.push({ pod_id: String(shared._id), user_id: String(member._id), content: `real /api/uploads/${fileName}` });
      pool.query.mockImplementation(orderedMessagesDouble(rows));

      await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(true);
    });

    it("grants through the viewer's pod message on the real SQL engine", async () => {
      const fileName = 'f618-3-pod.png';
      const { member, viewer } = await seed(fileName);
      const hidden = await memberPods(member, FLOOD);
      for (const p of hidden) {
        // eslint-disable-next-line no-await-in-loop
        await insertMessage(p._id, member._id, `hidden /api/uploads/${fileName}`);
      }
      const shared = await Pod.create({
        name: 'shared', type: 'chat', createdBy: member._id, members: [member._id, viewer._id],
      });
      await insertMessage(shared._id, member._id, `real /api/uploads/${fileName}`);

      await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(true);
    });

    it("still grants a non-member through a member's public post behind hidden-pod posts", async () => {
      const fileName = 'f618-4-pod.png';
      const { member, viewer } = await seed(fileName);
      const hidden = await memberPods(member, FLOOD);
      for (const p of hidden) {
        // eslint-disable-next-line no-await-in-loop
        await Post.create({ userId: member._id, podId: p._id, content: `hidden /api/uploads/${fileName}` });
      }
      await Post.create({ userId: member._id, content: `public /api/uploads/${fileName}` });

      await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(true);
    });

    it('refuses a viewer in no pods with no public reference, without a PG query', async () => {
      const fileName = 'f618-5-pod.png';
      const { member, viewer, pod } = await seed(fileName);
      const hidden = await memberPods(member, 3);
      for (const p of hidden) {
        // eslint-disable-next-line no-await-in-loop
        await Post.create({ userId: member._id, podId: p._id, content: `hidden /api/uploads/${fileName}` });
        // eslint-disable-next-line no-await-in-loop
        await insertMessage(p._id, member._id, `hidden /api/uploads/${fileName}`);
      }
      await insertMessage(pod._id, member._id, `in file pod /api/uploads/${fileName}`);
      pool.query.mockClear();

      await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(false);
      expect(pool.query.mock.calls.filter(([sql]) => /FROM messages/i.test(sql))).toHaveLength(0);
    });

    it("puts the viewer's pods into both reference queries", async () => {
      const fileName = 'f618-6-pod.png';
      const { member, viewer } = await seed(fileName);
      const shared = await Pod.create({
        name: 'shared', type: 'chat', createdBy: member._id, members: [member._id, viewer._id],
      });
      const findSpy = jest.spyOn(Post, 'find');
      pool.query.mockClear();

      await expect(canReadAttachment(fileName, String(viewer._id))).resolves.toBe(false);

      const filter = JSON.stringify(findSpy.mock.calls[0][0]);
      expect(filter).toContain(String(shared._id));
      const [sql, params] = pool.query.mock.calls.find(([q]) => /FROM messages/i.test(q));
      const m = /pod_id = ANY\(\$(\d+)::text\[\]\)/.exec(sql);
      expect(m).not.toBeNull();
      expect(params[Number(m[1]) - 1]).toEqual([String(shared._id)]);
    });
  });
});
