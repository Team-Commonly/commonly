// Scout's welcome "Run an agent here" runs in place (TASK-290). Two properties
// are pinned here, both on real models:
//   (1) the action survives only on the person's own welcome, decided by its
//       AUTHOR (the Scout they installed in a pod they created), never by a
//       field in the message; every other copy keeps only its link;
//   (2) only that person can run it, and a second click or a second tab gets
//       the hosted agent they already hold, never a second install.
// Pod chat lives in Postgres; the one message lookup is stubbed.

const mockPgFindById = jest.fn();
jest.mock('../../../models/pg/Message', () => ({
  __esModule: true,
  default: { findById: (...args) => mockPgFindById(...args) },
}));

const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const {
  setupMongoDb, closeMongoDb, clearMongoDb, createTestUser, createTestPod,
} = require('../../utils/testUtils');
const {
  gateWelcomeHostedActions,
  resolveWelcomeHostedStart,
} = require('../../../services/welcomeHostedStart');

const HREF = '/v2/agents/byo?pod=POD&mode=hosted';
const welcomePayload = () => ({
  kind: 'starts',
  starts: [
    {
      id: 'run-hosted',
      label: 'Run an agent here',
      href: HREF,
      action: 'run-hosted',
      caps: { agentsPerUser: 1, turnsPerDay: 30 },
    },
    { id: 'connect-agent', label: 'Connect an agent I already use' },
  ],
});

const bot = (username) => createTestUser(User, {
  username, email: `${username}@agents.test`, isBot: true,
});

let owner; let member; let pod; let scoutBot; let otherBot; let otherScout;

const installScout = (podId, installedBy, instanceId) => AgentInstallation.create({
  agentName: 'scout',
  instanceId,
  podId,
  version: '1.0.0',
  status: 'active',
  installedBy,
});

const message = (overrides = {}) => ({
  id: 41,
  pod_id: String(pod._id),
  user_id: String(scoutBot._id),
  content: 'I\'m Scout.',
  payload: welcomePayload(),
  ...overrides,
});

const hostedActionOf = (m) => m.payload.starts.find((s) => s.id === 'run-hosted').action;

beforeAll(async () => { await setupMongoDb(); });
afterAll(async () => { await closeMongoDb(); });

beforeEach(async () => {
  await clearMongoDb();
  mockPgFindById.mockReset();
  owner = await createTestUser(User, { username: 'ada', email: 'ada@example.com' });
  member = await createTestUser(User, { username: 'bob', email: 'bob@example.com' });
  pod = await createTestPod(Pod, owner._id, { name: 'My Workspace', members: [owner._id, member._id] });
  // buildAgentUsername('scout', 'uada') === 'scout-uada'
  scoutBot = await bot('scout-uada');
  otherBot = await bot('helper');
  otherScout = await bot('scout-ubob');
  await installScout(pod._id, owner._id, 'uada');
});

describe('(1) the action renders only on the owner\'s own welcome', () => {
  test('keeps it on the welcome the owner\'s own Scout posted in the pod they created', async () => {
    const [out] = await gateWelcomeHostedActions([message()], pod._id, owner._id);
    expect(hostedActionOf(out)).toBe('run-hosted');
    expect(out.payload.starts[0].caps).toEqual({ agentsPerUser: 1, turnsPerDay: 30 });
  });

  test('drops it, keeping the link, when anyone else posted the same payload', async () => {
    const page = [
      message({ id: 1, user_id: String(otherBot._id) }),
      message({ id: 2, user_id: String(otherScout._id) }),
      message({ id: 3, user_id: String(owner._id) }),
      message({ id: 4, user_id: String(member._id) }),
    ];
    const out = await gateWelcomeHostedActions(page, pod._id, owner._id);
    out.forEach((m) => {
      const start = m.payload.starts.find((s) => s.id === 'run-hosted');
      expect(start.action).toBeUndefined();
      expect(start.href).toBe(HREF);
      expect(start.caps).toBeUndefined();
    });
    // The page's own objects are not modified.
    expect(hostedActionOf(page[0])).toBe('run-hosted');
  });

  test('drops it for another reader, even on the real welcome', async () => {
    const [out] = await gateWelcomeHostedActions([message()], pod._id, member._id);
    expect(hostedActionOf(out)).toBeUndefined();
    expect(out.payload.starts[0].caps).toBeUndefined();
  });

  test('drops it when the reader installed Scout but did not create the pod', async () => {
    const theirPod = await createTestPod(Pod, member._id, { name: 'Bob\'s workspace', members: [member._id, owner._id] });
    await installScout(theirPod._id, owner._id, 'uada');
    const [out] = await gateWelcomeHostedActions(
      [message({ pod_id: String(theirPod._id) })],
      theirPod._id,
      owner._id,
    );
    expect(hostedActionOf(out)).toBeUndefined();
    expect(out.payload.starts[0].caps).toBeUndefined();
  });

  test('drops it when the pod\'s Scout was installed by someone other than its creator', async () => {
    const theirPod = await createTestPod(Pod, owner._id, { name: 'Another workspace', members: [owner._id, member._id] });
    await installScout(theirPod._id, member._id, 'ubob');
    const [out] = await gateWelcomeHostedActions(
      [message({ pod_id: String(theirPod._id), user_id: String(otherScout._id) })],
      theirPod._id,
      owner._id,
    );
    expect(hostedActionOf(out)).toBeUndefined();
    expect(out.payload.starts[0].caps).toBeUndefined();
  });

  test('a page with no hosted action passes through untouched', async () => {
    const page = [{ id: 9, user_id: String(otherBot._id), payload: { kind: 'starts', starts: [{ id: 'x', label: 'x', href: HREF }] } }];
    expect(await gateWelcomeHostedActions(page, pod._id, owner._id)).toBe(page);
  });
});

describe('(2) only the owner can run it, and a repeat click gets the same agent', () => {
  test('the owner with no hosted agent gets a free name for this pod', async () => {
    mockPgFindById.mockResolvedValue(message());
    const result = await resolveWelcomeHostedStart({ messageId: '41', userId: owner._id });
    expect(result).toEqual({ podId: String(pod._id), existing: null, agentName: 'ada-agent' });
  });

  test('a second click, or one in a second tab, gets the hosted agent already held', async () => {
    await AgentInstallation.create({
      agentName: 'ada-agent',
      instanceId: 'default',
      podId: pod._id,
      version: '1.0.0',
      status: 'active',
      installedBy: owner._id,
      config: { runtime: { runtimeType: 'hosted' } },
    });
    mockPgFindById.mockResolvedValue(message());
    const result = await resolveWelcomeHostedStart({ messageId: '41', userId: owner._id });
    expect(result).toEqual({
      podId: String(pod._id),
      existing: { agentName: 'ada-agent', instanceId: 'default', podId: String(pod._id) },
      agentName: null,
    });
  });

  test.each([
    ['another member of the pod', () => ({ userId: member._id, msg: message() })],
    ['a message another agent posted', () => ({ userId: owner._id, msg: message({ user_id: String(otherBot._id) }) })],
    ['a message the owner posted', () => ({ userId: owner._id, msg: message({ user_id: String(owner._id) }) })],
    ['a start that only links (Scout\'s hosted offer)', () => ({
      userId: owner._id,
      msg: message({ payload: { kind: 'starts', starts: [{ id: 'run-hosted', label: 'Run it here', href: HREF }] } }),
    })],
    ['a message that does not exist', () => ({ userId: owner._id, msg: null })],
  ])('refuses %s', async (_label, build) => {
    const { userId, msg } = build();
    mockPgFindById.mockResolvedValue(msg);
    const result = await resolveWelcomeHostedStart({ messageId: '41', userId });
    expect(result).toEqual({ error: { status: 403, body: expect.objectContaining({ code: 'not_welcome_start' }) } });
  });

  test('a malformed message id is refused before any lookup', async () => {
    const result = await resolveWelcomeHostedStart({ messageId: { $gt: '' }, userId: owner._id });
    expect(result.error.status).toBe(400);
    expect(mockPgFindById).not.toHaveBeenCalled();
  });
});
