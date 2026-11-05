/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * F183: the nightly PG mirror repair, on real PostgreSQL and real MongoDB.
 *
 * Mongo is the source of truth for pods, pod_members and users; PG holds
 * mirrors. On 2026-11-05 production showed 860 drifted rows, 39 of them a
 * wrong `pods.created_by`. The job repairs Mongo → PG only, never deletes a PG
 * pod or user Mongo lacks, and records each run in pg_mirror_repair_runs.
 * Advisory locks, CAS updates and jsonb are engine behaviour, so pg-mem is not
 * evidence here.
 */
const { Pool } = require('pg');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const {
  setupMongoDb, closeMongoDb, clearMongoDb, setupPgDb, closePgDb,
} = require('../utils/testUtils');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;

const TABLE_SNAPSHOT = [
  'SELECT id, name, description, type, created_by FROM pods ORDER BY id',
  'SELECT pod_id, user_id FROM pod_members ORDER BY pod_id, user_id',
  'SELECT _id, username, profile_picture, is_bot FROM users ORDER BY _id',
];
const ORPHAN_POD = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORPHAN_USER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const TOMBSTONE_USER = 'cccccccccccccccccccccccc';

real('pgMirrorRepairService on real PostgreSQL and MongoDB', () => {
  let pg;
  let runPgMirrorRepair;
  let owner;
  let alice;
  let bob;
  let bot;
  let podA;
  let podB;
  let lines;
  let logger;
  let page;

  const snapshot = async () => Promise.all(TABLE_SNAPSHOT.map(async (sql) => (await pg.query(sql)).rows));
  const run = (env = {}) => {
    const saved = process.env.PG_MIRROR_REPAIR_APPLY;
    if (env.apply) process.env.PG_MIRROR_REPAIR_APPLY = '1';
    else delete process.env.PG_MIRROR_REPAIR_APPLY;
    return runPgMirrorRepair({ logger, page }).finally(() => {
      if (saved === undefined) delete process.env.PG_MIRROR_REPAIR_APPLY;
      else process.env.PG_MIRROR_REPAIR_APPLY = saved;
    });
  };
  const person = (name, over = {}) => User.create({
    username: name, email: `${name}@test.invalid`, password: 'Password123!', verified: true, ...over,
  });

  beforeAll(async () => {
    await setupMongoDb();
    pg = await setupPgDb();
    ({ runPgMirrorRepair } = require('../../services/pgMirrorRepairService'));
  });

  afterAll(async () => {
    await closePgDb();
    await closeMongoDb();
    const { pool: appPool } = require('../../config/db-pg');
    if (appPool?.end) await appPool.end();
  });

  beforeEach(async () => {
    await clearMongoDb();
    await pg.query('TRUNCATE TABLE messages, pod_members, pods, users, pg_mirror_repair_runs RESTART IDENTITY CASCADE');
    lines = [];
    logger = {
      info: (l) => lines.push(['info', l]),
      warn: (l) => lines.push(['warn', l]),
      error: (l) => lines.push(['error', l]),
    };
    page = jest.fn().mockResolvedValue(undefined);

    owner = await person('owner');
    alice = await person('alice');
    bob = await person('bob');
    bot = await person('scout-lab', {
      isBot: true, botType: 'agent', botMetadata: { agentName: 'scout', instanceId: 'lab', displayName: 'Scout (Lab)' },
    });
    podA = await Pod.create({
      name: 'Pod A', description: 'about A', type: 'chat', createdBy: owner._id, members: [owner._id, alice._id],
    });
    podB = await Pod.create({ name: 'Pod B', type: 'chat', createdBy: owner._id, members: [owner._id, bob._id] });

    const id = (x) => String(x._id);
    // users: owner correct; alice stale label; bob missing; bot is_bot wrong;
    // one orphan and one deleted-account tombstone with no Mongo row.
    await pg.query(`INSERT INTO users (_id, username, profile_picture, is_bot) VALUES
      ($1, 'owner', 'default', false), ($2, 'alice-old', 'default', false),
      ($3, 'Scout (Lab)', 'default', false), ($4, 'leftover', NULL, false),
      ($5, 'Deleted user', NULL, false)`, [id(owner), id(alice), id(bot), ORPHAN_USER, TOMBSTONE_USER]);
    // pod A: every field drifted, alice missing, bob a ghost. Pod B absent.
    await pg.query(`INSERT INTO pods (id, name, description, type, created_by)
      VALUES ($1, 'Old A', 'stale', 'team', $2)`, [id(podA), id(alice)]);
    await pg.query('INSERT INTO pod_members (pod_id, user_id) VALUES ($1, $2), ($1, $3)', [id(podA), id(owner), id(bob)]);
    // A PG-only pod that holds messages: reported, never deleted.
    await pg.query(`INSERT INTO pods (id, name, description, type, created_by)
      VALUES ($1, 'Gone', '', 'chat', $2)`, [ORPHAN_POD, id(owner)]);
    await pg.query('INSERT INTO pod_members (pod_id, user_id) VALUES ($1, $2)', [ORPHAN_POD, id(owner)]);
    await pg.query(`INSERT INTO messages (pod_id, user_id, content) VALUES ($1, $2, 'one'), ($1, $2, 'two')`,
      [ORPHAN_POD, id(owner)]);
  });

  const EXPECTED_DRIFT = {
    pods_missing: 1,
    pods_name: 1,
    pods_description: 1,
    pods_type: 1,
    pods_created_by: 1,
    pods_orphan: 1,
    members_missing: 1,
    members_ghost: 1,
    members_orphan_pod: 1,
    users_missing: 1,
    users_username: 1,
    users_is_bot: 1,
    users_orphan: 1,
    users_tombstone: 1,
  };

  it('report-only by default: counts every category and changes nothing', async () => {
    const before = await snapshot();
    const report = await run();
    expect(report.applied).toBe(false);
    expect(report.counts).toEqual(expect.objectContaining(EXPECTED_DRIFT));
    expect(await snapshot()).toEqual(before);
    expect(report.orphanPods).toEqual([{ id: ORPHAN_POD, messages: 2 }]);
    const row = (await pg.query('SELECT applied, counts, unexplained, finished_at, error FROM pg_mirror_repair_runs')).rows;
    expect(row).toHaveLength(1);
    expect(row[0]).toEqual(expect.objectContaining({ applied: false, error: null }));
    expect(row[0].finished_at).not.toBeNull();
    expect(row[0].counts).toEqual(expect.objectContaining(EXPECTED_DRIFT));
    // orphan pod + non-tombstone orphan user
    expect(row[0].unexplained).toBe(2);
  });

  it('repairs every category when PG_MIRROR_REPAIR_APPLY=1, and a second pass finds only the orphans', async () => {
    const report = await run({ apply: true });
    expect(report.applied).toBe(true);
    expect(report.counts.repairs_failed).toBe(0);

    const id = (x) => String(x._id);
    const pods = (await pg.query('SELECT id, name, description, type, created_by FROM pods ORDER BY id')).rows;
    expect(pods.find((p) => p.id === id(podA))).toEqual({
      id: id(podA), name: 'Pod A', description: 'about A', type: 'chat', created_by: id(owner),
    });
    expect(pods.find((p) => p.id === id(podB))).toEqual(expect.objectContaining({ created_by: id(owner), name: 'Pod B' }));
    const members = (await pg.query('SELECT pod_id, user_id FROM pod_members')).rows
      .map((r) => `${r.pod_id}:${r.user_id}`).sort();
    expect(members).toEqual([
      `${id(podA)}:${id(alice)}`, `${id(podA)}:${id(owner)}`,
      `${id(podB)}:${id(bob)}`, `${id(podB)}:${id(owner)}`,
      `${ORPHAN_POD}:${id(owner)}`,
    ].sort());
    const users = Object.fromEntries((await pg.query('SELECT _id, username, is_bot FROM users')).rows
      .map((u) => [u._id, u]));
    expect(users[id(alice)].username).toBe('alice');
    expect(users[id(bob)]).toEqual(expect.objectContaining({ username: 'bob', is_bot: false }));
    expect(users[id(bot)].is_bot).toBe(true);

    // Never deleted: the PG-only pod with its messages, the orphan user, the tombstone.
    expect((await pg.query('SELECT count(*)::int n FROM messages WHERE pod_id = $1', [ORPHAN_POD])).rows[0].n).toBe(2);
    expect(users[ORPHAN_USER]).toBeDefined();
    expect(users[TOMBSTONE_USER]).toBeDefined();

    const second = await run({ apply: true });
    const nonzero = Object.fromEntries(Object.entries(second.counts).filter(([, n]) => n > 0));
    expect(nonzero).toEqual({
      pods_orphan: 1, members_orphan_pod: 1, users_orphan: 1, users_tombstone: 1,
    });
  });

  it('logs the before-value of every field it changes, one line per repair, with ids and no emails', async () => {
    await run({ apply: true });
    const repairs = lines.filter(([, l]) => l.startsWith('[pg-mirror-repair] repair ')).map(([, l]) => l);
    const id = (x) => String(x._id);
    expect(repairs).toEqual(expect.arrayContaining([
      expect.stringContaining(`pods id=${id(podA)} field=created_by before="${id(alice)}" after="${id(owner)}"`),
      expect.stringContaining(`pods id=${id(podA)} field=name before="Old A" after="Pod A"`),
      expect.stringContaining(`pods id=${id(podA)} field=type before="team" after="chat"`),
      expect.stringContaining(`pods id=${id(podA)} field=description before="stale"`),
      expect.stringContaining(`pods id=${id(podB)} field=row before=absent`),
      expect.stringContaining(`pod_members pod=${id(podA)} user=${id(alice)} field=row before=absent`),
      expect.stringContaining(`pod_members pod=${id(podA)} user=${id(bob)} field=row before=present`),
      expect.stringContaining(`users id=${id(bob)} field=row before=absent`),
      expect.stringContaining(`users id=${id(alice)} field=username before=sha256:`),
      expect.stringContaining(`users id=${id(bot)} field=is_bot before=false after=true`),
    ]));
    expect(lines.every(([, l]) => !/@test\.invalid/.test(l))).toBe(true);
    // the label itself is fingerprinted, not printed
    expect(repairs.some((l) => l.includes('alice-old'))).toBe(false);
  });

  it('alerts SRE on any created_by mismatch, repaired or not', async () => {
    const report = await run();
    expect(report.alerts).toEqual(expect.arrayContaining([expect.stringMatching(/created_by/)]));
    expect(page).toHaveBeenCalledTimes(1);
    expect(page.mock.calls[0][0]).toMatch(/created_by mismatches=1/);
    expect(lines.some(([level, l]) => level === 'error' && l.startsWith('[pg-mirror-alert]'))).toBe(true);
  });

  it('raises no alert on a run with nothing alarming', async () => {
    await run({ apply: true });
    page.mockClear();
    lines = [];
    const report = await run({ apply: true });
    expect(report.alerts).toEqual([]);
    expect(page).not.toHaveBeenCalled();
    expect(lines.some(([, l]) => l.startsWith('[pg-mirror-alert]'))).toBe(false);
  });

  // Counts are drift as observed before repair, so a clean baseline night is
  // the second applied run, not the first.
  it('alerts when a category grows by more than 20 against the previous run', async () => {
    await run({ apply: true });
    await run({ apply: true });
    for (let i = 0; i < 21; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await person(`burst-${i}`);
    }
    page.mockClear();
    const report = await run();
    expect(report.counts.users_missing).toBe(21);
    expect(report.alerts).toEqual(expect.arrayContaining([expect.stringMatching(/users_missing \+21/)]));
    expect(page).toHaveBeenCalledWith(expect.stringMatching(/users_missing \+21/));
  });

  it('does not alert on a jump of exactly 20', async () => {
    await run({ apply: true });
    await run({ apply: true });
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await person(`burst-${i}`);
    }
    const report = await run();
    expect(report.alerts.filter((a) => /users_missing/.test(a))).toEqual([]);
  });

  it('flags the same id and field drifting again the night after an applied repair as unexplained', async () => {
    await run({ apply: true });
    // A bypass writer puts the old name back.
    await pg.query("UPDATE pods SET name = 'Old A' WHERE id = $1", [String(podA._id)]);
    const report = await run({ apply: true });
    expect(report.repeats).toEqual([`pods:${String(podA._id)}:name`]);
    // orphan pod + orphan user + the repeat
    expect(report.unexplained).toBe(3);
    expect(lines.some(([level, l]) => level === 'error' && l.includes('repeat') && l.includes(String(podA._id)))).toBe(true);
  });

  it('does not call it a repeat when the previous run only reported', async () => {
    await run();
    const report = await run();
    expect(report.repeats).toEqual([]);
  });

  it('refuses to start while another run holds the advisory lock', async () => {
    const other = new Pool({
      host: process.env.PG_HOST,
      port: Number(process.env.PG_PORT || 5432),
      database: process.env.PG_DATABASE,
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      ssl: false,
    });
    const client = await other.connect();
    try {
      const { LOCK_KEYS } = require('../../services/pgMirrorRepairService');
      await client.query('SELECT pg_advisory_lock($1::integer, $2::integer)', LOCK_KEYS);
      const before = await snapshot();
      const report = await run({ apply: true });
      expect(report.skipped).toBe('locked');
      expect(await snapshot()).toEqual(before);
      expect((await pg.query('SELECT count(*)::int n FROM pg_mirror_repair_runs')).rows[0].n).toBe(0);
    } finally {
      await client.query('SELECT pg_advisory_unlock_all()');
      client.release();
      await other.end();
    }
    // and runs once the lock is free
    expect((await run()).skipped).toBeUndefined();
  });
});
