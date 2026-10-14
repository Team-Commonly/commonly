// POST/DELETE /api/messages/:messageId/follow check the pod that owns the
// message (resolved server-side from the message row) with the shared pod
// write gate, for human callers (req.userId) and agent callers (req.agentUser)
// alike. The other thread-state suites stub that gate to `true` or assert on
// source text; this one executes the refusal path against real membership.
//
// pg-mem holds the message and thread-state rows; memory Mongo holds the pod,
// so podWriteAccessService runs unmocked.
const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const { createTableFor } = require('../../utils/schemaTable');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const { followThread, unfollowThread } = require('../../../controllers/threadStateController');

const ROOT_ID = 1;
const REPLY_ID = 2;

const call = async (handler, req) => {
  const out = { status: 200, body: undefined };
  const res = {
    status: (n) => { out.status = n; return res; },
    json: (d) => { out.body = d; },
  };
  await handler({ params: { messageId: String(REPLY_ID) }, query: {}, ...req }, res);
  return out;
};

const followingOf = async (userId) => {
  const { rows } = await mockPool.query(
    'SELECT following FROM thread_user_state WHERE thread_root_id = $1 AND user_id = $2',
    [ROOT_ID, String(userId)],
  );
  return rows.length ? rows[0].following : undefined;
};

describe('message thread follow checks the message\'s pod', () => {
  let member;
  let outsider;
  let memberBot;
  let outsiderBot;

  beforeAll(async () => {
    await setupMongoDb();
    await mockPool.query(createTableFor('pods'));
    await mockPool.query(createTableFor('messages'));
    await mockPool.query(createTableFor('thread_user_state'));
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
    await mockPool.query('DELETE FROM thread_user_state');
    await mockPool.query('DELETE FROM messages');
    await mockPool.query('DELETE FROM pods');

    member = await User.create({ username: 'member', email: 'member@example.com', password: 'placeholder' });
    outsider = await User.create({ username: 'outsider', email: 'outsider@example.com', password: 'placeholder' });
    const bot = (name) => User.create({
      username: `${name}-default`,
      email: `${name}@agent.local`,
      password: 'placeholder',
      isBot: true,
      botMetadata: { agentName: name, instanceId: 'default' },
    });
    memberBot = await bot('insider');
    outsiderBot = await bot('stranger');
    const pod = await Pod.create({
      name: 'Private', type: 'chat', createdBy: member._id, members: [member._id, memberBot._id],
    });

    const podId = String(pod._id);
    await mockPool.query(
      "INSERT INTO pods (id, name, type, created_by) VALUES ($1,'Private','chat',$2)",
      [podId, String(member._id)],
    );
    await mockPool.query(
      "INSERT INTO messages (id, pod_id, user_id, content) VALUES ($1,$2,$3,'root')",
      [ROOT_ID, podId, String(member._id)],
    );
    await mockPool.query(
      "INSERT INTO messages (id, pod_id, user_id, content, thread_root_id) VALUES ($1,$2,$3,'reply',$4)",
      [REPLY_ID, podId, String(member._id), ROOT_ID],
    );
  });

  it('lets a member follow from a reply, resolving the root', async () => {
    const out = await call(followThread, { userId: String(member._id) });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ threadRootId: ROOT_ID, following: true });
    expect(await followingOf(member._id)).toBe(true);
  });

  it('refuses a non-member with 403 and writes no row', async () => {
    const out = await call(followThread, { userId: String(outsider._id) });
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ msg: 'not a member of this pod' });
    expect(await followingOf(outsider._id)).toBeUndefined();
  });

  it('refuses a non-member\'s unfollow with 403 and leaves their row as it was', async () => {
    await mockPool.query(
      'INSERT INTO thread_user_state (thread_root_id, user_id, pod_id, following) VALUES ($1,$2,$3,true)',
      [ROOT_ID, String(outsider._id), 'stale-pod'],
    );
    const out = await call(unfollowThread, { userId: String(outsider._id) });
    expect(out.status).toBe(403);
    expect(await followingOf(outsider._id)).toBe(true);
  });

  it('lets a member unfollow', async () => {
    await call(followThread, { userId: String(member._id) });
    const out = await call(unfollowThread, { userId: String(member._id) });
    expect(out.status).toBe(200);
    expect(await followingOf(member._id)).toBe(false);
  });

  it('lets an agent in the pod follow, identified by req.agentUser', async () => {
    const out = await call(followThread, { agentUser: { _id: memberBot._id } });
    expect(out.status).toBe(200);
    expect(await followingOf(memberBot._id)).toBe(true);
  });

  it('refuses an agent outside the pod with 403', async () => {
    const out = await call(followThread, { agentUser: { _id: outsiderBot._id } });
    expect(out.status).toBe(403);
    expect(await followingOf(outsiderBot._id)).toBeUndefined();
  });
});
