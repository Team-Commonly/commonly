/**
 * Follow-by-participation, EXECUTED on pg-mem (W-T, TASK-029, 2/4).
 *
 * 55854, relayed by @sprint-review (56791): "implicit by participation, one
 * explicit override. Posting in a thread follows it; being mentioned in it
 * follows it; the toggle lives on the thread header only — never per-reply."
 * And: a mention in an unfollowed thread auto-follows the target.
 *
 * Composed with ux-lead's tri-state (56822) — FALSE is an explicit mute that
 * outranks participation — that ruling has an edge it does not name. Taken
 * literally, "auto-follow the target" would flip an explicit FALSE to TRUE and
 * silently revoke a mute. Muting a thread and then being mentioned in it is
 * the ordinary case, not an exotic one.
 *
 * These execute against pg-mem rather than grepping the SQL, because the whole
 * claim is about what the conditional upsert DOES.
 */

const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const { createTableFor } = require('../../utils/schemaTable');
const ThreadUserState = require('../../../models/pg/ThreadUserState');

const POD = 'pod-1';
let root = 0;

// Every root must be a REAL message row now. The hand-written fixture declared
// `thread_root_id INTEGER NOT NULL` with no REFERENCES, so it silently dropped
// the foreign key the shipped schema has — and the tests were happily keying
// state to message ids that do not exist. Building from schema.sql surfaced it.
const nextRoot = async () => {
  root += 1;
  await mockPool.query(
    'INSERT INTO messages (id, pod_id, user_id, content) VALUES ($1, $2, $3, $4)',
    [root, POD, 'author', 'root message'],
  );
  return root;
};

beforeAll(async () => {
  // Built from the SHIPPED schema.sql, not hand-written here (@sprint-review
  // 56811). A constraint typed into a fixture proves the fixture has it; only
  // the shipped DDL makes ON CONFLICT below evidence about production.
  // `messages` first — thread_user_state's FK references it.
  // The real dependency chain. thread_user_state -> messages -> pods, and the
  // hand-written fixture had none of it — another thing building from the
  // shipped DDL surfaces rather than hides.
  await mockPool.query(createTableFor('pods'));
  await mockPool.query(createTableFor('messages'));
  await mockPool.query(createTableFor('thread_user_state'));
  await mockPool.query("INSERT INTO pods (id, name, type, created_by) VALUES ($1,'p','chat','u')", [POD]);
});

const stateOf = async (r, u) => (await mockPool.query(
  'SELECT following, collapsed FROM thread_user_state WHERE thread_root_id = $1 AND user_id = $2', [r, u],
)).rows[0];

describe('participation creates the subscription', () => {
  test('a first-time participant starts following', async () => {
    const r = await nextRoot();
    expect(await ThreadUserState.followByParticipation(r, 'u1', POD)).toBe(true);
    expect((await stateOf(r, 'u1')).following).toBe(true);
  });

  test('participating twice is idempotent', async () => {
    const r = await nextRoot();
    await ThreadUserState.followByParticipation(r, 'u1', POD);
    expect(await ThreadUserState.followByParticipation(r, 'u1', POD)).toBe(true);
  });

  test('a row that exists only for collapse state gets followed, keeping its collapse', async () => {
    // The case the tri-state exists for: expanding a thread creates a row with
    // following NULL. Later participating must follow it WITHOUT resetting the
    // collapse the user chose.
    const r = await nextRoot();
    await ThreadUserState.setCollapsed(r, 'u1', POD, false);
    expect((await stateOf(r, 'u1')).following).toBeNull();

    await ThreadUserState.followByParticipation(r, 'u1', POD);
    const after = await stateOf(r, 'u1');
    expect(after.following).toBe(true);
    expect(after.collapsed).toBe(false);
  });
});

describe('participation NEVER revokes an explicit mute', () => {
  test('a muted thread stays muted when the user is mentioned in it', async () => {
    // THE case. "Auto-follow the target" read literally un-mutes here, and the
    // user never asked for that.
    const r = await nextRoot();
    await ThreadUserState.unfollow(r, 'u1', POD);
    expect((await stateOf(r, 'u1')).following).toBe(false);

    expect(await ThreadUserState.followByParticipation(r, 'u1', POD)).toBe(false);
    expect((await stateOf(r, 'u1')).following).toBe(false);
  });

  test('and stays muted however many times they participate', async () => {
    const r = await nextRoot();
    await ThreadUserState.unfollow(r, 'u1', POD);
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await ThreadUserState.followByParticipation(r, 'u1', POD);
    }
    expect((await stateOf(r, 'u1')).following).toBe(false);
  });

  test('an explicit follow after a mute DOES take — the header toggle still works', async () => {
    // Control. If mute were simply immovable, the bug would be the mirror one.
    const r = await nextRoot();
    await ThreadUserState.unfollow(r, 'u1', POD);
    await ThreadUserState.follow(r, 'u1', POD);
    expect((await stateOf(r, 'u1')).following).toBe(true);
  });

  test('one user muting does not affect another user in the same thread', async () => {
    const r = await nextRoot();
    await ThreadUserState.unfollow(r, 'u1', POD);
    await ThreadUserState.followByParticipation(r, 'u2', POD);
    expect((await stateOf(r, 'u1')).following).toBe(false);
    expect((await stateOf(r, 'u2')).following).toBe(true);
  });
});

describe('the wake set reads follow the same rule', () => {
  test('a muted participant is in mutedUserIds, never in explicitFollowerIds', async () => {
    const r = await nextRoot();
    await ThreadUserState.unfollow(r, 'muted-user', POD);
    await ThreadUserState.followByParticipation(r, 'active-user', POD);

    expect(await ThreadUserState.explicitFollowerIds(r)).toEqual(['active-user']);
    expect(await ThreadUserState.mutedUserIds(r)).toEqual(['muted-user']);
  });

  test('a collapse-only row appears in neither — it has expressed nothing', async () => {
    // The reader rule ux-lead gave at 56820: filter on `following = true`,
    // never on EXISTS(row).
    const r = await nextRoot();
    await ThreadUserState.setCollapsed(r, 'browser', POD, false);
    expect(await ThreadUserState.explicitFollowerIds(r)).toEqual([]);
    expect(await ThreadUserState.mutedUserIds(r)).toEqual([]);
  });
});

describe('one record, but never one write for two meanings', () => {
  // @sprint-review (56807): the mirror of the risk ux-lead closed. Ruling out
  // "two writes for one gesture" invites "one write for two meanings" —
  // `following` is durable, `collapsed` flips constantly, and a collapse
  // toggle that upserts the whole record would silently rewrite follow state.
  //
  // The suite already had the collapse-then-follow direction. It did NOT have
  // the direction they actually named, which is the dangerous one, because
  // collapse is the high-frequency writer.

  test('collapsing does not disturb an explicit follow', async () => {
    const r = await nextRoot();
    await ThreadUserState.follow(r, 'u1', POD);
    await ThreadUserState.setCollapsed(r, 'u1', POD, false);
    const after = await stateOf(r, 'u1');
    expect(after.following).toBe(true);
    expect(after.collapsed).toBe(false);
  });

  test('collapsing does not disturb an explicit MUTE', async () => {
    // The worse half: a clobbered mute reads as consent to be woken.
    const r = await nextRoot();
    await ThreadUserState.unfollow(r, 'u1', POD);
    await ThreadUserState.setCollapsed(r, 'u1', POD, false);
    expect((await stateOf(r, 'u1')).following).toBe(false);
  });

  test('follow state survives many collapse toggles — the frequency asymmetry', async () => {
    // collapsed flips per interaction; following is set once and expected to
    // last. If the two shared a write, the durable value erodes under the
    // volatile one, and it would take N toggles to notice rather than one.
    const r = await nextRoot();
    await ThreadUserState.unfollow(r, 'u1', POD);
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await ThreadUserState.setCollapsed(r, 'u1', POD, i % 2 === 0);
    }
    const after = await stateOf(r, 'u1');
    expect(after.following).toBe(false);
    expect(after.collapsed).toBe(false);
  });

  test('and collapse state survives repeated follow/unfollow', async () => {
    const r = await nextRoot();
    await ThreadUserState.setCollapsed(r, 'u1', POD, false);
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await ThreadUserState.follow(r, 'u1', POD);
      // eslint-disable-next-line no-await-in-loop
      await ThreadUserState.unfollow(r, 'u1', POD);
    }
    expect((await stateOf(r, 'u1')).collapsed).toBe(false);
  });

  test('CONTROL: each writer DOES change its own column', async () => {
    // Otherwise the four tests above would pass from a model that writes
    // nothing at all.
    const r = await nextRoot();
    await ThreadUserState.follow(r, 'u1', POD);
    expect((await stateOf(r, 'u1')).following).toBe(true);
    await ThreadUserState.setCollapsed(r, 'u1', POD, false);
    expect((await stateOf(r, 'u1')).collapsed).toBe(false);
    await ThreadUserState.unfollow(r, 'u1', POD);
    expect((await stateOf(r, 'u1')).following).toBe(false);
  });
});

describe('the constraints are the SHIPPED ones, enforced', () => {
  // @sprint-review (56811): "a UNIQUE constraint present in schema.sql and one
  // the database enforces are different claims — only the second is worth a
  // test." These build their table from schema.sql, so a constraint deleted
  // there breaks them.

  test('the unique on (root, user) is enforced, not merely declared', async () => {
    const r = await nextRoot();
    await ThreadUserState.follow(r, 'u1', POD);
    await expect(mockPool.query(
      'INSERT INTO thread_user_state (thread_root_id, user_id, pod_id) VALUES ($1,$2,$3)',
      [r, 'u1', POD],
    )).rejects.toThrow();
  });

  test('but two different users on one thread are fine', async () => {
    // The control. A unique on thread_root_id alone would make following a
    // claim, and this is what distinguishes the two.
    const r = await nextRoot();
    await ThreadUserState.follow(r, 'u1', POD);
    await ThreadUserState.follow(r, 'u2', POD);
    expect((await ThreadUserState.explicitFollowerIds(r)).sort()).toEqual(['u1', 'u2']);
  });

  test('the FK to messages is enforced — state cannot key to a phantom root', async () => {
    // The hand-written fixture had `thread_root_id INTEGER NOT NULL` with no
    // REFERENCES, so every test in this file used to key state to message ids
    // that did not exist and nothing objected.
    await expect(ThreadUserState.follow(987654, 'u1', POD)).rejects.toThrow();
  });

  test('deleting the root CASCADEs the state away', async () => {
    // ON DELETE CASCADE from the shipped DDL. A follow on a deleted thread is
    // not a thing, and leaving orphans would slowly poison the wake set.
    const r = await nextRoot();
    await ThreadUserState.follow(r, 'u1', POD);
    await mockPool.query('DELETE FROM messages WHERE id = $1', [r]);
    const { rows } = await mockPool.query(
      'SELECT * FROM thread_user_state WHERE thread_root_id = $1', [r],
    );
    expect(rows).toHaveLength(0);
  });

  test('collapsed defaults TRUE from the shipped DDL, not from a fixture', async () => {
    const r = await nextRoot();
    await ThreadUserState.follow(r, 'u1', POD);
    expect((await stateOf(r, 'u1')).collapsed).toBe(true);
  });
});
