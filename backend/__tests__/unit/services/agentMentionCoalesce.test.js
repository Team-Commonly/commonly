// A person and their own agent @mention the same agent back to back: the target
// answers once, seeing both, when the turn has not started; when it has, the
// later mention wakes it again, marked as something that turn could not see.
//
// Everything real except the model and Postgres: enqueueMentions and
// enqueueDmEvent, AgentEventService, and Mongo. A second mention is the whole
// case, so a mocked enqueue could not fail here.
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

jest.mock('../../../services/agentMemoryService', () => ({
  buildMemoryDigestBundle: jest.fn(() => ({})),
}));
jest.mock('../../../services/agentProvisionerService', () => ({
  getAgentSessionSizes: jest.fn(),
  clearAgentRuntimeSessions: jest.fn(),
  restartAgentRuntime: jest.fn(),
  resolveOpenClawAccountId: jest.fn(() => 'acct'),
}));
jest.mock('../../../services/nativeRuntimeService', () => ({ runAgent: jest.fn() }));
jest.mock('../../../services/chatSummarizerService', () => ({
  constructor: { getLatestPodSummary: jest.fn() },
  summarizePodMessages: jest.fn(),
}));
jest.mock('../../../models/pg/Message', () => ({
  findById: jest.fn().mockResolvedValue(null),
  findPreviousTopLevel: jest.fn().mockResolvedValue(null),
  recentContentByAuthor: jest.fn().mockResolvedValue([]),
  findByPodId: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../services/neverConnectedMentionService', () => ({
  noteNeverConnectedMention: jest.fn().mockResolvedValue(false),
  isNeverConnectedAgent: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../services/welcomeWakeService', () => ({
  maybeFireWelcomeWake: jest.fn().mockResolvedValue({ woke: [] }),
}));

let mongod;
let AgentEvent;
let AgentEventService;
let AgentMentionService;
let AgentInstallation;
let User;
let Pod;
let runAgent;

const POD = new mongoose.Types.ObjectId();
const ALICE = new mongoose.Types.ObjectId();
const BOB = new mongoose.Types.ObjectId();
const ALICE_AGENT = new mongoose.Types.ObjectId();
const BOB_AGENT = new mongoose.Types.ObjectId();
const CODEX_BOT = new mongoose.Types.ObjectId();

const TARGET = { agentName: 'codex', instanceId: 'default' };
const targetRows = () => AgentEvent.find({ ...TARGET, podId: POD }).sort({ createdAt: 1 }).lean();
const claim = () => AgentEventService.listInboxPage({ ...TARGET, limit: 10, podId: POD });

let nextMessageId = 500;
const mention = ({
  from = ALICE, username = 'alice', content = '@codex what is the status?', ...message
} = {}) => {
  nextMessageId += 1;
  const id = String(nextMessageId);
  return AgentMentionService.enqueueMentions({
    podId: String(POD),
    userId: String(from),
    username,
    message: {
      id, content, createdAt: new Date().toISOString(), ...message,
    },
  }).then((result) => ({ id, result }));
};
const fromOwnAgent = (content) => mention({ from: ALICE_AGENT, username: 'alice-claude', content });
const fromBob = (content) => mention({ from: BOB, username: 'bob', content });

const seedInstall = (agentName, installedBy, config = {}) => AgentInstallation.collection.insertOne({
  agentName, instanceId: 'default', podId: POD, status: 'active', installedBy, version: '1.0.0', config,
});
const seedUser = (_id, username, extra = {}) => User.collection.insertOne({
  _id, username, email: `${username}@example.test`, password: 'x', isBot: false, ...extra,
});

const installTarget = (runtime) => seedInstall('codex', BOB, runtime ? { runtime } : {});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  AgentEvent = require('../../../models/AgentEvent');
  User = require('../../../models/User');
  Pod = require('../../../models/Pod');
  ({ AgentInstallation } = require('../../../models/AgentRegistry'));
  AgentEventService = require('../../../services/agentEventService');
  AgentMentionService = require('../../../services/agentMentionService');
  ({ runAgent } = require('../../../services/nativeRuntimeService'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    AgentEvent.deleteMany({}),
    User.collection.deleteMany({}),
    Pod.collection.deleteMany({}),
    AgentInstallation.collection.deleteMany({}),
  ]);
  AgentEventService.inProcessLanes?.clear();
  AgentEventService.inProcessLaneHolders?.clear();
  await Promise.all([
    seedUser(ALICE, 'alice'),
    seedUser(BOB, 'bob'),
    seedUser(ALICE_AGENT, 'alice-claude', {
      isBot: true, botMetadata: { agentName: 'claude-code', instanceId: 'default' },
    }),
    seedUser(BOB_AGENT, 'bob-cursor', {
      isBot: true, botMetadata: { agentName: 'cursor', instanceId: 'default' },
    }),
    seedUser(CODEX_BOT, 'codex', { isBot: true, botMetadata: { ...TARGET } }),
    Pod.collection.insertOne({
      _id: POD,
      name: 'two owners',
      type: 'chat',
      createdBy: ALICE,
      members: [ALICE, BOB, ALICE_AGENT, BOB_AGENT, CODEX_BOT],
    }),
    seedInstall('claude-code', ALICE),
    seedInstall('cursor', BOB),
  ]);
});

describe('a polled target', () => {
  beforeEach(async () => { await installTarget(); });

  test('two mentions from one person while the first is pending make one row that carries both', async () => {
    await mention({ content: '@codex is staging up?' });
    await mention({ content: '@codex and did the migration run?' });

    expect(await targetRows()).toHaveLength(1);
    const { events } = await claim();
    expect(events).toHaveLength(1);
    expect(events[0].payload.content).toContain('is staging up?');
    expect(events[0].payload.content).toContain('did the migration run?');
  });

  // ADR-018 D6.5: a joined message has to be read by a turn that has not begun.
  describe('only a row nothing has claimed, and that is young, takes a join', () => {
    const backdate = (minutes) => AgentEvent.collection.updateMany(
      { ...TARGET, podId: POD },
      { $set: { createdAt: new Date(Date.now() - minutes * 60 * 1000) } },
    );

    test('a requeued row keeps its old turn: a mention stays its own row and survives that turn\'s nonce-less ack', async () => {
      await mention({ content: '@codex a slow question' });
      const { events: [turn] } = await claim();
      await AgentEvent.updateOne({ _id: turn._id }, { $set: { deliveredAt: new Date(Date.now() - 20 * 60 * 1000) } });
      await AgentEventService.garbageCollect({ requeueDeliveredMinutes: 10, requeueMaxAttempts: 3 });
      expect((await AgentEvent.findById(turn._id).lean()).status).toBe('pending');

      await mention({ content: '@codex a new question' });

      // The openclaw extension acks with no deliveryId, and pending is ackable.
      await AgentEventService.acknowledge(turn._id, TARGET.agentName, TARGET.instanceId, { outcome: 'posted' });
      const { events } = await claim();
      expect(events).toHaveLength(1);
      expect(events[0].payload.rawContent).toContain('a new question');
      expect(events[0].payload.arrivedMidTurn).toBeUndefined();
    });

    test('a row one delivery from the cap takes no join, so nothing rides its last attempts', async () => {
      await mention({ content: '@codex near the cap' });
      await AgentEvent.updateMany({ ...TARGET, podId: POD }, { $set: { attempts: 2 } });
      await mention({ content: '@codex a new question' });

      const rows = await targetRows();
      expect(rows).toHaveLength(2);
      expect(rows[0].payload.coalesced).toBeUndefined();
    });

    test('an old row takes no join, so a message does not inherit its age', async () => {
      await mention({ content: '@codex from a while ago' });
      await backdate(11);
      await mention({ content: '@codex a new question' });

      const rows = await targetRows();
      expect(rows).toHaveLength(2);
      expect(rows[0].payload.coalesced).toBeUndefined();
    });

    test('a row inside the age bound still takes a join', async () => {
      await mention({ content: '@codex a few minutes ago' });
      await backdate(9);
      await mention({ content: '@codex a new question' });

      const rows = await targetRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.coalesced).toHaveLength(1);
    });
  });

  describe('a context-overflow retry', () => {
    const carrying = (extra) => ({
      messageId: '71',
      userId: String(ALICE),
      username: 'alice',
      rawContent: 'head',
      content: 'head',
      ...extra,
    });
    const enqueue = (payload) => AgentEventService.enqueue({
      ...TARGET, podId: POD, type: 'chat.mention', payload,
    });

    test.each([
      ['its retry count', { _contextOverflowRetryCount: 1 }],
      ['joined messages', { coalesced: [{ messageId: '72', userId: String(ALICE), rawContent: 'second' }] }],
    ])('carrying %s it keeps its own row, so nothing it carried is dropped', async (_what, extra) => {
      await mention({ content: '@codex a waiting message' });
      await enqueue(carrying(extra));

      const rows = await targetRows();
      expect(rows).toHaveLength(2);
      expect(rows[0].payload.coalesced).toBeUndefined();
      expect(rows[1].payload).toMatchObject(extra);
    });

    test('a retried row with joined messages reads them all on its next turn', async () => {
      const payload = AgentEventService.buildContextOverflowRetryPayload(carrying({
        coalesced: [{ messageId: '72', userId: String(ALICE), username: 'alice', rawContent: 'second' }],
      }), { reason: 'context overflow' });
      await mention({ content: '@codex a waiting message' });
      await enqueue(payload);

      const { events } = await claim();
      const retry = events.find((event) => event.payload.messageId === '71');
      expect(retry.payload.content).toContain('second');
      expect(retry.payload._contextOverflowRetryCount).toBe(1);
    });

    // The retry limit acks the row with no further retry, and a row that
    // overflowed once is the wrong place to add text.
    test('nothing joins a retry: the row that overflowed could be retired with it', async () => {
      await enqueue(carrying({ _contextOverflowRetryCount: 2 }));
      await mention({ content: '@codex a new question' });

      const rows = await targetRows();
      expect(rows).toHaveLength(2);
      expect(rows[0].payload.coalesced).toBeUndefined();
    });
  });

  describe('a non-scalar never coalesces', () => {
    const enqueue = (extra) => AgentEventService.enqueue({
      ...TARGET,
      podId: POD,
      type: 'chat.mention',
      payload: {
        messageId: '66', username: 'x', rawContent: 'injected', content: 'injected', ...extra,
      },
    });

    test('an operator object in threadRootId does not widen the place', async () => {
      await mention({ content: '@codex in a thread', thread_root_id: 42 });
      await enqueue({ userId: String(ALICE), threadRootId: { $ne: null } });

      const rows = await targetRows();
      expect(rows).toHaveLength(2);
      expect(rows[0].payload.coalesced).toBeUndefined();
    });

    test('an operator object in userId does not resolve to someone\'s principal', async () => {
      await mention({ content: '@codex from alice' });
      await enqueue({ userId: { $eq: ALICE_AGENT } });

      const rows = await targetRows();
      expect(rows).toHaveLength(2);
      expect(rows[0].payload.coalesced).toBeUndefined();
    });
  });

  test('a join wakes a socket driver, because the row\'s first push may have found nobody', async () => {
    // eslint-disable-next-line global-require
    const ws = require('../../../services/agentWebSocketService');
    const push = jest.spyOn(ws, 'pushEvent').mockReturnValue(true);
    try {
      await mention({ content: '@codex is staging up?' });
      expect(push).toHaveBeenCalledTimes(1);
      await mention({ content: '@codex and did the migration run?' });
      expect(await targetRows()).toHaveLength(1);
      expect(push).toHaveBeenCalledTimes(2);
      expect(push.mock.calls[1][0].deliveryId).toBeUndefined();
    } finally {
      push.mockRestore();
    }
  });

  test('the same message enqueued again wakes nobody: it is not a new mention', async () => {
    // eslint-disable-next-line global-require
    const ws = require('../../../services/agentWebSocketService');
    const push = jest.spyOn(ws, 'pushEvent').mockReturnValue(true);
    const payload = {
      messageId: '79', userId: String(ALICE), username: 'alice', rawContent: 'hi', content: 'hi',
    };
    try {
      await AgentEventService.enqueue({
        ...TARGET, podId: POD, type: 'chat.mention', payload,
      });
      await AgentEventService.enqueue({
        ...TARGET, podId: POD, type: 'chat.mention', payload,
      });
      expect(push).toHaveBeenCalledTimes(1);
    } finally {
      push.mockRestore();
    }
  });

  test('an agent\'s owner is read from its install in this pod, not one elsewhere', async () => {
    // A lower pod id too: an unscoped lookup walks the install index in pod order.
    const OTHER_BOT = new mongoose.Types.ObjectId();
    await AgentInstallation.collection.insertOne({
      agentName: 'shared-bot',
      instanceId: 'default',
      podId: new mongoose.Types.ObjectId('000000000000000000000001'),
      status: 'active',
      installedBy: ALICE,
      version: '1.0.0',
      config: {},
    });
    await seedInstall('shared-bot', BOB);
    await seedUser(OTHER_BOT, 'shared-bot', {
      isBot: true, botMetadata: { agentName: 'shared-bot', instanceId: 'default' },
    });
    await Pod.collection.updateOne({ _id: POD }, { $push: { members: OTHER_BOT } });

    await mention({ content: '@codex from alice' });
    await mention({ from: OTHER_BOT, username: 'shared-bot', content: '@codex from the bot bob installed here' });

    expect(await targetRows()).toHaveLength(2);
  });

  test('a joined agent message keeps its handoff cue', async () => {
    await mention({ content: '@codex please review the deploy' });
    await fromOwnAgent('@codex over to you for the smoke check');

    const { events: [turn] } = await claim();
    expect(turn.payload.content).toContain('@claude-code handed this to you');
  });

  test('a person and their own agent, the reported pair, make one row, and that turn sees the agent\'s message', async () => {
    await mention({ content: '@codex please review the deploy' });
    const second = await fromOwnAgent('@codex the failing step is the smoke check');

    expect(await targetRows()).toHaveLength(1);
    const { events: [turn] } = await claim();
    expect(turn.payload.content).toContain('please review the deploy');
    expect(turn.payload.content).toContain('the failing step is the smoke check');
    expect(turn.payload.content).toContain(`message ${second.id}`);
    expect(turn.payload.content).toContain('alice-claude');
    // Programs read rawContent (F109), so a coalesced message reaches them too.
    expect(turn.payload.rawContent).toContain('the failing step is the smoke check');
    expect(turn.payload.coalesced).toEqual([
      expect.objectContaining({ messageId: second.id, username: 'alice-claude' }),
    ]);
  });

  test('the mention still counts as delivered to the sender', async () => {
    await mention();
    const { result } = await fromOwnAgent('@codex one more thing');
    expect(result.enqueued).toEqual(['codex']);
  });

  test('a person\'s mention never rides an agent\'s row, so the cascade cap cannot refuse it', async () => {
    await fromOwnAgent('@codex please look');
    const person = await mention({ content: '@codex yes, please do' });

    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].payload.messageId).toBe(person.id);
  });

  test('two different people each keep their own row: coalescing is not deduping', async () => {
    const first = await mention({ content: '@codex is staging up?' });
    const second = await fromBob('@codex what does the invoice say?');

    const rows = await targetRows();
    expect(rows.map((row) => row.payload.messageId)).toEqual([first.id, second.id]);
    expect(rows[1].payload.rawContent).toContain('what does the invoice say?');
    // A poller takes these two in one batch, so neither is told it was missed.
    expect(rows[1].payload.arrivedMidTurn).toBeUndefined();
  });

  test('two agents with different owners each keep their own row: mentions between agents still deliver', async () => {
    await fromOwnAgent('@codex from claude');
    await mention({ from: BOB_AGENT, username: 'bob-cursor', content: '@codex from cursor' });
    expect(await targetRows()).toHaveLength(2);
  });

  test('the second mention while the first is claimed waits as its own row, marked as unseen by that turn', async () => {
    const first = await mention({ content: '@codex please review the deploy' });
    await claim();
    const second = await fromOwnAgent('@codex the failing step is the smoke check');

    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].payload.content).not.toContain('the failing step');
    expect(rows[1].payload.messageId).toBe(second.id);
    expect(rows[1].payload.arrivedMidTurn).toEqual(expect.objectContaining({ messageId: first.id }));
    expect(rows[1].payload.content).toContain('could not see');
    expect(rows[1].payload.content).toContain('NO_REPLY');
    expect(rows[1].payload.content).toContain('the failing step is the smoke check');
  });

  test('several mentions during one turn fold into one follow-up turn', async () => {
    await mention();
    await claim();
    await fromOwnAgent('@codex first addition');
    await fromOwnAgent('@codex second addition');
    await mention({ content: '@codex third addition' });

    const rows = await targetRows();
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.status === 'pending')).toHaveLength(2);
    const { events } = await claim();
    expect(events.map((event) => event.payload.coalesced?.length || 0)).toEqual([1, 0]);
    expect(events[0].payload.content).toContain('second addition');
  });

  test('a different person\'s ask during a turn is told it must be answered', async () => {
    await mention({ content: '@codex is staging up?' });
    await claim();
    await fromBob('@codex what does the invoice say?');

    const [, follow] = await targetRows();
    expect(follow.payload.content).toContain('what does the invoice say?');
    expect(follow.payload.content).toContain('different person');
    expect(follow.payload.content).toContain('answer them');
    expect(follow.payload.content).toContain('alice');
  });

  test('a mention after the ack is an ordinary turn, with no mid-turn mark', async () => {
    await mention();
    const { events: [turn] } = await claim();
    await AgentEventService.acknowledge(turn._id, TARGET.agentName, TARGET.instanceId, { outcome: 'posted' }, turn.payload.deliveryId);
    await fromOwnAgent('@codex a new question');

    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].payload.arrivedMidTurn).toBeUndefined();
    expect(rows[1].payload.content).not.toContain('could not see');
  });

  test('a retry of an answered mention is a fresh turn, not one already carried', async () => {
    const payload = {
      messageId: '88', userId: String(ALICE), username: 'alice', rawContent: 'hi', content: 'hi',
    };
    await AgentEventService.enqueue({
      ...TARGET, podId: POD, type: 'chat.mention', payload,
    });
    const { events: [turn] } = await claim();
    await AgentEventService.acknowledge(turn._id, TARGET.agentName, TARGET.instanceId, { outcome: 'error' }, turn.payload.deliveryId);
    await AgentEventService.enqueue({
      ...TARGET, podId: POD, type: 'chat.mention', payload,
    });
    expect(await targetRows()).toHaveLength(2);
  });

  test('a claim abandoned long ago is not a running turn', async () => {
    await mention();
    await claim();
    await AgentEvent.updateMany({ status: 'delivered' }, { $set: { deliveredAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await fromOwnAgent('@codex anyone there?');

    const rows = await targetRows();
    expect(rows[1].payload.arrivedMidTurn).toBeUndefined();
  });

  test('a thread and the main channel are different places', async () => {
    await mention({ content: '@codex in the channel' });
    await mention({ content: '@codex in a thread', thread_root_id: 42 });

    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].payload.threadRootId).toBe(42);
    expect(rows[1].payload.arrivedMidTurn).toBeUndefined();
  });

  test('a turn running in the channel does not mark a thread mention as unseen, nor the other way round', async () => {
    await mention({ content: '@codex in the channel' });
    await claim();
    await mention({ content: '@codex in a thread', thread_root_id: 42 });
    const rows = await targetRows();
    expect(rows[1].payload.arrivedMidTurn).toBeUndefined();
  });

  test('two threads are different places, and one thread is one place', async () => {
    await mention({ content: '@codex one', thread_root_id: 42 });
    await mention({ content: '@codex two', thread_root_id: 43 });
    await mention({ content: '@codex three', thread_root_id: 42 });

    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].payload.coalesced).toHaveLength(1);
    expect(rows[1].payload.coalesced).toBeUndefined();
  });

  test('the same message enqueued again is not a coalesced copy of itself', async () => {
    const payload = {
      messageId: '77', userId: String(ALICE), username: 'alice', rawContent: 'hi', content: 'hi',
    };
    await AgentEventService.enqueue({
      ...TARGET, podId: POD, type: 'chat.mention', payload,
    });
    await AgentEventService.enqueue({
      ...TARGET, podId: POD, type: 'chat.mention', payload,
    });
    const rows = await targetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.coalesced).toBeUndefined();
  });

  test('a claim that wins the race keeps the second mention as its own row', async () => {
    await mention();
    const original = AgentEvent.findOneAndUpdate.bind(AgentEvent);
    const update = jest.spyOn(AgentEvent, 'findOneAndUpdate');
    update.mockImplementationOnce((...args) => ({
      lean: async () => {
        // The poller gets there between the read and the merge.
        await AgentEvent.updateMany({ status: 'pending' }, { $set: { status: 'delivered', deliveredAt: new Date() } });
        return original(...args).lean();
      },
    }));
    try {
      await fromOwnAgent('@codex lost the race');
    } finally {
      update.mockRestore();
    }
    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].payload.rawContent).toContain('lost the race');
    expect(rows[1].payload.arrivedMidTurn).toBeDefined();
  });

  test('a failed lookup falls through to an ordinary row: a lost mention is worse than a double answer', async () => {
    await mention();
    const find = jest.spyOn(AgentEvent, 'find').mockImplementationOnce(() => { throw new Error('mongo blip'); });
    try {
      await fromOwnAgent('@codex still arrives');
    } finally {
      find.mockRestore();
    }
    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].deliveryMode).toBe('wake');
    expect(rows[1].payload.rawContent).toContain('still arrives');
  });

  test('a full row stops growing and the next mention opens its own', async () => {
    await mention();
    for (let i = 0; i < 9; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await mention({ content: `@codex addition ${i}` });
    }
    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].payload.coalesced).toHaveLength(8);
    expect(rows[1].payload.rawContent).toContain('addition 8');
  });

  test.each([
    ['triggerAuthor', { triggerAuthor: 'kernel' }],
    ['assignedTaskWake', { assignedTaskWake: true }],
    ['boardWake', { boardWake: true }],
  ])('kernel wakes stay out of it: a mention never joins a %s row', async (_flag, flag) => {
    await AgentEventService.enqueue({
      ...TARGET,
      podId: POD,
      type: 'chat.mention',
      payload: {
        ...flag, messageId: '76', userId: String(ALICE), rawContent: 'your rows', content: 'your rows',
      },
    });
    await mention({ content: '@codex please look' });

    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].payload.coalesced).toBeUndefined();
    expect(rows[1].payload.arrivedMidTurn).toBeUndefined();
  });

  test.each([
    ['triggerAuthor', { triggerAuthor: 'kernel' }],
    ['assignedTaskWake', { assignedTaskWake: true }],
    ['boardWake', { boardWake: true }],
    ['welcomeWake', { welcomeWake: true }],
  ])('kernel wakes stay out of it: a %s row arriving second keeps its own turn', async (_flag, flag) => {
    await mention({ content: '@codex please look' });
    await AgentEventService.enqueue({
      ...TARGET,
      podId: POD,
      type: 'chat.mention',
      payload: {
        ...flag, messageId: '75', userId: String(ALICE), rawContent: 'kernel text', content: 'kernel text',
      },
    });
    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].payload.arrivedMidTurn).toBeUndefined();
  });

  test('a comment thread is not a place two messages share', async () => {
    const thread = { postId: 'p1', commentId: 'c1' };
    await mention({ content: '@codex one', source: 'thread', thread });
    await mention({ content: '@codex two', source: 'thread', thread: { postId: 'p2', commentId: 'c2' } });
    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe('thread.mention');
  });

  test('a wake naming no message is never joined', async () => {
    await AgentEventService.enqueue({
      ...TARGET,
      podId: POD,
      type: 'chat.mention',
      payload: { userId: String(ALICE), content: 'look at the board' },
    });
    await mention({ content: '@codex please look' });
    expect(await targetRows()).toHaveLength(2);
  });

  test('a welcome wake is its own row', async () => {
    await AgentEventService.enqueue({
      ...TARGET,
      podId: POD,
      type: 'chat.mention',
      payload: {
        welcomeWake: true, messageId: '77', rawContent: 'hello', content: 'welcome them', userId: String(ALICE),
      },
    });
    await mention({ content: '@codex please look' });
    expect(await targetRows()).toHaveLength(2);
  });

  test('a digest row is never a merge target', async () => {
    await AgentEventService.enqueue({
      ...TARGET,
      podId: POD,
      type: 'chat.mention',
      deliveryMode: 'digest',
      payload: { messageId: '78', rawContent: 'context', userId: String(ALICE), content: 'context' },
    });
    await mention({ content: '@codex please look' });

    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].deliveryMode).toBe('wake');
  });
});

describe('a webhook target', () => {
  test('its row was POSTed when it was enqueued, so a later mention is POSTed too, marked', async () => {
    await installTarget({ runtimeType: 'webhook', webhookUrl: 'https://hook.example.test/in' });
    const deliver = jest.spyOn(AgentEventService, 'deliverEventViaWebhook').mockResolvedValue();
    try {
      await mention();
      await fromOwnAgent('@codex one more');
    } finally {
      deliver.mockRestore();
    }
    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].payload.coalesced).toBeUndefined();
    expect(rows[1].payload.arrivedMidTurn).toBeDefined();
  });
});

describe('a hosted target, whose row is claimed at creation', () => {
  const flush = async () => {
    for (let i = 0; i < 40; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setImmediate(resolve); });
    }
  };
  const waitFor = async (check) => {
    for (let i = 0; i < 200; i += 1) {
      if (check()) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
    throw new Error('condition not reached');
  };
  const prompts = () => runAgent.mock.calls.map(([, trigger]) => String(trigger.payload.content));
  const done = { status: 'succeeded', runId: 'r', totalTurns: 1 };
  // Holds the first turn open until the test ends it.
  const holdFirstTurn = () => {
    let finish;
    runAgent.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    runAgent.mockResolvedValue(done);
    return () => finish(done);
  };

  beforeEach(async () => {
    await installTarget({ runtimeType: 'native' });
    runAgent.mockReset();
  });

  test('a hosted turn starts at once: there is no window before it', async () => {
    runAgent.mockResolvedValue(done);
    const startedAt = Date.now();
    await mention();
    await waitFor(() => runAgent.mock.calls.length === 1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    await flush();
  });

  test('two quick mentions cost two turns, and the second reaches its turn marked, through payload.content', async () => {
    const finishFirst = holdFirstTurn();
    const first = await mention({ content: '@codex please review the deploy' });
    await waitFor(() => runAgent.mock.calls.length === 1);
    await fromOwnAgent('@codex the failing step is the smoke check');
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(1);

    finishFirst();
    await waitFor(() => runAgent.mock.calls.length === 2);
    await flush();

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(prompts()[0]).not.toContain('smoke check');
    expect(prompts()[1]).toContain('could not see');
    expect(prompts()[1]).toContain(`message ${first.id}`);
    expect(prompts()[1]).toContain('NO_REPLY');
    expect(prompts()[1]).toContain('the failing step is the smoke check');
    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].payload.coalesced).toBeUndefined();
  });

  // A follow-up row is born claimed too, so it cannot be told from a running
  // turn and nothing joins it. Each mention is one marked turn, in order.
  test('each later mention during a turn gets its own marked turn, in order, and none is lost', async () => {
    const finishFirst = holdFirstTurn();
    await mention({ content: '@codex please review the deploy' });
    await waitFor(() => runAgent.mock.calls.length === 1);
    await fromOwnAgent('@codex first addition');
    await fromOwnAgent('@codex second addition');
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(1);

    finishFirst();
    await waitFor(() => runAgent.mock.calls.length === 3);
    await flush();

    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(prompts()[1]).toContain('first addition');
    expect(prompts()[1]).not.toContain('second addition');
    expect(prompts()[2]).toContain('second addition');
    expect(prompts()[1]).toContain('could not see');
    expect(prompts()[2]).toContain('could not see');
  });

  test('a different person during a turn is a separate turn, in order, and it knows', async () => {
    const finishFirst = holdFirstTurn();
    await mention({ content: '@codex is staging up?' });
    await waitFor(() => runAgent.mock.calls.length === 1);
    await fromBob('@codex what does the invoice say?');
    finishFirst();
    await waitFor(() => runAgent.mock.calls.length === 2);
    await flush();
    expect(prompts()[0]).not.toContain('invoice');
    expect(prompts()[1]).toContain('what does the invoice say?');
    expect(prompts()[1]).toContain('different person');
  });

  test('a mention after the turn ended is ordinary', async () => {
    runAgent.mockResolvedValue(done);
    await mention();
    await waitFor(() => runAgent.mock.calls.length === 1);
    for (let i = 0; i < 200; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if ((await targetRows())[0].status === 'acked') break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
    await fromOwnAgent('@codex a new question');
    await waitFor(() => runAgent.mock.calls.length === 2);
    await flush();
    expect(prompts()[1]).not.toContain('could not see');
  });

  // A hosted row is pending from birth when the drain or a failed routing
  // lookup kept it off the lane. Without rendering at turn start, what joined
  // it would be acked unread.
  test('a row born pending can be joined, and the turn that rescues it sees what joined', async () => {
    const seen = await AgentEvent.create({
      ...TARGET,
      podId: POD,
      type: 'chat.mention',
      status: 'pending',
      payload: {
        messageId: '60', userId: String(ALICE), username: 'alice', rawContent: 'first', content: 'first',
      },
    });
    runAgent.mockResolvedValue(done);
    await fromOwnAgent('@codex joined while it waited');
    expect((await targetRows())).toHaveLength(1);

    await AgentEvent.collection.updateOne({ _id: seen._id }, { $set: { createdAt: new Date(Date.now() - 2 * 60 * 1000) } });
    await AgentEventService.rescueStrandedPendingInProcess(new Date(), 3);
    await waitFor(() => runAgent.mock.calls.length === 1);
    await flush();
    expect(prompts()[0]).toContain('joined while it waited');
  });

  test('a row a drain or requeue returned to pending is not joined: its message gets its own turn', async () => {
    await AgentEvent.create({
      ...TARGET,
      podId: POD,
      type: 'chat.mention',
      status: 'pending',
      attempts: 1,
      payload: {
        messageId: '61', userId: String(ALICE), username: 'alice', rawContent: 'first', content: 'first',
      },
    });
    runAgent.mockResolvedValue(done);
    await fromOwnAgent('@codex after the requeue');
    await waitFor(() => runAgent.mock.calls.length === 1);
    await flush();

    const rows = await targetRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].payload.coalesced).toBeUndefined();
    expect(prompts()[0]).toContain('after the requeue');
  });
});

describe('a DM', () => {
  const DM_POD = new mongoose.Types.ObjectId();
  let id = 900;
  const dm = (content) => {
    id += 1;
    return AgentMentionService.enqueueDmEvent({
      podId: DM_POD,
      userId: ALICE,
      username: 'alice',
      message: { id: String(id), content, createdAt: new Date().toISOString() },
    });
  };
  const dmRows = () => AgentEvent.find({ ...TARGET, podId: DM_POD }).sort({ createdAt: 1 }).lean();

  beforeEach(async () => {
    await Pod.collection.insertOne({
      _id: DM_POD, name: 'dm', type: 'agent-room', createdBy: ALICE, members: [ALICE, CODEX_BOT],
    });
    await AgentInstallation.collection.insertOne({
      ...TARGET, podId: DM_POD, status: 'active', installedBy: ALICE, version: '1.0.0', config: {},
    });
  });

  test('two messages before the turn starts are one turn that sees both', async () => {
    await dm('first half of the thought');
    await dm('second half of the thought');

    expect(await dmRows()).toHaveLength(1);
    const { events: [turn] } = await AgentEventService.listInboxPage({ ...TARGET, podId: DM_POD, limit: 10 });
    expect(turn.payload.dmKind).toBe('user-agent');
    expect(turn.payload.content).toContain('first half of the thought');
    expect(turn.payload.content).toContain('second half of the thought');
  });

  test('a message during the turn still gets its own turn, marked', async () => {
    await dm('first question');
    await AgentEventService.listInboxPage({ ...TARGET, podId: DM_POD, limit: 10 });
    await dm('second question');

    const rows = await dmRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].payload.rawContent).toBe('second question');
    expect(rows[1].payload.arrivedMidTurn).toBeDefined();
    expect(rows[1].payload.dmKind).toBe('user-agent');
  });
});
