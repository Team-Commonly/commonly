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

const ThreadUserState = require('../../../models/pg/ThreadUserState');

const POD = 'pod-1';
let root = 0;
const nextRoot = () => { root += 1; return root; };

beforeAll(async () => {
  await mockPool.query(`CREATE TABLE thread_user_state (
    id SERIAL PRIMARY KEY,
    thread_root_id INTEGER NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    pod_id VARCHAR(255) NOT NULL,
    following BOOLEAN,
    collapsed BOOLEAN NOT NULL DEFAULT TRUE,
    followed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (thread_root_id, user_id)
  )`);
});

const stateOf = async (r, u) => (await mockPool.query(
  'SELECT following, collapsed FROM thread_user_state WHERE thread_root_id = $1 AND user_id = $2', [r, u],
)).rows[0];

describe('participation creates the subscription', () => {
  test('a first-time participant starts following', async () => {
    const r = nextRoot();
    expect(await ThreadUserState.followByParticipation(r, 'u1', POD)).toBe(true);
    expect((await stateOf(r, 'u1')).following).toBe(true);
  });

  test('participating twice is idempotent', async () => {
    const r = nextRoot();
    await ThreadUserState.followByParticipation(r, 'u1', POD);
    expect(await ThreadUserState.followByParticipation(r, 'u1', POD)).toBe(true);
  });

  test('a row that exists only for collapse state gets followed, keeping its collapse', async () => {
    // The case the tri-state exists for: expanding a thread creates a row with
    // following NULL. Later participating must follow it WITHOUT resetting the
    // collapse the user chose.
    const r = nextRoot();
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
    const r = nextRoot();
    await ThreadUserState.unfollow(r, 'u1', POD);
    expect((await stateOf(r, 'u1')).following).toBe(false);

    expect(await ThreadUserState.followByParticipation(r, 'u1', POD)).toBe(false);
    expect((await stateOf(r, 'u1')).following).toBe(false);
  });

  test('and stays muted however many times they participate', async () => {
    const r = nextRoot();
    await ThreadUserState.unfollow(r, 'u1', POD);
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await ThreadUserState.followByParticipation(r, 'u1', POD);
    }
    expect((await stateOf(r, 'u1')).following).toBe(false);
  });

  test('an explicit follow after a mute DOES take — the header toggle still works', async () => {
    // Control. If mute were simply immovable, the bug would be the mirror one.
    const r = nextRoot();
    await ThreadUserState.unfollow(r, 'u1', POD);
    await ThreadUserState.follow(r, 'u1', POD);
    expect((await stateOf(r, 'u1')).following).toBe(true);
  });

  test('one user muting does not affect another user in the same thread', async () => {
    const r = nextRoot();
    await ThreadUserState.unfollow(r, 'u1', POD);
    await ThreadUserState.followByParticipation(r, 'u2', POD);
    expect((await stateOf(r, 'u1')).following).toBe(false);
    expect((await stateOf(r, 'u2')).following).toBe(true);
  });
});

describe('the wake set reads follow the same rule', () => {
  test('a muted participant is in mutedUserIds, never in explicitFollowerIds', async () => {
    const r = nextRoot();
    await ThreadUserState.unfollow(r, 'muted-user', POD);
    await ThreadUserState.followByParticipation(r, 'active-user', POD);

    expect(await ThreadUserState.explicitFollowerIds(r)).toEqual(['active-user']);
    expect(await ThreadUserState.mutedUserIds(r)).toEqual(['muted-user']);
  });

  test('a collapse-only row appears in neither — it has expressed nothing', async () => {
    // The reader rule ux-lead gave at 56820: filter on `following = true`,
    // never on EXISTS(row).
    const r = nextRoot();
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
    const r = nextRoot();
    await ThreadUserState.follow(r, 'u1', POD);
    await ThreadUserState.setCollapsed(r, 'u1', POD, false);
    const after = await stateOf(r, 'u1');
    expect(after.following).toBe(true);
    expect(after.collapsed).toBe(false);
  });

  test('collapsing does not disturb an explicit MUTE', async () => {
    // The worse half: a clobbered mute reads as consent to be woken.
    const r = nextRoot();
    await ThreadUserState.unfollow(r, 'u1', POD);
    await ThreadUserState.setCollapsed(r, 'u1', POD, false);
    expect((await stateOf(r, 'u1')).following).toBe(false);
  });

  test('follow state survives many collapse toggles — the frequency asymmetry', async () => {
    // collapsed flips per interaction; following is set once and expected to
    // last. If the two shared a write, the durable value erodes under the
    // volatile one, and it would take N toggles to notice rather than one.
    const r = nextRoot();
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
    const r = nextRoot();
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
    const r = nextRoot();
    await ThreadUserState.follow(r, 'u1', POD);
    expect((await stateOf(r, 'u1')).following).toBe(true);
    await ThreadUserState.setCollapsed(r, 'u1', POD, false);
    expect((await stateOf(r, 'u1')).collapsed).toBe(false);
    await ThreadUserState.unfollow(r, 'u1', POD);
    expect((await stateOf(r, 'u1')).following).toBe(false);
  });
});
