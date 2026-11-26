/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 step 2 for StalledConnectEpisode on real PostgreSQL: migration 0029
 * and its unique key, and a dual claim, nudge record, digest mark and close
 * through the real pgTableAdapter SQL, with racing claims taking the episode
 * once and verify finding both stores equal.
 */
const fs = require('fs');
const path = require('path');
const { Types } = require('mongoose');

const mockDb = { pool: null };
jest.mock('../../config/db-pg', () => ({
  pool: { query: (...args) => mockDb.pool.query(...args) },
}));

const { createRealPgSchema } = require('../utils/realPgSchema');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const Episode = require('../../models/StalledConnectEpisode');
const repo = require('../../repositories/stalledConnectEpisodeRepository');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../../config/migrations/0029_stalled_connect_episodes.sql'), 'utf8',
);
const ENV = 'STORE_MODE_STALLED_CONNECT_EPISODE';
const NOW = new Date('2026-11-20T12:00:00.000Z');

real('StalledConnectEpisode on real PostgreSQL (ADR-034 step 2)', () => {
  let database;

  beforeAll(async () => {
    await setupMongoDb();
    await Episode.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDb.pool = database.pool;
    await database.pool.query(MIGRATION);
    await Episode.deleteMany({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    delete process.env[ENV];
    jest.restoreAllMocks();
    if (database) await database.close();
  });

  it('0029 is a no-op on a second run, and (installation_id, token_issued_at) is unique', async () => {
    await database.pool.query(MIGRATION);
    const { rows } = await database.pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
        AND tablename = 'stalled_connect_episodes' ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'stalled_connect_episodes_installation_token', 'stalled_connect_episodes_installed_by_status',
      'stalled_connect_episodes_pkey', 'stalled_connect_episodes_status_nudged_at',
    ]);
    const insert = (id, installation, at) => database.pool.query(
      'INSERT INTO stalled_connect_episodes (id, installation_id, token_issued_at, pg_version) VALUES ($1, $2, $3, 1)',
      [id, installation, at],
    );
    await insert('a', 'inst', NOW);
    await expect(insert('b', 'inst', NOW)).rejects.toMatchObject({ code: '23505' });
    await insert('c', 'inst', new Date(NOW.getTime() + 1));
    await expect(insert('d', null, NOW)).rejects.toMatchObject({ code: '23502' });
  });

  it('dual: racing claims take one episode; nudge, mark and close copy; verify agrees', async () => {
    process.env[ENV] = 'dual';
    const fields = {
      installationId: new Types.ObjectId(), podId: String(new Types.ObjectId()), installedBy: new Types.ObjectId(),
      installerUsername: 'test-installer', agentName: 'test-agent', instanceId: 'default', displayName: 'Test Agent',
      tokenIssuedAt: new Date(NOW.getTime() - 3600000), tokenSource: null, producer: 'timer', nudgedAt: NOW,
      status: 'open',
    };
    const claims = await Promise.all(Array.from({ length: 6 }, () => repo.claimStalledConnectEpisode(fields)));
    const won = claims.filter(Boolean);
    expect(won).toHaveLength(1);
    const id = won[0]._id;
    await repo.recordNudgeMessage(id, '101');
    await repo.markStalledEpisodeDigested(id, { digestedAt: NOW });
    await repo.resolveStalledConnectEpisode(id, { status: 'resolved', resolvedAt: NOW, resolutionMessageId: '102' });

    const doc = await Episode.findById(id).lean();
    const { rows } = await database.pool.query('SELECT * FROM stalled_connect_episodes');
    expect(rows).toEqual([{
      id: String(id),
      installation_id: String(fields.installationId),
      pod_id: fields.podId,
      installed_by: String(fields.installedBy),
      installer_username: 'test-installer',
      agent_name: 'test-agent',
      instance_id: 'default',
      display_name: 'Test Agent',
      token_issued_at: fields.tokenIssuedAt,
      token_source: null,
      producer: 'timer',
      nudged_at: NOW,
      nudge_message_id: '101',
      resolved_at: NOW,
      resolution_message_id: '102',
      digested_at: NOW,
      digested_again_at: null,
      status: 'resolved',
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
      pg_version: 4,
    }]);
    const verified = await repo.stalledConnectEpisodeStore().verify();
    expect(verified).toMatchObject({
      mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
    });
    expect(verified.checksumPg).toBe(verified.checksumMongo);
  });
});
