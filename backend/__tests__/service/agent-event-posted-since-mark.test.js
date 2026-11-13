/**
 * F242. A seat that reads ahead answers twice: during one turn it read queued
 * mentions through commonly_get_messages and answered them, and a later turn
 * delivered those same mentions as if they were new, so it answered again.
 *
 * Nothing can prove a model read a message (the read cursor is moved by the
 * wrapper's own reads too). What the kernel does know is the order things
 * happened in: whether this agent has posted in the pod since the message was
 * sent. When it has, the delivered turn says so inline and tells the model to
 * check what it posted before answering. Real Mongo for the queue and users;
 * pg-mem for the messages table.
 */
const { newDb } = require('pg-mem');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const pg = newDb();
pg.public.none(`CREATE TABLE messages (
  id SERIAL PRIMARY KEY, pod_id TEXT NOT NULL, user_id TEXT NOT NULL,
  content TEXT NOT NULL, message_type TEXT NOT NULL DEFAULT 'text', author_kind TEXT, payload JSONB,
  thread_root_id INTEGER, reply_to_message_id INTEGER, top_level_answer BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);
const { Pool } = pg.adapters.createPg();
const mockPool = new Pool();
jest.mock('../../config/db-pg', () => ({ pool: mockPool }));
jest.mock('../../config/socket', () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));
jest.mock('../../services/agentProvisionerService', () => ({
  getAgentSessionSizes: jest.fn(),
  clearAgentRuntimeSessions: jest.fn(),
  restartAgentRuntime: jest.fn(),
  resolveOpenClawAccountId: jest.fn(() => 'acct'),
}));
jest.mock('../../services/agentMemoryService', () => ({ buildMemoryDigestBundle: jest.fn(() => ({})) }));
jest.mock('../../services/nativeRuntimeService', () => ({ runAgent: jest.fn() }));

const User = require('../../models/User');
const AgentEvent = require('../../models/AgentEvent');
const AgentEventService = require('../../services/agentEventService');
const { postedSinceFrame } = require('../../services/mentionCoalesce');
const { runAgent } = require('../../services/nativeRuntimeService');
const { AgentInstallation } = require('../../models/AgentRegistry');

const POD = new mongoose.Types.ObjectId();
const MARK = 'You have posted in this pod since';
const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);
let person;
let agent;
let otherAgent;

const pending = (overrides = {}) => AgentEvent.create({
  agentName: 'otto',
  instanceId: 'default',
  podId: POD,
  type: 'chat.mention',
  status: 'pending',
  createdAt: minutesAgo(5),
  payload: {
    messageId: '41', userId: String(person._id), username: 'partner-person', content: '@otto is 11 done?',
  },
  ...overrides,
});
const post = (userId, at, { content = 'Yes, 11 is done.', type = 'text' } = {}) => mockPool.query(
  'INSERT INTO messages (pod_id, user_id, content, message_type, created_at) VALUES ($1, $2, $3, $4, $5)',
  [String(POD), String(userId), content, type, at],
);
const claim = async () => (await AgentEventService.listInboxPage({
  agentName: 'otto', instanceId: 'default', podId: POD, limit: 10,
})).events;
const contentOf = (event) => String(event.payload.content);

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), AgentEvent.deleteMany({})]);
  await mockPool.query('DELETE FROM messages');
  person = await User.create({ username: 'partner-person', email: 'partner@example.test', password: 'test-password' });
  agent = await User.create({
    username: 'otto',
    email: 'otto@agents.commonly.local',
    password: 'test-password',
    isBot: true,
    botMetadata: { agentName: 'otto', instanceId: 'default', displayName: 'Otto' },
  });
  otherAgent = await User.create({
    username: 'nova',
    email: 'nova@agents.commonly.local',
    password: 'test-password',
    isBot: true,
    botMetadata: { agentName: 'nova', instanceId: 'default', displayName: 'Nova' },
  });
});

test('a mention the agent has posted since reaches its turn marked, inline, with the message still there', async () => {
  await pending();
  await post(agent._id, minutesAgo(2));

  const [event] = await claim();

  expect(contentOf(event).startsWith(`${postedSinceFrame()}\n`)).toBe(true);
  expect(contentOf(event)).toContain('@otto is 11 done?');
  expect(contentOf(event)).toContain('NO_REPLY');
  expect(event.payload.postedSinceArrival).toBe(true);
});

test('the mark is on the delivery, not stored: the row keeps its own content', async () => {
  const row = await pending();
  await post(agent._id, minutesAgo(2));

  await claim();

  const saved = await AgentEvent.findById(row._id).lean();
  expect(saved.payload.content).toBe('@otto is 11 done?');
  expect(saved.payload.postedSinceArrival).toBeUndefined();
});

test('no post since the message: an ordinary turn', async () => {
  await pending();
  await post(agent._id, minutesAgo(9));

  const [event] = await claim();

  expect(contentOf(event)).toBe('@otto is 11 done?');
  expect(event.payload.postedSinceArrival).toBeUndefined();
});

test('only the agent\'s own posts count: a person or another agent posting since is no mark', async () => {
  await pending();
  await post(person._id, minutesAgo(2));
  await post(otherAgent._id, minutesAgo(1));

  const [event] = await claim();

  expect(contentOf(event)).not.toContain(MARK);
});

test('a platform line stored under the agent is not the agent posting', async () => {
  await pending();
  await post(agent._id, minutesAgo(2), { content: "Otto didn't answer this", type: 'system' });

  const [event] = await claim();

  expect(contentOf(event)).not.toContain(MARK);
});

test('a kernel notice stored as text under the agent is not the agent posting', async () => {
  await pending();
  await mockPool.query(
    'INSERT INTO messages (pod_id, user_id, content, message_type, author_kind, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [String(POD), String(agent._id), "Otto couldn't finish that turn.", 'text', 'kernel', minutesAgo(2)],
  );

  const [event] = await claim();

  expect(contentOf(event)).not.toContain(MARK);
});

test('a post in another pod is no mark', async () => {
  await pending();
  await mockPool.query(
    'INSERT INTO messages (pod_id, user_id, content, created_at) VALUES ($1, $2, $3, $4)',
    [String(new mongoose.Types.ObjectId()), String(agent._id), 'elsewhere', minutesAgo(2)],
  );

  const [event] = await claim();

  expect(contentOf(event)).not.toContain(MARK);
});

test('a row that joined later messages counts from the newest: a post between them is no mark', async () => {
  await pending({
    payload: {
      messageId: '41',
      userId: String(person._id),
      username: 'partner-person',
      content: '@otto is 11 done?',
      coalesced: [{
        messageId: '44',
        userId: String(person._id),
        username: 'partner-person',
        rawContent: '@otto and 12?',
        createdAt: minutesAgo(1).toISOString(),
      }],
    },
  });
  await post(agent._id, minutesAgo(3));

  const [event] = await claim();

  expect(contentOf(event)).not.toContain(MARK);
  expect(contentOf(event)).toContain('@otto and 12?');
});

test('a row that joined later messages is marked when the agent posted after all of them', async () => {
  await pending({
    payload: {
      messageId: '41',
      userId: String(person._id),
      username: 'partner-person',
      content: '@otto is 11 done?',
      coalesced: [{
        messageId: '44',
        userId: String(person._id),
        username: 'partner-person',
        rawContent: '@otto and 12?',
        createdAt: minutesAgo(3).toISOString(),
      }],
    },
  });
  await post(agent._id, minutesAgo(1));

  const [event] = await claim();

  expect(contentOf(event).startsWith(postedSinceFrame())).toBe(true);
});

test('a row already marked as arriving mid-turn keeps that one mark and gets no second', async () => {
  await pending({
    payload: {
      messageId: '41',
      userId: String(person._id),
      username: 'partner-person',
      content: '[This message reached you while your turn on message 40 from @partner-person was running.]\n'
        + '@otto is 11 done?',
      arrivedMidTurn: { eventId: 'e40', messageId: '40' },
    },
  });
  await post(agent._id, minutesAgo(2));

  const [event] = await claim();

  expect(contentOf(event)).not.toContain(MARK);
  expect(contentOf(event).startsWith('[This message reached you')).toBe(true);
});

test('a DM and a thread mention are marked too: a person waits on each', async () => {
  await pending({ type: 'dm.message' });
  await pending({
    type: 'thread.mention',
    createdAt: minutesAgo(4),
    payload: { messageId: '42', userId: String(person._id), content: '@otto in the thread' },
  });
  await post(agent._id, minutesAgo(2));

  const events = await claim();

  expect(events).toHaveLength(2);
  events.forEach((event) => expect(contentOf(event)).toContain(MARK));
});

test('a heartbeat is not marked: nobody asked it anything', async () => {
  await pending({ type: 'heartbeat', payload: { content: 'heartbeat' } });
  await post(agent._id, minutesAgo(2));

  const [event] = await claim();

  expect(contentOf(event)).not.toContain(MARK);
});

test('a failed lookup delivers the turn unmarked rather than losing it', async () => {
  await pending();
  await post(agent._id, minutesAgo(2));
  const spy = jest.spyOn(mockPool, 'query').mockRejectedValueOnce(new Error('pg down'));

  const events = await claim();

  spy.mockRestore();
  expect(events).toHaveLength(1);
  expect(contentOf(events[0])).toBe('@otto is 11 done?');
});

// A hosted turn that posted and then died is re-run by the sweep; the re-run
// is the second answer the row warns about.
describe('a native agent', () => {
  const nativeInstall = {
    _id: new mongoose.Types.ObjectId(),
    agentName: 'otto',
    instanceId: 'default',
    podId: POD,
    status: 'active',
    config: { runtime: { runtimeType: 'native' } },
  };
  const waitForCalls = async (count) => {
    const deadline = Date.now() + 5000;
    while (runAgent.mock.calls.length < count && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    expect(runAgent).toHaveBeenCalledTimes(count);
  };
  const prompt = (call) => String(runAgent.mock.calls[call][1].payload.content);

  afterEach(() => { jest.restoreAllMocks(); });

  test('a turn re-run after the first one posted is marked; the first was not', async () => {
    runAgent.mockReset();
    runAgent.mockImplementation(() => new Promise(() => {}));
    jest.spyOn(AgentInstallation, 'findOne').mockReturnValue({ lean: () => Promise.resolve(nativeInstall) });
    const event = await AgentEventService.enqueue({
      agentName: 'otto',
      instanceId: 'default',
      podId: POD,
      type: 'chat.mention',
      payload: { messageId: '41', userId: String(person._id), content: '@otto is 11 done?' },
    });
    await waitForCalls(1);
    expect(prompt(0)).not.toContain(MARK);

    // The first turn posts its answer, then its process dies.
    await post(agent._id, new Date());
    await AgentEvent.updateOne({ _id: event._id }, { $set: { deliveredAt: minutesAgo(60) } });
    await AgentEventService.redispatchStuckInProcess(minutesAgo(10), 3);

    await waitForCalls(2);
    expect(prompt(1).startsWith(postedSinceFrame())).toBe(true);
    expect(prompt(1)).toContain('@otto is 11 done?');
  });
});
