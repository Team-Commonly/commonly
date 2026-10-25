// A consumed wake reads its pod's whole unread digest, not only the page it
// quoted. Pinned against mongodb-memory-server.
//
// The loop this exists for (rhea, 2026-10-25): a wake claimed up to 9 digest
// companions, the seat answered NO_REPLY, the server judged the reply
// `silent_or_empty`, and both the CLI and the ack treated that as "not read".
// The requeue put the companions back, the unread-digest heartbeat fired an
// hour later, and it repeated. Even a consumed wake settled only the rows it
// had quoted, so a backlog drained 9 rows per wake, oldest first, while about
// 1,000 rows arrived per seat per day. 22,568 were pending fleet-wide.
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
jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(() => ({ runtime: 'moltbot' })),
}));
jest.mock('../../../services/nativeRuntimeService', () => ({ runAgent: jest.fn() }));

let mongod;
let AgentEvent;
let AgentEventService;

const AGENT = 'pixel';
const INSTANCE = 'default';
const POD_ID = new mongoose.Types.ObjectId();
const BACKLOG = 30;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  AgentEvent = require('../../../models/AgentEvent');
  AgentEventService = require('../../../services/agentEventService');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await AgentEvent.deleteMany({});
});

// Raw insert so each row keeps the createdAt it is given: oldest first, one
// minute apart, each in its own thread so the frame can name which it quoted.
const seedBacklog = async () => {
  const now = Date.now();
  await AgentEvent.collection.insertMany(Array.from({ length: BACKLOG }, (_, index) => ({
    agentName: AGENT,
    instanceId: INSTANCE,
    podId: POD_ID,
    type: 'message.posted',
    deliveryMode: 'digest',
    status: 'pending',
    attempts: 0,
    payload: { messageId: `m${index + 1}`, threadRootId: index + 1, content: 'ambient body' },
    createdAt: new Date(now - (BACKLOG - index) * 60000),
    updatedAt: new Date(now - (BACKLOG - index) * 60000),
  })));
};

const seedWake = () => AgentEvent.create({
  agentName: AGENT, instanceId: INSTANCE, podId: POD_ID,
  type: 'chat.mention', payload: { content: 'question' },
});

const unread = () => AgentEvent.countDocuments({
  deliveryMode: 'digest', status: { $in: ['pending', 'delivered'] },
});

// The wrapper CLI's path: one pod-scoped page, wake plus digest companions.
const claimPage = async () => {
  const page = await AgentEventService.listInboxPage({
    agentName: AGENT, instanceId: INSTANCE, podIds: [POD_ID], limit: 10,
  });
  const [wake] = page.events.filter((event) => event.deliveryMode !== 'digest');
  return { page, wake };
};

describe('a consumed wake settles the digest backlog up to its snapshot', () => {
  test.each([
    [{ outcome: 'posted' }],
    [{ outcome: 'acknowledged' }],
    [{ outcome: 'no_action' }],
    [{ outcome: 'no_action', reason: 'silent_or_empty' }],
  ])('a 30-row backlog drains in one consumed ack: %j', async (result) => {
    await seedBacklog();
    await seedWake();
    const { page, wake } = await claimPage();
    expect(page.events.filter((event) => event.deliveryMode === 'digest')).toHaveLength(9);
    expect((await AgentEvent.findById(wake._id).lean()).digestSnapshotAt).toEqual(expect.any(Date));

    await AgentEventService.acknowledge(wake._id, AGENT, INSTANCE, result, wake.deliveryNonce);
    expect(await unread()).toBe(0);
  });

  test.each([
    [{ outcome: 'no_action', reason: 'claim-held' }],
    [{ outcome: 'no_action', reason: 'duplicate_recent' }],
    [{ outcome: 'error' }],
  ])('a non-consuming outcome settles nothing: %j', async (result) => {
    await seedBacklog();
    await seedWake();
    const { wake } = await claimPage();

    await AgentEventService.acknowledge(wake._id, AGENT, INSTANCE, result, wake.deliveryNonce);
    expect(await unread()).toBe(BACKLOG);
    expect(await AgentEvent.countDocuments({ deliveryMode: 'digest', status: 'acked' })).toBe(0);
  });

  test('a row created after the snapshot stays pending', async () => {
    await seedBacklog();
    await seedWake();
    const { wake } = await claimPage();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const late = await AgentEvent.create({
      agentName: AGENT, instanceId: INSTANCE, podId: POD_ID,
      type: 'message.posted', deliveryMode: 'digest', payload: { content: 'arrived mid-turn' },
    });

    await AgentEventService.acknowledge(wake._id, AGENT, INSTANCE,
      { outcome: 'posted' }, wake.deliveryNonce);
    expect((await AgentEvent.findById(late._id).lean()).status).toBe('pending');
    expect(await unread()).toBe(1);
  });

  test('another pod\'s backlog is untouched', async () => {
    await seedBacklog();
    const otherPod = new mongoose.Types.ObjectId();
    const other = await AgentEvent.create({
      agentName: AGENT, instanceId: INSTANCE, podId: otherPod,
      type: 'message.posted', deliveryMode: 'digest', payload: { content: 'elsewhere' },
    });
    await AgentEvent.updateOne({ _id: other._id }, { $set: { createdAt: new Date(Date.now() - 3600000) } });
    await seedWake();
    const { wake } = await claimPage();

    await AgentEventService.acknowledge(wake._id, AGENT, INSTANCE,
      { outcome: 'posted' }, wake.deliveryNonce);
    expect((await AgentEvent.findById(other._id).lean()).status).toBe('pending');
  });

  test('a late companion ack after the settle is still a success', async () => {
    await seedBacklog();
    await seedWake();
    const { page, wake } = await claimPage();
    const companion = page.events.find((event) => event.deliveryMode === 'digest');

    await AgentEventService.acknowledge(wake._id, AGENT, INSTANCE,
      { outcome: 'posted' }, wake.deliveryNonce);
    expect(await AgentEventService.acknowledge(companion._id, AGENT, INSTANCE,
      { outcome: 'no_action', reason: 'digest-read' }, companion.deliveryNonce)).toBeNull();
    expect(await AgentEventService.isSupersededDelivery(
      companion._id, AGENT, INSTANCE, companion.deliveryNonce,
    )).toBe(false);
  });
});

describe('the legacy frame shows the newest rows and the true total', () => {
  test('quotes the newest 8 rows and counts every unread row', async () => {
    await seedBacklog();
    await seedWake();
    const [delivered] = await AgentEventService.list({ agentName: AGENT, instanceId: INSTANCE });
    const summary = delivered.payload.digestSummary;

    expect(summary).toContain(`${BACKLOG} ambient updates`);
    expect(summary).toContain(`older pod activity: ${BACKLOG - 8} unread`);
    expect(summary).toContain('thread 23: 1 unread');
    expect(summary).not.toContain('thread 22:');
    expect(summary).not.toContain('thread 1:');
    expect(summary).not.toContain('ambient body');

    await AgentEventService.acknowledge(delivered._id, AGENT, INSTANCE,
      { outcome: 'no_action', reason: 'silent_or_empty' }, delivered.payload.deliveryId);
    expect(await unread()).toBe(0);
  });
});

describe('a native turn settles the backlog it was shown', () => {
  const { runAgent } = require('../../../services/nativeRuntimeService');
  const { AgentInstallation } = require('../../../models/AgentRegistry');
  const nativeInstall = {
    _id: new mongoose.Types.ObjectId(),
    agentName: AGENT,
    instanceId: INSTANCE,
    podId: POD_ID,
    status: 'active',
    config: { runtime: { runtimeType: 'native' } },
  };

  afterEach(() => { jest.restoreAllMocks(); });

  const runNative = async (runResult) => {
    runAgent.mockReset();
    runAgent.mockResolvedValue(runResult);
    jest.spyOn(AgentInstallation, 'findOne').mockReturnValue({ lean: () => Promise.resolve(nativeInstall) });
    const event = await AgentEventService.enqueue({
      agentName: AGENT, instanceId: INSTANCE, podId: POD_ID, type: 'chat.mention', payload: { text: 'hi' },
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline
      && !['acked', 'failed'].includes((await AgentEvent.findById(event._id).lean()).status)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runAgent).toHaveBeenCalledTimes(1);
    return runAgent.mock.calls[0][1].payload.content;
  };

  test('a succeeded turn reads every row up to its snapshot', async () => {
    await seedBacklog();
    const content = await runNative({ status: 'succeeded', runId: 'run-1', totalTurns: 1 });
    expect(content).toContain(`${BACKLOG} ambient updates`);
    expect(await unread()).toBe(0);
  });

  test('a turn that never ran the model leaves the backlog unread', async () => {
    await seedBacklog();
    await runNative({ status: 'succeeded', runId: null, totalTurns: 0 });
    expect(await unread()).toBe(BACKLOG);
  });
});
