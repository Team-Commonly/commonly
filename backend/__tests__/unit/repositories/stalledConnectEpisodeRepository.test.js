/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// ADR-034 step 2 for stalled-connect episodes. The repository's Postgres table
// is the in-memory adapter here; Mongo is real, so racing claims meet the
// production unique index on (installationId, tokenIssuedAt).
const mockPg = { current: null, options: null };
jest.mock('../../../repositories/dualStore', () => {
  const actual = jest.requireActual('../../../repositories/dualStore');
  const forward = (method) => (...args) => mockPg.current[method](...args);
  return {
    ...actual,
    pgTableAdapter: (options) => {
      mockPg.options = options;
      return Object.fromEntries(['upsert', 'remove', 'replace', 'removeAt', 'get', 'scan', 'findWhere']
        .map((m) => [m, forward(m)]));
    },
  };
});
const fs = require('fs');
const path = require('path');
const { Types } = require('mongoose');
const Episode = require('../../../models/StalledConnectEpisode');
const repo = require('../../../repositories/stalledConnectEpisodeRepository');
const { episodeReferenceQuery, EPISODE_MESSAGE_FIELDS } = require('../../../scripts/backfill-message-author-kind');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_STALLED_CONNECT_EPISODE';
const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-11-20T12:00:00.000Z');
const ago = (hours) => new Date(NOW.getTime() - hours * HOUR);

const insert = (over = {}) => ({
  installationId: new Types.ObjectId(),
  podId: String(new Types.ObjectId()),
  installedBy: new Types.ObjectId(),
  installerUsername: 'test-installer',
  agentName: 'test-agent',
  instanceId: 'default',
  displayName: 'Test Agent',
  tokenIssuedAt: ago(2),
  tokenSource: 'installation',
  producer: 'timer',
  nudgedAt: ago(1),
  status: 'open',
  ...over,
});

const STORE_FIELDS = ['_id', 'createdAt', 'updatedAt', 'pgVersion', 'pgPending', 'pgDeleted', 'installationId',
  'installedBy', 'podId'];
const payload = (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !STORE_FIELDS.includes(key)));
const sortById = (docs) => [...docs].map((doc) => ({ ...doc, _id: String(doc._id) }))
  .sort((a, b) => (a._id < b._id ? -1 : 1));

describe('stalled-connect episode repository (ADR-034 step 2)', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await Episode.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await Episode.deleteMany({});
    mockPg.current = fakePg();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[ENV] = 'dual';
    await repo.stalledConnectEpisodeStore().repair();
    delete process.env[ENV];
    mockPg.current.calls.length = 0;
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  const raw = (id) => Episode.findById(id).lean();
  const upserts = () => mockPg.current.calls.filter((call) => call === 'upsert').length;
  const verify = () => repo.stalledConnectEpisodeStore().verify();

  it('declares the table and names the columns 0029 creates, with the unique key', () => {
    repo.stalledConnectEpisodeStore();
    expect(mockPg.options).toMatchObject({ table: 'stalled_connect_episodes', idColumn: 'id' });
    const sql = fs.readFileSync(
      path.join(__dirname, '../../../config/migrations/0029_stalled_connect_episodes.sql'), 'utf8',
    );
    const created = [...sql.matchAll(/^\s+([a-z_]+) (?:TEXT|INTEGER|TIMESTAMPTZ)/gm)].map((m) => m[1]);
    expect([mockPg.options.idColumn, ...mockPg.options.columns, 'pg_version'].sort()).toEqual(created.sort());
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS \w+\s+ON stalled_connect_episodes \(installation_id, token_issued_at\);/,
    );
  });

  describe('mongo (the default)', () => {
    it('claims, refuses a duplicate, and makes no Postgres call', async () => {
      const fields = insert();
      const created = await repo.claimStalledConnectEpisode(fields);
      expect(created._id).toBeDefined();
      expect(await repo.claimStalledConnectEpisode({ ...fields, producer: 'reactive' })).toBeNull();
      await repo.recordNudgeMessage(created._id, 'msg-1');
      await repo.resolveStalledConnectEpisode(created._id, { status: 'resolved', resolvedAt: NOW });
      const doc = await raw(created._id);
      expect(doc).toMatchObject({ nudgeMessageId: 'msg-1', status: 'resolved', resolvedAt: NOW });
      expect(doc.pgVersion).toBeUndefined();
      expect(mockPg.current.calls).toEqual([]);
    });

    it('makes the pre-step-2 updateOne calls, filters and $sets as passed', async () => {
      const calls = [];
      jest.spyOn(Episode, 'updateOne').mockImplementation(async (...args) => { calls.push(args); });
      await repo.recordNudgeMessage('id1', 'm');
      await repo.resolveStalledConnectEpisode('id2', { status: 'resolved', resolvedAt: NOW });
      await repo.markStalledEpisodeDigested('id3', { digestedAt: NOW });
      expect(calls).toEqual([
        [{ _id: 'id1' }, { $set: { nudgeMessageId: 'm' } }],
        [{ _id: 'id2', status: 'open' }, { $set: { status: 'resolved', resolvedAt: NOW } }],
        [{ _id: 'id3', status: 'open' }, { $set: { digestedAt: NOW } }],
      ]);
    });

    it('passes through a claim error that is not a duplicate key', async () => {
      jest.spyOn(Episode, 'create').mockRejectedValueOnce(new Error('mongo down'));
      await expect(repo.claimStalledConnectEpisode(insert())).rejects.toThrow('mongo down');
    });
  });

  describe.each(['dual', 'pg-read'])('%s', (mode) => {
    it('every read returns what mongo mode returns, from Mongo, without touching Postgres', async () => {
      const installer = new Types.ObjectId();
      const seeds = [
        insert({ installedBy: installer, nudgeMessageId: 'm1', resolutionMessageId: '' }),
        insert({ installedBy: installer, nudgedAt: ago(30), digestedAt: ago(5) }),
        insert({ agentName: 'other-agent', nudgeMessageId: '' }),
        insert({ nudgedAt: ago(200), status: 'resolved', resolutionMessageId: '42' }),
      ];
      await Episode.insertMany(seeds);
      // A non-string id the script's $type filter skips.
      await Episode.collection.insertOne({ ...insert(), nudgeMessageId: 7 });
      const reads = () => Promise.all([
        repo.findExplainedEpisodes(['test-agent', 'other-agent']),
        repo.findOpenEpisodesPage(null, 2),
        repo.findDueStalledEpisodes(ago(24)),
        repo.findInstallerStalledEpisodes(installer, ago(0)),
        repo.findNewestOpenEpisodes(3),
        repo.findEpisodeMessageFields(episodeReferenceQuery(), EPISODE_MESSAGE_FIELDS),
      ]);
      const mongo = await reads();
      process.env[ENV] = mode;
      mockPg.current.calls.length = 0;
      const dual = await reads();
      // No Postgres call of any kind, not even a point read: every read stays on Mongo.
      expect(mockPg.current.calls).toEqual([]);
      // Order-insensitive where mongo mode's read has no sort, ordered where it does.
      [0, 2, 3, 5].forEach((i) => expect(sortById(dual[i])).toEqual(sortById(mongo[i])));
      expect(dual[1]).toEqual(mongo[1]);
      // Newest first; mongo mode leaves ties on nudgedAt unordered, dual breaks them by _id.
      expect(sortById(dual[4])).toEqual(sortById(mongo[4]));
      expect(dual[4].map((d) => d.nudgedAt.getTime())).toEqual(mongo[4].map((d) => d.nudgedAt.getTime()));
      expect(mongo.map((r) => r.length)).toEqual([2, 2, 1, 2, 3, 2]);
    });

    it('a read pages past MONGO_READ_PAGE and returns every match', async () => {
      const many = Array.from({ length: repo.MONGO_READ_PAGE + 3 }, () => insert({ nudgedAt: ago(30) }));
      await Episode.insertMany(many);
      process.env[ENV] = mode;
      const paging = jest.spyOn(repo.stalledConnectEpisodeStore(), 'findPageMongo');
      expect(await repo.findDueStalledEpisodes(ago(24))).toHaveLength(repo.MONGO_READ_PAGE + 3);
      // Bounded pages, each after the last _id of the one before.
      expect(repo.MONGO_READ_PAGE).toBe(500);
      expect(paging).toHaveBeenCalledTimes(2);
      const [[firstFilter, firstOptions], [secondFilter, secondOptions]] = paging.mock.calls;
      [firstOptions, secondOptions].forEach((options) => {
        expect(options).toMatchObject({ sort: { _id: 1 }, limit: repo.MONGO_READ_PAGE });
      });
      expect(JSON.stringify(firstFilter)).not.toMatch(/\$gt/);
      const firstPage = await paging.mock.results[0].value;
      expect(secondFilter.$and[1]).toEqual({ _id: { $gt: firstPage[firstPage.length - 1]._id } });
      expect((await paging.mock.results[1].value)).toHaveLength(3);
    });

    it('claims once under a race, copies the claim, and every change after it', async () => {
      process.env[ENV] = mode;
      const fields = insert();
      const claims = await Promise.all(Array.from({ length: 6 }, () => repo.claimStalledConnectEpisode(fields)));
      const won = claims.filter(Boolean);
      expect(won).toHaveLength(1);
      const id = won[0]._id;
      expect(upserts()).toBe(1);
      await repo.recordNudgeMessage(id, 'msg-1');
      await repo.markStalledEpisodeDigested(id, { digestedAt: NOW });
      await repo.markStalledEpisodeDigested(id, {});
      await repo.resolveStalledConnectEpisode(id, {
        status: 'resolved', resolvedAt: NOW, resolutionMessageId: 'msg-2',
      });
      // Closed: a second close and a late digest mark write nothing.
      await repo.resolveStalledConnectEpisode(id, { status: 'resolved', resolvedAt: ago(-1) });
      await repo.markStalledEpisodeDigested(id, { digestedAgainAt: NOW });
      const doc = await raw(id);
      expect(doc).toMatchObject({
        nudgeMessageId: 'msg-1', digestedAt: NOW, status: 'resolved', resolvedAt: NOW, resolutionMessageId: 'msg-2',
        pgVersion: 4,
      });
      expect(doc.digestedAgainAt).toBeUndefined();
      expect(doc.pgPending).toBeUndefined();
      expect(upserts()).toBe(4);
      expect(mockPg.current.rows.get(String(id))).toEqual({
        row: {
          id: String(id),
          installation_id: String(fields.installationId),
          pod_id: fields.podId,
          installed_by: String(fields.installedBy),
          installer_username: 'test-installer',
          agent_name: 'test-agent',
          instance_id: 'default',
          display_name: 'Test Agent',
          token_issued_at: fields.tokenIssuedAt,
          token_source: 'installation',
          producer: 'timer',
          nudged_at: fields.nudgedAt,
          nudge_message_id: 'msg-1',
          resolved_at: NOW,
          resolution_message_id: 'msg-2',
          digested_at: NOW,
          digested_again_at: null,
          status: 'resolved',
          created_at: doc.createdAt,
          updated_at: doc.updatedAt,
        },
        version: 4,
      });
      expect(await verify()).toMatchObject({
        mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
      });
    });

    it('writes the same document as mongo mode, updatedAt moving on each change', async () => {
      const run = async () => {
        const fields = insert();
        const created = await repo.claimStalledConnectEpisode(fields);
        const first = (await raw(created._id)).updatedAt;
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        await repo.recordNudgeMessage(created._id, 'msg-1');
        await repo.markStalledEpisodeDigested(created._id, { digestedAt: NOW });
        await repo.resolveStalledConnectEpisode(created._id, { status: 'resolved', resolvedAt: NOW });
        const doc = await raw(created._id);
        expect(doc.updatedAt.getTime()).toBeGreaterThan(first.getTime());
        return payload(doc);
      };
      const mongo = await run();
      process.env[ENV] = mode;
      expect(await run()).toEqual(mongo);
    });

    it('a failed copy still claims, with the marker for repair; a second claim is a duplicate', async () => {
      process.env[ENV] = mode;
      const fields = insert();
      mockPg.current.failNext('upsert');
      const created = await repo.claimStalledConnectEpisode(fields);
      expect(created).not.toBeNull();
      expect(await raw(created._id)).toMatchObject({ pgVersion: 1, pgPending: 1 });
      expect(await repo.claimStalledConnectEpisode(fields)).toBeNull();
      expect(await repo.stalledConnectEpisodeStore().repair()).toMatchObject({ copied: 1, failed: 0 });
      expect(await verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('backfill copies episodes written before dual, a sparse one with NULLs, and verify agrees', async () => {
      await repo.claimStalledConnectEpisode(insert());
      await Episode.collection.insertOne({
        installationId: new Types.ObjectId(), podId: 'p', installedBy: new Types.ObjectId(), agentName: 'a',
        tokenIssuedAt: ago(3), nudgedAt: ago(2),
      });
      process.env[ENV] = mode;
      const store = repo.stalledConnectEpisodeStore();
      expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 2, inserted: 2 });
      expect(await verify()).toMatchObject({
        mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
      });
    });
  });

  it('pg: every write and every read refuses until step 4, before any write', async () => {
    // A stored open episode, copied in dual, so it carries the store markers.
    process.env[ENV] = 'dual';
    const { _id: id } = await repo.claimStalledConnectEpisode(insert());
    const before = await raw(id);
    expect(before).toMatchObject({ status: 'open', pgVersion: 1 });
    process.env[ENV] = 'pg';
    mockPg.current.calls.length = 0;
    const refused = /not supported in pg mode until step 4/;
    const unchanged = async () => expect(await raw(id)).toEqual(before);
    await expect(repo.claimStalledConnectEpisode(insert())).rejects.toThrow(refused);
    await unchanged();
    await expect(repo.recordNudgeMessage(id, 'm')).rejects.toThrow(refused);
    await unchanged();
    await expect(repo.resolveStalledConnectEpisode(id, { status: 'resolved', resolvedAt: NOW }))
      .rejects.toThrow(refused);
    await unchanged();
    await expect(repo.markStalledEpisodeDigested(id, { digestedAt: NOW })).rejects.toThrow(refused);
    await unchanged();
    await expect(repo.markStalledEpisodeDigested(id, {})).rejects.toThrow(refused);
    await unchanged();
    await expect(repo.findExplainedEpisodes(['a'])).rejects.toThrow(refused);
    await expect(repo.findOpenEpisodesPage(null, 5)).rejects.toThrow(refused);
    await expect(repo.findDueStalledEpisodes(NOW)).rejects.toThrow(refused);
    await expect(repo.findInstallerStalledEpisodes(new Types.ObjectId(), NOW)).rejects.toThrow(refused);
    await expect(repo.findNewestOpenEpisodes(5)).rejects.toThrow(refused);
    await expect(repo.findEpisodeMessageFields(episodeReferenceQuery(), EPISODE_MESSAGE_FIELDS))
      .rejects.toThrow(refused);
    expect(await Episode.countDocuments({})).toBe(1);
    await unchanged();
    expect(mockPg.current.calls).toEqual([]);
  });
});
