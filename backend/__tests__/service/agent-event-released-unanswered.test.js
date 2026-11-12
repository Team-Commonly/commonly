/**
 * F452. A stopping runner hands its held deliveries back to 'pending'
 * (POST /events/release, F189). Its ceiling is twice the requeue cap, so a row
 * past the cap can come back pending, and the TASK-656 pass reads only
 * 'delivered' rows. With the agent gone, nothing claims the row and the person
 * waits on silence until the 168h expiry. Now, once a row like that has gone
 * unclaimed for the requeue window:
 *   (1) past the cap, it is retired with the TASK-656 line;
 *   (2) below the cap, the person gets one "hasn't answered yet" line and the
 *       row stays pending, so an agent that comes back still answers.
 * One marker on the event, unansweredNoticeAt, means the person was told: no
 * row ever gets a second line. Real Mongo for the queue and users; pg-mem for
 * the messages table the line is written to.
 */
const { newDb } = require('pg-mem');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const pg = newDb();
pg.public.none(`CREATE TABLE messages (
  id SERIAL PRIMARY KEY, pod_id TEXT NOT NULL, user_id TEXT NOT NULL,
  content TEXT NOT NULL, message_type TEXT NOT NULL DEFAULT 'text', payload JSONB,
  thread_root_id INTEGER, reply_to_message_id INTEGER, top_level_answer BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);
const { Pool } = pg.adapters.createPg();
const mockPool = new Pool();
jest.mock('../../config/db-pg', () => ({ pool: mockPool }));
const mockEmit = jest.fn();
jest.mock('../../config/socket', () => ({ getIO: () => ({ to: () => ({ emit: mockEmit }) }) }));
jest.mock('../../services/agentProvisionerService', () => ({
  getAgentSessionSizes: jest.fn(),
  clearAgentRuntimeSessions: jest.fn(),
  restartAgentRuntime: jest.fn(),
  resolveOpenClawAccountId: jest.fn(() => 'acct'),
}));
jest.mock('../../services/nativeRuntimeService', () => ({ runAgent: jest.fn() }));

const User = require('../../models/User');
const AgentEvent = require('../../models/AgentEvent');
const AgentEventService = require('../../services/agentEventService');

const POD = new mongoose.Types.ObjectId();
const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);
let person;
let agent;

const lines = async () => (
  await mockPool.query("SELECT * FROM messages WHERE message_type = 'system' ORDER BY id")
).rows;
const collect = () => AgentEventService.garbageCollect({ requeueDeliveredMinutes: 10, requeueMaxAttempts: 3 });
const status = async (event) => (await AgentEvent.findById(event._id).lean()).status;

// A row the runner handed back: pending, claimed `attempts` times, no nonce,
// last written `idleMinutes` ago. updatedAt is set on the collection directly,
// since Mongoose would stamp it with now.
const released = async ({
  attempts, idleMinutes = 30, ageMinutes = idleMinutes + 5, ...overrides
} = {}) => {
  const event = await AgentEvent.create({
    agentName: 'otto',
    instanceId: 'default',
    podId: POD,
    type: 'chat.mention',
    status: 'pending',
    attempts,
    deliveredAt: null,
    deliveryNonce: null,
    releasedAt: minutesAgo(idleMinutes),
    payload: {
      messageId: '41', threadRootId: '40', userId: String(person._id), content: '@otto can you review this?',
    },
    ...overrides,
  });
  await AgentEvent.collection.updateOne(
    { _id: event._id },
    { $set: { updatedAt: minutesAgo(idleMinutes), createdAt: minutesAgo(ageMinutes) } },
  );
  return event;
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), AgentEvent.deleteMany({})]);
  await mockPool.query('DELETE FROM messages');
  mockEmit.mockClear();
  person = await User.create({ username: 'partner-person', email: 'partner@example.test', password: 'test-password' });
  agent = await User.create({
    username: 'otto',
    email: 'otto@agents.commonly.local',
    password: 'test-password',
    isBot: true,
    botMetadata: { agentName: 'otto', instanceId: 'default', displayName: 'Otto' },
  });
});

describe('(1) a released row past the cap, unclaimed for the window', () => {
  test('is retired, and the person gets the TASK-656 line once', async () => {
    const event = await released({ attempts: 4 });

    await collect();

    const saved = await AgentEvent.findById(event._id).lean();
    expect(saved.status).toBe('failed');
    expect(saved.error).toMatch(/requeue cap exhausted after 3/);
    const posted = await lines();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ user_id: String(agent._id), thread_root_id: 40, reply_to_message_id: 41 });
    expect(posted[0].content).toContain("Otto didn't answer this");
    expect(posted[0].payload).toMatchObject({ action: 'mention-unanswered', attempts: 4 });

    await collect();
    expect(await lines()).toHaveLength(1);
  });

  test('is left alone inside the window: a replacement runner may still claim it', async () => {
    const event = await released({ attempts: 4, idleMinutes: 5 });

    await collect();

    expect(await status(event)).toBe('pending');
    expect(await lines()).toHaveLength(0);
  });
});

describe('(2) a released row below the cap, unclaimed for the window', () => {
  test('stays pending, is marked, and the person is told once that it has not answered yet', async () => {
    const event = await released({ attempts: 2 });

    await collect();

    const saved = await AgentEvent.findById(event._id).lean();
    expect(saved.status).toBe('pending');
    expect(saved.unansweredNoticeAt).toBeInstanceOf(Date);
    const posted = await lines();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ user_id: String(agent._id), thread_root_id: 40, reply_to_message_id: 41 });
    // True whether or not the agent answers later.
    expect(posted[0].content).toContain("Otto hasn't answered this yet and may be offline");
    expect(posted[0].content).not.toMatch(/didn't answer|won't answer/);
    expect(posted[0].payload).toMatchObject({ action: 'mention-unanswered', stillPending: true });
  });

  test('posts once across repeated sweeps', async () => {
    const event = await released({ attempts: 1 });

    await collect();
    // Past another window with the row untouched since the notice.
    await AgentEvent.collection.updateOne({ _id: event._id }, { $set: { updatedAt: minutesAgo(30) } });
    await collect();
    await collect();

    expect(await status(event)).toBe('pending');
    expect(await lines()).toHaveLength(1);
  });

  test('an agent that comes back, claims and answers gets no second line', async () => {
    const event = await released({ attempts: 2 });
    await collect();
    expect(await lines()).toHaveLength(1);

    const [claimed] = await AgentEventService.list({ agentName: 'otto', instanceId: 'default' });
    expect(String(claimed._id)).toBe(String(event._id));
    await AgentEventService.acknowledge(
      String(event._id), 'otto', 'default', null, claimed.deliveryId || claimed.deliveryNonce,
    );
    await collect();

    expect(await status(event)).toBe('acked');
    expect(await lines()).toHaveLength(1);
  });

  test('a row that later crosses the cap is retired by (1) silently: never a second line', async () => {
    const event = await released({ attempts: 2 });
    await collect();
    expect(await lines()).toHaveLength(1);

    // The agent came back, claimed it again and stopped again past the cap.
    await AgentEvent.collection.updateOne(
      { _id: event._id },
      { $set: { attempts: 4, updatedAt: minutesAgo(30) } },
    );
    await collect();

    expect(await status(event)).toBe('failed');
    expect(await lines()).toHaveLength(1);
  });

  test('a marked row retired from delivered at the cap posts nothing new either', async () => {
    const event = await released({ attempts: 2 });
    await collect();
    expect(await lines()).toHaveLength(1);

    // Claimed again and never acked: the TASK-656 delivered pass retires it.
    await AgentEvent.collection.updateOne(
      { _id: event._id },
      { $set: { status: 'delivered', attempts: 3, deliveredAt: minutesAgo(30), deliveryNonce: 'n'.repeat(32) } },
    );
    await collect();

    expect(await status(event)).toBe('failed');
    expect(await lines()).toHaveLength(1);
  });

  test('a row reclaimed inside the window gets no line', async () => {
    const recent = await released({ attempts: 2, idleMinutes: 5 });
    const reclaimed = await released({ attempts: 2, payload: { messageId: '42', userId: String(person._id), content: '@otto again' } });
    // A replacement runner claims it before the sweep.
    await AgentEventService.list({ agentName: 'otto', instanceId: 'default' });

    await collect();

    expect(await status(recent)).not.toBe('failed');
    expect(['delivered', 'pending']).toContain(await status(reclaimed));
    expect((await AgentEvent.findById(recent._id).lean()).unansweredNoticeAt).toBeFalsy();
    expect((await AgentEvent.findById(reclaimed._id).lean()).unansweredNoticeAt).toBeFalsy();
    expect(await lines()).toHaveLength(0);
  });
});

describe('who never gets a line', () => {
  test('a first_contact, below or past the cap', async () => {
    const below = await released({ attempts: 2, type: 'first_contact' });
    const past = await released({ attempts: 4, type: 'first_contact' });

    await collect();

    expect(await status(below)).toBe('pending');
    expect(await status(past)).toBe('pending');
    expect(await lines()).toHaveLength(0);
  });

  test('a never-claimed row (attempts 0): the mention-time notices own that case', async () => {
    const event = await released({ attempts: 0 });

    await collect();

    expect(await status(event)).toBe('pending');
    expect((await AgentEvent.findById(event._id).lean()).unansweredNoticeAt).toBeFalsy();
    expect(await lines()).toHaveLength(0);
  });

  test('a kernel wake and an agent\'s own message: marked or retired, no line', async () => {
    const kernel = await released({
      attempts: 2,
      payload: { triggerAuthor: 'kernel', boardWake: true, userId: String(person._id), content: 'TASK-1 updated' },
    });
    const fromAgent = await released({
      attempts: 4,
      payload: { messageId: '42', userId: String(agent._id), content: '@otto gate this' },
    });

    await collect();

    expect(await status(kernel)).toBe('pending');
    expect(await lines()).toHaveLength(0);
    expect(await status(fromAgent)).toBe('failed');
  });

  test('a native turn queued for the runner lease holder', async () => {
    const event = await released({ attempts: 2, inProcessQueued: true });

    await collect();

    expect((await AgentEvent.findById(event._id).lean()).unansweredNoticeAt).toBeFalsy();
    expect(await lines()).toHaveLength(0);
  });

  test('a row the requeue sweep put back, not a release: a long turn may still answer it', async () => {
    const event = await released({ attempts: 2, releasedAt: null });

    await collect();

    expect((await AgentEvent.findById(event._id).lean()).unansweredNoticeAt).toBeFalsy();
    expect(await lines()).toHaveLength(0);
  });

  test('a released message older than a day, below or past the cap: left to expiry', async () => {
    const below = await released({ attempts: 2, ageMinutes: 25 * 60 });
    const past = await released({ attempts: 4, ageMinutes: 25 * 60, payload: { messageId: '42', userId: String(person._id), content: '@otto old' } });

    await collect();

    expect(await status(below)).toBe('pending');
    expect(await status(past)).toBe('pending');
    expect(await lines()).toHaveLength(0);
  });

  test('when the agent has posted in the pod since the message', async () => {
    const event = await released({ attempts: 2 });
    await mockPool.query('INSERT INTO messages (pod_id, user_id, content) VALUES ($1, $2, $3)', [
      String(POD), String(agent._id), 'Reviewed, two comments.',
    ]);

    await collect();

    expect(await status(event)).toBe('pending');
    expect(await lines()).toHaveLength(0);
  });
});

test('a second replica that read the same row posts no second notice', async () => {
  const event = await released({ attempts: 2 });
  const snapshot = await AgentEvent.find({ _id: event._id }).lean();
  const threshold = minutesAgo(10);

  expect(await AgentEventService.noticeUnclaimedReleases(threshold, 3)).toBe(1);
  const find = jest.spyOn(AgentEvent, 'find').mockReturnValueOnce({
    sort: () => ({ limit: () => ({ lean: () => Promise.resolve(snapshot) }) }),
  });
  try {
    expect(await AgentEventService.noticeUnclaimedReleases(threshold, 3)).toBe(0);
  } finally {
    find.mockRestore();
  }
  expect(await lines()).toHaveLength(1);
});

test('a release stamps releasedAt and the requeue sweep clears it', async () => {
  const nonce = 'r'.repeat(32);
  const held = await AgentEvent.create({
    agentName: 'otto',
    instanceId: 'default',
    podId: POD,
    type: 'chat.mention',
    status: 'delivered',
    attempts: 1,
    deliveredAt: minutesAgo(1),
    deliveryNonce: nonce,
    payload: { messageId: '41', userId: String(person._id), content: '@otto hi' },
  });

  expect(await AgentEventService.releaseDelivery(String(held._id), 'otto', 'default', nonce)).toBe('released');
  expect((await AgentEvent.findById(held._id).lean()).releasedAt).toBeInstanceOf(Date);

  // Claimed again, then silent past the window: the requeue puts it back, unstamped.
  await AgentEvent.collection.updateOne(
    { _id: held._id },
    { $set: { status: 'delivered', attempts: 2, deliveredAt: minutesAgo(30), deliveryNonce: nonce } },
  );
  await collect();

  const saved = await AgentEvent.findById(held._id).lean();
  expect(saved.status).toBe('pending');
  expect(saved.releasedAt).toBeNull();
  expect(await lines()).toHaveLength(0);
});
