/**
 * TASK-656. A person's message to an agent that the requeue cap retires after
 * three unacknowledged deliveries leaves one visible line in the pod, so the
 * person never waits on silence. Real Mongo for the queue and users; pg-mem
 * for the messages table the line is written to.
 */
const { newDb } = require('pg-mem');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const pg = newDb();
pg.public.none(`CREATE TABLE messages (
  id SERIAL PRIMARY KEY, pod_id TEXT NOT NULL, user_id TEXT NOT NULL,
  content TEXT NOT NULL, message_type TEXT NOT NULL DEFAULT 'text', payload JSONB,
  thread_root_id INTEGER, reply_to_message_id INTEGER,
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
const mockPostToPublic = jest.fn();
jest.mock('../../services/outboundUrlGuard', () => ({
  ...jest.requireActual('../../services/outboundUrlGuard'),
  postToPublicAddress: (...args) => mockPostToPublic(...args),
}));

const User = require('../../models/User');
const AgentEvent = require('../../models/AgentEvent');
const AgentEventService = require('../../services/agentEventService');

const POD = new mongoose.Types.ObjectId();
const HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000);
let person;
let agent;

const lines = async () => (
  await mockPool.query("SELECT * FROM messages WHERE message_type = 'system' ORDER BY id")
).rows;
// A delivered row on its third unacknowledged delivery, past the requeue age.
const exhausted = (overrides = {}) => AgentEvent.create({
  agentName: 'otto',
  instanceId: 'default',
  podId: POD,
  type: 'chat.mention',
  status: 'delivered',
  attempts: 3,
  deliveredAt: HOUR_AGO(),
  deliveryNonce: 'n'.repeat(32),
  payload: {
    messageId: '41', threadRootId: '40', userId: String(person._id), content: '@otto can you review this?', 
  },
  ...overrides,
});
const collect = () => AgentEventService.garbageCollect({ requeueDeliveredMinutes: 10, requeueMaxAttempts: 3 });

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

test("a person's exhausted mention is retired and leaves one line in their thread", async () => {
  const event = await exhausted();

  const result = await collect();

  expect(result.expiredDelivered).toBe(1);
  const saved = await AgentEvent.findById(event._id).lean();
  expect(saved.status).toBe('failed');
  expect(saved.error).toMatch(/requeue cap exhausted after 3/);
  const posted = await lines();
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({
    pod_id: String(POD), user_id: String(agent._id), thread_root_id: 40, reply_to_message_id: 41,
  });
  expect(posted[0].content).toContain("Otto didn't answer this");
  expect(posted[0].payload).toMatchObject({ kind: 'system-action', action: 'mention-unanswered', attempts: 3 });
  expect(mockEmit).toHaveBeenCalledWith('newMessage', expect.objectContaining({ messageType: 'system' }));

  // A second pass finds nothing left to retire and posts nothing more.
  await collect();
  expect(await lines()).toHaveLength(1);
});

test('stays silent when the agent has posted in the pod since the message', async () => {
  const event = await exhausted({ createdAt: HOUR_AGO() });
  await mockPool.query('INSERT INTO messages (pod_id, user_id, content) VALUES ($1, $2, $3)', [
    String(POD), String(agent._id), 'Reviewed, two comments.',
  ]);

  await collect();

  expect((await AgentEvent.findById(event._id).lean()).status).toBe('failed');
  expect(await lines()).toHaveLength(0);
});

test('stays silent for a kernel wake and for a message an agent sent', async () => {
  // A board wake can name the person whose edit caused it; it is still the kernel's.
  const kernel = await exhausted({
    payload: {
      triggerAuthor: 'kernel', boardWake: true, userId: String(person._id), content: 'TASK-1 updated', 
    },
  });
  const fromAgent = await exhausted({
    payload: { messageId: '42', userId: String(agent._id), content: '@otto gate this' },
  });

  const result = await collect();

  expect(result.expiredDelivered).toBe(2);
  expect((await AgentEvent.findById(kernel._id).lean()).status).toBe('failed');
  expect((await AgentEvent.findById(fromAgent._id).lean()).status).toBe('failed');
  expect(await lines()).toHaveLength(0);
});

test("a newcomer's welcome wake is a person waiting, and gets the line", async () => {
  await exhausted({
    payload: {
      messageId: '43', userId: String(person._id), welcomeWake: true, content: 'hi', 
    }, 
  });

  await collect();

  expect((await lines()).map((line) => line.reply_to_message_id)).toEqual([43]);
});

test('other exhausted events are still retired in bulk, with no line', async () => {
  const heartbeat = await exhausted({ type: 'heartbeat', payload: {} });
  const ambient = await exhausted({ type: 'message.posted', payload: { userId: String(person._id) } });

  const result = await collect();

  expect(result.expiredDelivered).toBe(2);
  expect((await AgentEvent.findById(heartbeat._id).lean()).status).toBe('failed');
  expect((await AgentEvent.findById(ambient._id).lean()).status).toBe('failed');
  expect(await lines()).toHaveLength(0);
});

test('a second replica that read the same rows posts no second line', async () => {
  const event = await exhausted();
  const snapshot = await AgentEvent.find({ _id: event._id }).lean();
  const error = 'requeue cap exhausted after 3 delivery attempts without an ack';
  const threshold = new Date();

  expect(await AgentEventService.retireUnansweredMentions(threshold, 3, error)).toBe(1);
  // The other replica's find ran before this one's retire: it holds the stale row.
  const find = jest.spyOn(AgentEvent, 'find').mockReturnValueOnce({
    sort: () => ({ limit: () => ({ lean: () => Promise.resolve(snapshot) }) }),
  });
  try {
    expect(await AgentEventService.retireUnansweredMentions(threshold, 3, error)).toBe(0);
  } finally {
    find.mockRestore();
  }
  expect(await lines()).toHaveLength(1);
});

test("a person's message past one pass's batch waits for the next pass, not a silent retire", async () => {
  await Promise.all(Array.from({ length: 51 }, (_, i) => exhausted({
    payload: { messageId: String(100 + i), userId: String(person._id), content: `@otto question ${i}` },
  })));

  await collect();
  expect(await lines()).toHaveLength(50);
  expect(await AgentEvent.countDocuments({ status: 'delivered' })).toBe(1);

  await collect();
  expect(await lines()).toHaveLength(51);
});

test('an event below the cap is requeued, not retired, and posts nothing', async () => {
  const event = await exhausted({ attempts: 2 });

  await collect();

  expect((await AgentEvent.findById(event._id).lean()).status).toBe('pending');
  expect(await lines()).toHaveLength(0);
});

describe('a webhook agent whose endpoint fails', () => {
  const install = {
    agentName: 'otto',
    instanceId: 'default',
    podId: POD,
    config: { runtime: { runtimeType: 'webhook', webhookUrl: 'https://agent.example/hook' } }, 
  };
  const pendingEvent = (overrides = {}) => AgentEvent.create({
    agentName: 'otto',
    instanceId: 'default',
    podId: POD,
    type: 'chat.mention',
    status: 'pending',
    payload: { messageId: '51', userId: String(person._id), content: '@otto hello' },
    ...overrides,
  });

  // `agent register --webhook` hands off to `agent connect`, which polls the
  // same install: a failed POST has to leave the event for that poller.
  test('a failed POST leaves the event pending for a poller, with no line', async () => {
    mockPostToPublic.mockResolvedValueOnce({ ok: false, status: 503, text: '' });
    mockPostToPublic.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const refused = await pendingEvent();
    const unreachable = await pendingEvent({
      payload: { messageId: '52', userId: String(person._id), content: '@otto hi' },
    });

    await AgentEventService.deliverEventViaWebhook(install, (await AgentEvent.findById(refused._id).lean()));
    await AgentEventService.deliverEventViaWebhook(install, (await AgentEvent.findById(unreachable._id).lean()));

    expect((await AgentEvent.findById(refused._id).lean()).status).toBe('pending');
    expect((await AgentEvent.findById(unreachable._id).lean()).status).toBe('pending');
    const polled = await AgentEventService.list({ agentName: 'otto', instanceId: 'default' });
    expect(polled.map((event) => String(event._id)).sort())
      .toEqual([String(refused._id), String(unreachable._id)].sort());
    expect(await lines()).toHaveLength(0);
  });

  test('a delivered POST is still acked', async () => {
    mockPostToPublic.mockResolvedValueOnce({ ok: true, status: 200, text: '{"outcome":"no_action"}' });
    const event = await pendingEvent();

    await AgentEventService.deliverEventViaWebhook(install, (await AgentEvent.findById(event._id).lean()));

    expect((await AgentEvent.findById(event._id).lean()).status).toBe('acked');
    expect(await lines()).toHaveLength(0);
  });
});
