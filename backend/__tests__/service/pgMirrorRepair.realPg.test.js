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
const PGPod = require('../../models/pg/Pod');
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
  let repairModule;
  let AgentIdentityService;
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
  const run = (env = {}, extra = {}) => {
    const saved = process.env.PG_MIRROR_REPAIR_APPLY;
    if (env.apply) process.env.PG_MIRROR_REPAIR_APPLY = '1';
    else delete process.env.PG_MIRROR_REPAIR_APPLY;
    return runPgMirrorRepair({ logger, page, ...extra }).finally(() => {
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
    repairModule = require('../../services/pgMirrorRepairService');
    ({ runPgMirrorRepair } = repairModule);
    // eslint-disable-next-line global-require -- loaded after the PG env is set, like the service above
    AgentIdentityService = require('../../services/agentIdentityService');
  });

  afterAll(async () => {
    await closePgDb();
    await closeMongoDb();
    const { pool: appPool } = require('../../config/db-pg');
    if (appPool?.end) await appPool.end();
  });

  afterEach(() => jest.restoreAllMocks());

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

  it('alerts SRE on a created_by mismatch the previous run did not see', async () => {
    const report = await run();
    expect(report.alerts).toEqual(expect.arrayContaining([expect.stringMatching(/created_by/)]));
    expect(page).toHaveBeenCalledTimes(1);
    expect(page.mock.calls[0][0]).toMatch(/created_by mismatches=1 \(new=1\)/);
    expect(lines.some(([level, l]) => level === 'error' && l.startsWith('[pg-mirror-alert]'))).toBe(true);
  });

  // #3500 review: report-only nights would otherwise page for the same 39 pods
  // every night until someone turned apply on.
  it('does not page again for a created_by mismatch the previous run already reported', async () => {
    await run();
    page.mockClear();
    const report = await run();
    expect(report.counts.pods_created_by).toBe(1);
    expect(report.alerts.filter((a) => /created_by/.test(a))).toEqual([]);
    expect(page).not.toHaveBeenCalled();
  });

  it('pages for a new created_by mismatch even while an old one persists', async () => {
    await run();
    // podB is missing from PG in the fixture; a bypass writer adds it with the wrong owner.
    await pg.query(`INSERT INTO pods (id, name, description, type, created_by)
      VALUES ($1, 'Pod B', '', 'chat', $2) ON CONFLICT (id) DO NOTHING`, [String(podB._id), String(bob._id)]);
    page.mockClear();
    const report = await run();
    expect(report.counts.pods_created_by).toBe(2);
    expect(page).toHaveBeenCalledWith(expect.stringMatching(/created_by mismatches=2 \(new=1\)/));
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

  // #3500 review: a repeat means a repair landed and the drift came back. A
  // key the previous run tried and failed to fix is still the same drift.
  it('does not call it a repeat when the previous run failed to repair that key', async () => {
    const id = (x) => String(x._id);
    const realAdd = PGPod.addMember.bind(PGPod);
    jest.spyOn(PGPod, 'addMember').mockImplementation((podId, userId) => (
      podId === id(podA) && userId === id(alice) ? Promise.reject(new Error('pg hiccup')) : realAdd(podId, userId)));
    const first = await run({ apply: true });
    expect(first.counts.repairs_failed).toBe(1);
    PGPod.addMember.mockRestore();
    const report = await run({ apply: true });
    expect(report.counts.members_missing).toBe(1);
    expect(report.repeats).toEqual([]);
  });

  // A value PG cannot hold (pods.name is VARCHAR(100)) is reported in its own
  // category: it is not a failed repair, and not a repeat the next night.
  it('reports a value PG cannot hold as unrepairable, not as a failure or a repeat', async () => {
    const long = 'L'.repeat(101);
    await Pod.updateOne({ _id: podA._id }, { $set: { name: long } });
    const first = await run({ apply: true });
    expect(first.counts.unrepairable).toBe(1);
    expect(first.counts.repairs_failed).toBe(0);
    expect((await pg.query('SELECT name FROM pods WHERE id = $1', [String(podA._id)])).rows[0].name).toBe('Old A');
    expect(lines.some(([, l]) => l.includes(`unrepairable pods id=${String(podA._id)} field=name`))).toBe(true);
    const second = await run({ apply: true });
    expect(second.counts.unrepairable).toBe(1);
    expect(second.repeats).toEqual([]);
  });

  // #3500 review (HIGH): the users loop works from a snapshot. An account
  // deleted after it is taken has its PG row anonymized ("Deleted user", no
  // picture) and its Mongo row removed; re-syncing from the stale snapshot
  // would put the real name back.
  it('does not re-sync a user deleted after the snapshot, so the tombstone stays', async () => {
    const id = (x) => String(x._id);
    const realFind = User.find.bind(User);
    jest.spyOn(User, 'find').mockImplementationOnce(() => ({
      select: async (fields) => {
        const docs = await realFind({}).select(fields);
        await pg.query("UPDATE users SET username = 'Deleted user', profile_picture = NULL WHERE _id = $1", [id(alice)]);
        await User.deleteOne({ _id: alice._id });
        return docs;
      },
    }));
    const report = await run({ apply: true });
    const row = (await pg.query('SELECT username, profile_picture FROM users WHERE _id = $1', [id(alice)])).rows[0];
    expect(row).toEqual({ username: 'Deleted user', profile_picture: null });
    expect(report.counts.repairs_failed).toBe(0);
  });

  // Each user guard alone: Mongo deleted after the snapshot, PG not yet
  // anonymized. Syncing the snapshot would insert a row for a gone account.
  it('does not write a user that left Mongo after the snapshot', async () => {
    const id = (x) => String(x._id);
    const realFind = User.find.bind(User);
    jest.spyOn(User, 'find').mockImplementationOnce(() => ({
      select: async (fields) => {
        const docs = await realFind({}).select(fields);
        await User.deleteOne({ _id: bob._id });
        return docs;
      },
    }));
    const report = await run({ apply: true });
    expect((await pg.query('SELECT _id FROM users WHERE _id = $1', [id(bob)])).rows).toEqual([]);
    expect(report.counts.repairs_failed).toBe(0);
  });

  it('syncs the label Mongo holds at write time, not the snapshot\'s', async () => {
    const id = (x) => String(x._id);
    const realFind = User.find.bind(User);
    jest.spyOn(User, 'find').mockImplementationOnce(() => ({
      select: async (fields) => {
        const docs = await realFind({}).select(fields);
        await User.updateOne({ _id: alice._id }, { $set: { displayName: 'Alice Now' } });
        return docs;
      },
    }));
    await run({ apply: true });
    expect((await pg.query('SELECT username FROM users WHERE _id = $1', [id(alice)])).rows[0].username).toBe('Alice Now');
  });

  // PG anonymized after the snapshot while the Mongo row still exists (the
  // deletion flow's own order): the in-loop PG re-read is the only guard.
  it('does not overwrite a tombstone written after the snapshot', async () => {
    const id = (x) => String(x._id);
    const realFindById = User.findById.bind(User);
    jest.spyOn(User, 'findById').mockImplementation((userId) => {
      const query = realFindById(userId);
      if (String(userId) !== id(alice)) return query;
      return {
        select: async (fields) => {
          const doc = await query.select(fields);
          await pg.query("UPDATE users SET username = 'Deleted user', profile_picture = NULL WHERE _id = $1", [id(alice)]);
          return doc;
        },
      };
    });
    await run({ apply: true });
    const row = (await pg.query('SELECT username, profile_picture FROM users WHERE _id = $1', [id(alice)])).rows[0];
    expect(row).toEqual({ username: 'Deleted user', profile_picture: null });
  });

  it('never overwrites a tombstone row, even while the Mongo user still exists', async () => {
    const id = (x) => String(x._id);
    // accountDeletionService anonymizes PG before it deletes the Mongo row.
    await pg.query("UPDATE users SET username = 'Deleted user', profile_picture = NULL WHERE _id = $1", [id(alice)]);
    const reported = await run();
    expect(reported.counts.users_deleting).toBe(1);
    expect(reported.counts.users_username).toBe(0);
    await run({ apply: true });
    const row = (await pg.query('SELECT username, profile_picture FROM users WHERE _id = $1', [id(alice)])).rows[0];
    expect(row).toEqual({ username: 'Deleted user', profile_picture: null });
  });

  // #3500 review (HIGH): a rename between the Mongo snapshot and the PG read
  // lands in both stores; the stale snapshot must not revert it.
  it('does not revert a pod renamed after the Mongo snapshot', async () => {
    const id = (x) => String(x._id);
    const stale = await Pod.find({}).select('_id name description type createdBy members').lean();
    await Pod.updateOne({ _id: podA._id }, { $set: { name: 'Renamed' } });
    await pg.query("UPDATE pods SET name = 'Renamed' WHERE id = $1", [id(podA)]);
    jest.spyOn(Pod, 'find').mockImplementationOnce(() => ({ select: () => ({ lean: async () => stale }) }));
    const report = await run({ apply: true });
    expect((await pg.query('SELECT name FROM pods WHERE id = $1', [id(podA)])).rows[0].name).toBe('Renamed');
    expect(report.counts.repairs_failed).toBe(0);
    // the other drifted fields on the same pod are still repaired
    expect((await pg.query('SELECT created_by FROM pods WHERE id = $1', [id(podA)])).rows[0].created_by).toBe(id(owner));
  });

  // CodeRabbit on #3500: syncPodFromMongo settles member inserts and never
  // throws for one, so a missing pod's repair must check its members landed.
  it('counts a member insert that failed while repairing a missing pod', async () => {
    const id = (x) => String(x._id);
    const realAdd = PGPod.addMember.bind(PGPod);
    jest.spyOn(PGPod, 'addMember').mockImplementation((podId, userId) => (
      podId === id(podB) && userId === id(bob) ? Promise.reject(new Error('pg hiccup')) : realAdd(podId, userId)));
    const report = await run({ apply: true });
    expect(report.counts.repairs_failed).toBe(1);
    expect(lines.some(([, l]) => l.includes(`repair failed pod_members pod=${id(podB)} user=${id(bob)}`))).toBe(true);
  });

  // #3500 review (LOW): a mass of ghosts means the classifier or Mongo is
  // wrong, not that a fifth of all memberships went stale overnight.
  it('deletes no ghost and pages when more than 20% of pod_members rows classify as ghosts', async () => {
    const id = (x) => String(x._id);
    const values = Array.from({ length: 12 }, (_, i) => `('${id(podA)}', '${String(i).padStart(24, 'd')}')`);
    await pg.query(`INSERT INTO pod_members (pod_id, user_id) VALUES ${values.join(', ')}`);
    const before = (await pg.query('SELECT count(*)::int n FROM pod_members')).rows[0].n;
    const report = await run({ apply: true });
    expect(report.counts.members_ghost).toBe(13);
    // podB's members were added; no row was deleted
    const after = (await pg.query('SELECT count(*)::int n FROM pod_members WHERE pod_id <> $1', [id(podB)])).rows[0].n;
    expect(after).toBe(before + 1);
    expect(report.alerts).toEqual(expect.arrayContaining([expect.stringMatching(/ghost deletes refused/)]));
    expect(page).toHaveBeenCalledWith(expect.stringMatching(/ghost deletes refused/));
  });

  // #3500 review (LOW) + CodeRabbit: a failure before the run row exists (the
  // previous-run read, the run-row insert, the lock) used to escape silently.
  it('logs an alert and pages when the run fails before it starts, then rethrows', async () => {
    await pg.query('ALTER TABLE pg_mirror_repair_runs RENAME TO pg_mirror_repair_runs_away');
    try {
      await expect(run({ apply: true })).rejects.toThrow(/pg_mirror_repair_runs/);
      expect(lines.some(([level, l]) => level === 'error' && l.startsWith('[pg-mirror-alert]'))).toBe(true);
      expect(page).toHaveBeenCalledWith(expect.stringMatching(/failed/));
    } finally {
      await pg.query('ALTER TABLE pg_mirror_repair_runs_away RENAME TO pg_mirror_repair_runs');
    }
  });

  // CodeRabbit on #3500: the classifier judged each ghost at the start of the
  // run. A user who joins in between has a real membership by delete time.
  it('does not delete a ghost row whose user joined the pod in Mongo after the classifier read', async () => {
    const id = (x) => String(x._id);
    const realFind = Pod.findById.bind(Pod);
    let classified = false;
    let joined = false;
    jest.spyOn(Pod, 'findById').mockImplementation((podId) => {
      if (String(podId) !== id(podA)) return realFind(podId);
      if ((new Error().stack || '').includes('podMemberClassifier')) {
        classified = true;
        return realFind(podId);
      }
      // The first read of podA after the classifier judged it: bob joins in Mongo now.
      if (classified && !joined) {
        joined = true;
        const join = () => Pod.updateOne({ _id: podA._id }, { $addToSet: { members: bob._id } });
        return {
          select: (f) => ({ lean: async () => { await join(); return realFind(podId).select(f).lean(); } }),
          lean: async () => { await join(); return realFind(podId).lean(); },
        };
      }
      return realFind(podId);
    });
    const report = await run({ apply: true });
    expect(report.counts.members_ghost).toBe(1);
    const { rows } = await pg.query('SELECT 1 FROM pod_members WHERE pod_id = $1 AND user_id = $2', [id(podA), id(bob)]);
    expect(rows).toHaveLength(1);
    expect(lines.some(([, l]) => l.includes(`skip pod_members pod=${id(podA)} user=${id(bob)} delete`))).toBe(true);
  });

  // CodeRabbit on #3500: a missing pod with an over-limit value would fail its
  // insert and count as a failed repair; it is unrepairable, like a drifted one.
  it('counts a missing pod whose name PG cannot hold as unrepairable and does not try to insert it', async () => {
    const id = (x) => String(x._id);
    await Pod.updateOne({ _id: podB._id }, { $set: { name: 'N'.repeat(101) } });
    const report = await run({ apply: true });
    expect(report.counts.unrepairable).toBe(1);
    expect(report.counts.repairs_failed).toBe(0);
    expect(report.counts.pods_missing).toBe(0);
    expect((await pg.query('SELECT 1 FROM pods WHERE id = $1', [id(podB)])).rows).toEqual([]);
    expect(lines.some(([, l]) => l.includes(`unrepairable pods id=${id(podB)} field=name`))).toBe(true);
  });

  it('checks the limits on what Mongo holds at insert time, not on the snapshot', async () => {
    const id = (x) => String(x._id);
    const stale = await Pod.find({}).select('_id name description type createdBy members').lean();
    await Pod.updateOne({ _id: podB._id }, { $set: { name: 'N'.repeat(101) } });
    jest.spyOn(Pod, 'find').mockImplementationOnce(() => ({ select: () => ({ lean: async () => stale }) }));
    const report = await run({ apply: true });
    expect(report.counts.unrepairable).toBe(1);
    expect(report.counts.repairs_failed).toBe(0);
    expect((await pg.query('SELECT 1 FROM pods WHERE id = $1', [id(podB)])).rows).toEqual([]);
  });

  // F191 (Opus re-review Low): the PG re-check and the sync's UPDATE are two
  // statements. The repair's write itself refuses to touch a tombstone.
  it('syncUserToPostgreSQL with keepTombstone leaves a tombstone row, and without it keeps today\'s overwrite', async () => {
    const id = (x) => String(x._id);
    const tomb = () => pg.query("UPDATE users SET username = 'Deleted user', profile_picture = NULL WHERE _id = $1", [id(owner)]);
    const row = async () => (await pg.query('SELECT username FROM users WHERE _id = $1', [id(owner)])).rows[0].username;
    await tomb();
    await expect(AgentIdentityService.syncUserToPostgreSQL(owner, { keepTombstone: true })).resolves.toBe(true);
    expect(await row()).toBe('Deleted user');
    await expect(AgentIdentityService.syncUserToPostgreSQL(owner)).resolves.toBe(true);
    expect(await row()).toBe('owner');
  });

  it('the repair\'s user sync is the tombstone-safe write', async () => {
    const spy = jest.spyOn(AgentIdentityService, 'syncUserToPostgreSQL');
    await run({ apply: true });
    expect(spy).toHaveBeenCalled();
    spy.mock.calls.forEach((call) => expect(call[1]).toEqual({ keepTombstone: true }));
  });

  // F191: a hung SRE page must not hold the advisory lock.
  it('gives up on a hung SRE page after the page timeout and releases the lock', async () => {
    const hung = jest.fn(() => new Promise(() => {}));
    const report = await run({}, { page: hung, pageTimeoutMs: 50 });
    expect(hung).toHaveBeenCalled();
    expect(report.alerts.length).toBeGreaterThan(0);
    expect(lines.some(([, l]) => l.includes('SRE page failed') && l.includes('timed out'))).toBe(true);
    expect((await run()).skipped).toBeUndefined();
  });

  it('pages with a 10 s timeout by default', () => {
    expect(repairModule.PAGE_TIMEOUT_MS).toBe(10000);
  });

  // F191: stored keys are capped. A created_by key cut from the stored list
  // would read as "new" the next night and page again.
  it('never cuts a created_by key from the stored list', () => {
    const { selectStoredKeys } = repairModule;
    const keys = ['pods:a:name', 'pods:b:name', 'pods:c:name', 'pods:x:created_by', 'pods:y:created_by'];
    const stored = selectStoredKeys(keys, 3);
    expect(stored).toEqual(expect.arrayContaining(['pods:x:created_by', 'pods:y:created_by']));
    expect(stored).toHaveLength(3);
    expect(selectStoredKeys(['pods:x:created_by', 'pods:y:created_by'], 1)).toHaveLength(2);
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
