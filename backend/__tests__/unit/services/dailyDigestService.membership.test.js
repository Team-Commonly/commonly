const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const Summary = require('../../../models/Summary');
const { DailyDigestService } = require('../../../services/dailyDigestService');
const ActivityService = require('../../../services/activityService');

let serial = 0;
const person = async (lastActive = new Date()) => {
  serial += 1;
  return User.create({
    username: `digest-member-${serial}`,
    email: `digest-member-${serial}@example.com`,
    password: 'Password123!',
    lastActive,
  });
};

const podWithSummary = async (owner, name, options = {}) => {
  const pod = await Pod.create({
    name,
    createdBy: owner._id,
    members: [owner._id, ...(options.members || []).map((member) => member._id)],
    publicRead: options.publicRead || false,
  });
  await Summary.create({
    type: 'chats',
    podId: pod._id,
    title: `${name} update`,
    content: `- Work in ${name}`,
    timeRange: { start: new Date(Date.now() - 60000), end: new Date() },
    metadata: { totalItems: 1 },
  });
  return pod;
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
afterEach(clearMongoDb);

// TASK-257 (stickiness Phase 2): the digest is "what your agents did while you
// were away", built from the activity recap (which reads Pod.members itself),
// never from chat summaries, and with no LLM step.
const recap = (overrides = {}) => ({
  pods: [{ id: 'p1', name: 'Payments API' }],
  needsYou: [],
  agents: [],
  board: [],
  ...overrides,
});

test('the digest is the recap: what waits on you, then agent work, then the board', async () => {
  const member = await person(new Date(Date.now() - 2 * 86400000));
  const spy = jest.spyOn(ActivityService, 'getRecap').mockResolvedValue(recap({
    needsYou: [{ title: 'Rivet requests approval', podName: 'Payments API' }],
    agents: [{
      name: 'Rivet',
      messageCount: 3,
      recap: 'Posted 3 updates.',
      updates: [
        { podId: 'p1', podName: 'Payments API', content: 'Opened #41: retry the webhook on 502' },
        { podId: 'p1', podName: 'Payments API', content: 'Ran the suite: green' },
        { podId: 'p1', podName: 'Payments API', content: 'Picked up TASK-7' },
      ],
    }],
    board: [{
      taskId: 'TASK-7', title: 'Fix the refund rounding', status: 'done', podName: 'Payments API',
    }],
  }));

  const digest = await new DailyDigestService().generateUserDailyDigest(member._id, { requireAway: true });

  expect(spy).toHaveBeenCalledWith(member._id, { window: 'today' });
  expect(digest.title).toBe('What your agents did while you were away');
  expect(digest.metadata.totalItems).toBe(3);
  expect(digest.content.split('\n')).toEqual([
    '- Waiting on you: Rivet requests approval (Payments API)',
    '- Rivet in Payments API: Opened #41: retry the webhook on 502 (+2 more)',
    '- TASK-7 Fix the refund rounding is done (Payments API)',
  ]);
  spy.mockRestore();
});

// Dry run, 2026-10-16: every outside recipient's only line was a support
// answer to someone else in Commonly HQ, the public pod every signup joins.
test("a public pod's agent posts and board moves stay out; what waits on you stays in", async () => {
  const member = await person(new Date(Date.now() - 2 * 86400000));
  const hq = await Pod.create({
    name: 'Commonly HQ', createdBy: member._id, members: [member._id], publicRead: true,
  });
  const spy = jest.spyOn(ActivityService, 'getRecap').mockResolvedValue(recap({
    needsYou: [{ title: 'Commonly Support mentioned you', podName: 'Commonly HQ', podId: String(hq._id) }],
    agents: [{
      name: 'Commonly Support',
      messageCount: 1,
      updates: [{ podId: String(hq._id), podName: 'Commonly HQ', content: "@someone-else Here's the path" }],
    }],
    board: [{
      taskId: 'TASK-1', title: 'Public row', status: 'done', podId: String(hq._id), podName: 'Commonly HQ',
    }],
  }));

  const digest = await new DailyDigestService().generateUserDailyDigest(member._id, { requireAway: true });

  expect(digest.content.split('\n')).toEqual(['- Waiting on you: Commonly Support mentioned you (Commonly HQ)']);
  spy.mockRestore();
});

test("Scout's welcome is not 'your agents' work': a recap of only Scout is an empty digest", async () => {
  const member = await person(new Date(Date.now() - 2 * 86400000));
  const spy = jest.spyOn(ActivityService, 'getRecap').mockResolvedValue(recap({
    agents: [{ name: 'Scout', messageCount: 1, updates: [{ podName: 'My Workspace', content: "I'm Scout." }] }],
  }));

  const digest = await new DailyDigestService().generateUserDailyDigest(member._id, { requireAway: true });

  expect(digest.metadata.totalItems).toBe(0);
  spy.mockRestore();
});

test('the scheduled run skips someone active in the last 20 hours; an on-demand digest does not', async () => {
  const member = await person(new Date());
  const spy = jest.spyOn(ActivityService, 'getRecap').mockResolvedValue(recap({
    board: [{
      taskId: 'TASK-9', title: 'Ship it', status: 'done', podName: 'Payments API',
    }],
  }));
  const service = new DailyDigestService();

  const scheduled = await service.generateUserDailyDigest(member._id, { requireAway: true });
  expect(scheduled.metadata.totalItems).toBe(0);
  expect(spy).not.toHaveBeenCalled();

  const onDemand = await service.generateUserDailyDigest(member._id);
  expect(onDemand.metadata.totalItems).toBe(1);
  expect(onDemand.title).toBe('What your agents did today');
  spy.mockRestore();
});

// Cofounder's condition on #2210: no digest may carry another pod's activity.
// Chat summaries are no longer an input at all, so another pod's summary (or
// a pod-less one) cannot reach anyone's digest.
test("a digest never carries another pod's summary: summaries are not an input", async () => {
  const member = await person(new Date(Date.now() - 2 * 86400000));
  const outsider = await person();
  await podWithSummary(member, 'Member Pod');
  const elsewhere = await Pod.create({ name: 'Private Elsewhere', createdBy: outsider._id, members: [outsider._id] });
  await Summary.create({
    type: 'posts',
    podId: elsewhere._id,
    title: 'Private Elsewhere posts',
    content: '- A private post',
    timeRange: { start: new Date(Date.now() - 60000), end: new Date() },
    metadata: { totalItems: 1 },
  });
  const spy = jest.spyOn(ActivityService, 'getRecap').mockResolvedValue(recap());

  const digest = await new DailyDigestService().generateUserDailyDigest(member._id, { requireAway: true });

  expect(digest.metadata.totalItems).toBe(0);
  expect(digest.content).not.toMatch(/Private Elsewhere|Member Pod update/);
  spy.mockRestore();
});

test('scheduler includes a member with recent pod work even after seven days away', async () => {
  const member = await person(new Date(Date.now() - 10 * 86400000));
  const creator = await person(new Date(Date.now() - 10 * 86400000));
  await podWithSummary(creator, 'Active Agent Pod', { members: [member] });
  const service = new DailyDigestService();
  const generate = jest.spyOn(service, 'generateUserDailyDigest').mockResolvedValue({ _id: 'digest-1' });

  const results = await service.generateAllDailyDigests();

  expect(generate).toHaveBeenCalledWith(member._id, { requireAway: true });
  expect(results).toHaveLength(2);
});

test('scheduler does not wake a stale member for public-read pod activity', async () => {
  const member = await person(new Date(Date.now() - 10 * 86400000));
  await podWithSummary(member, 'Public Pod', { publicRead: true });
  const service = new DailyDigestService();
  const generate = jest.spyOn(service, 'generateUserDailyDigest').mockResolvedValue({ _id: 'digest-1' });

  await service.generateAllDailyDigests();

  expect(generate).not.toHaveBeenCalled();
});

test('scheduler does not generate a digest for a bot', async () => {
  const bot = await person();
  bot.isBot = true;
  await bot.save();
  await podWithSummary(bot, 'Bot Pod');
  const service = new DailyDigestService();
  const generate = jest.spyOn(service, 'generateUserDailyDigest').mockResolvedValue({ _id: 'digest-1' });

  await service.generateAllDailyDigests();

  expect(generate).not.toHaveBeenCalled();
});
