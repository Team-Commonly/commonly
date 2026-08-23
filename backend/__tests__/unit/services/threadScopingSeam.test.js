/**
 * The one edge nothing read: does the id the WAKE PATH keys on match the id
 * the WRITER stored? (W-T, TASK-029, 3/4.)
 *
 * @sprint-review (57122): both existing suites are blind to this join.
 * `agentMentionService.threadScoping.test.js` mocks `threadWakeScopeService`
 * outright, so it never runs the real narrowing. `threadWakeScope.test.js`
 * runs the real narrowing but supplies its OWN `identify` — and that stand-in
 * is `(t) => t.installedBy`, which is the keying production stopped using
 * after it turned out `installedBy` is the human installer on half the write
 * paths. So the algebra is verified against a function embodying the exact
 * defect the production code was fixed for.
 *
 * Writer well tested. Narrowing well tested. Join untested, and one side's
 * test double still encodes the bug. That is review-checklist §7's phantom
 * cross-layer contract: each layer is correct against its own idea of the
 * other.
 *
 * This suite runs BOTH real halves against one pg-mem database:
 *   ThreadUserState.follow / unfollow / followByParticipation  (writer)
 *   effectiveFollowerIds + narrowToThread                      (reader)
 * with the keying function shaped like the production one — resolving a bot
 * User row id — rather than reaching for `installedBy`.
 */
const { newDb } = require('pg-mem');
const { applyTable } = require('../../utils/schemaTable');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const ThreadUserState = require('../../../models/pg/ThreadUserState');
const { narrowToThread } = require('../../../services/threadWakeScopeService');

const POD = 'pod-1';
// The two identity spaces the production bug confused. They must stay
// DIFFERENT here or this suite cannot discriminate a correct key either.
const SEAT = { agentName: 'seat-a', instanceId: 'default', installedBy: 'human-who-installed-it' };
const SEAT_BOT_USER = 'bot-user-a';
const OTHER = { agentName: 'seat-b', instanceId: 'default', installedBy: 'another-human' };
const OTHER_BOT_USER = 'bot-user-b';

// Production shape: map an install to its BOT's User row id. Never installedBy.
const botUserIds = new Map([
  ['seat-a:default', SEAT_BOT_USER],
  ['seat-b:default', OTHER_BOT_USER],
]);
const identify = (inst) => botUserIds.get(
  `${String(inst.agentName || '').toLowerCase()}:${String(inst.instanceId || 'default')}`,
) ?? null;

let root = 500;
const nextRoot = async () => {
  root += 1;
  await mockPool.query(
    "INSERT INTO messages (id, pod_id, user_id, content) VALUES ($1,$2,'someone','root')",
    [root, POD],
  );
  return root;
};

beforeAll(async () => {
  await applyTable(mockPool, 'pods');
  await applyTable(mockPool, 'users');
  await applyTable(mockPool, 'messages');
  await applyTable(mockPool, 'thread_user_state');
  await mockPool.query(
    "INSERT INTO pods (id, name, type, created_by) VALUES ($1,'P','chat','u')", [POD],
  );
});

describe('the writer and the wake path agree on the key', () => {
  test('a follow written under the BOT user id is honoured by the narrowing', async () => {
    const r = await nextRoot();
    await ThreadUserState.follow(r, SEAT_BOT_USER, POD);

    const kept = await narrowToThread(r, [SEAT, OTHER], identify);

    expect(kept).toEqual([SEAT]);
  });

  test('a mute written under the BOT user id removes that seat', async () => {
    const r = await nextRoot();
    await ThreadUserState.follow(r, SEAT_BOT_USER, POD);
    await ThreadUserState.follow(r, OTHER_BOT_USER, POD);
    await ThreadUserState.unfollow(r, SEAT_BOT_USER, POD);

    const kept = await narrowToThread(r, [SEAT, OTHER], identify);

    expect(kept).toEqual([OTHER]);
  });

  test('participation written by the mention path is honoured too', async () => {
    // followByParticipation is the write #1136 wired; it must key the same way.
    const r = await nextRoot();
    await ThreadUserState.followByParticipation(r, SEAT_BOT_USER, POD);

    const kept = await narrowToThread(r, [SEAT, OTHER], identify);

    expect(kept).toEqual([SEAT]);
  });

  test('THE JOIN: writing under installedBy does NOT reach the seat', async () => {
    // The discriminating case, and the reason this file exists. If the writer
    // and the reader disagreed about the key — which is exactly what shipped
    // before #1120's fix, and what threadWakeScope.test.js's local `identify`
    // still assumes — the row would be written somewhere the narrowing never
    // looks, and the seat would be silently dropped from its own thread.
    const r = await nextRoot();
    await ThreadUserState.follow(r, SEAT.installedBy, POD);

    const kept = await narrowToThread(r, [SEAT, OTHER], identify);

    expect(kept).toEqual([]);
    // And to be explicit about which direction the failure runs: the seat is
    // not merely un-followed, it is invisible to a thread it opted into.
    expect(kept).not.toContain(SEAT);
  });

  test('an unresolvable seat is KEPT, so a keying gap degrades to noise not silence', async () => {
    const r = await nextRoot();
    await ThreadUserState.follow(r, SEAT_BOT_USER, POD);
    const unknown = { agentName: 'seat-c', instanceId: 'default', installedBy: 'x' };

    const kept = await narrowToThread(r, [SEAT, unknown], identify);

    expect(kept).toEqual([SEAT, unknown]);
  });
});
