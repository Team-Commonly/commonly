// F503: the digest is the pull back to a shared pod, and the most basic pull
// in a two-person pod is the other person writing. The recap is agent work
// only (getUserFeed filter 'agents'), so a teammate's message never made a
// line: on 11-13 a member whose teammate had posted the night before got a
// zero-item digest and no email. Teammates' messages are now their own lines.
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const PGMessage = require('../../../models/pg/Message');
const { DailyDigestService } = require('../../../services/dailyDigestService');
const ActivityService = require('../../../services/activityService');

let serial = 0;
const person = async (username, extra = {}) => {
  serial += 1;
  return User.create({
    username, email: `teammate-${serial}@example.com`, password: 'Password123!',
    lastActive: new Date(Date.now() - 2 * 86400000), ...extra,
  });
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
afterEach(async () => { jest.restoreAllMocks(); await clearMongoDb(); });

const setup = async () => {
  const me = await person('fourth');
  const mate = await person('mk');
  const bot = await person('mk-codex', { isBot: true, botMetadata: { agentName: 'codex', instanceId: 'mk', displayName: 'mk codex' } });
  const shared = await Pod.create({ name: 'Launch', createdBy: mate._id, members: [me._id, mate._id, bot._id] });
  const hq = await Pod.create({ name: 'Commonly HQ', createdBy: mate._id, members: [me._id, mate._id], publicRead: true });
  return { me, mate, bot, shared, hq };
};

const recap = (pod) => ({ pods: [{ id: String(pod._id), name: pod.name }], needsYou: [], agents: [], board: [] });

test("a teammate's message in a shared pod is a digest line, and the digest is no longer empty", async () => {
  const { me, mate, shared } = await setup();
  jest.spyOn(ActivityService, 'getRecap').mockResolvedValue(recap(shared));
  const read = jest.spyOn(PGMessage, 'findByOthersSince').mockResolvedValue([
    { podId: String(shared._id), userId: String(mate._id), content: 'pushed the fix, can you try it?', count: 2, lastAt: new Date() },
  ]);
  const digest = await new DailyDigestService().generateUserDailyDigest(me._id, { requireAway: true });
  expect(read).toHaveBeenCalledWith([String(shared._id)], String(me._id), expect.any(Date));
  expect(digest.metadata.totalItems).toBe(1);
  expect(digest.content).toBe('- mk in Launch: pushed the fix, can you try it? (+1 more)');
  // A teammate is in it, so the subject can't say it is only agents.
  expect(digest.title).toBe('What your team did while you were away');
});

test("the recipient's own messages, an agent's and a public pod's make no line", async () => {
  const { me, bot, shared, hq } = await setup();
  jest.spyOn(ActivityService, 'getRecap').mockResolvedValue(recap(shared));
  const read = jest.spyOn(PGMessage, 'findByOthersSince').mockResolvedValue([
    { podId: String(shared._id), userId: String(bot._id), content: 'heartbeat', count: 1, lastAt: new Date() },
    { podId: String(hq._id), userId: String(me._id), content: 'mine', count: 1, lastAt: new Date() },
  ]);
  const digest = await new DailyDigestService().generateUserDailyDigest(me._id, { requireAway: true });
  // HQ is public: other people's chatter there is not the recipient's team.
  expect(read.mock.calls[0][0]).not.toContain(String(hq._id));
  expect(digest.metadata.totalItems).toBe(0);
});

test('a teammate line comes right after what waits on you, before agent work', () => {
  const lines = DailyDigestService.recapLines({
    pods: [{ id: 'p1', name: 'Launch' }],
    needsYou: [{ title: 'Approve the deploy', podId: 'p1', podName: 'Launch' }],
    agents: [{ id: 'a1', name: 'Rivet', updates: [{ podId: 'p1', podName: 'Launch', content: 'Shipped it' }] }],
    board: [],
  }, { teammateLines: ['mk in Launch: hi'] });
  expect(lines).toEqual(['Waiting on you: Approve the deploy (Launch)', 'mk in Launch: hi', 'Rivet in Launch: Shipped it']);
});

test('someone active recently gets no teammate read: they have seen it in the app', async () => {
  const me = await person('fresh', { lastActive: new Date() });
  const read = jest.spyOn(PGMessage, 'findByOthersSince').mockResolvedValue([]);
  await new DailyDigestService().generateUserDailyDigest(me._id, { requireAway: true });
  expect(read).not.toHaveBeenCalled();
});

test('a chatty agent cannot push a quiet teammate out, and the most recent writer leads', async () => {
  const { me, mate, bot, shared } = await setup();
  jest.spyOn(ActivityService, 'getRecap').mockResolvedValue(recap(shared));
  jest.spyOn(PGMessage, 'findByOthersSince').mockResolvedValue([
    { podId: String(shared._id), userId: String(bot._id), content: 'tick', count: 300, lastAt: new Date() },
    { podId: String(shared._id), userId: String(mate._id), content: 'one quiet line', count: 1, lastAt: new Date(Date.now() - 9 * 3600000) },
  ]);
  const digest = await new DailyDigestService().generateUserDailyDigest(me._id, { requireAway: true });
  expect(digest.content).toBe('- mk in Launch: one quiet line');
});

test('the teammate window opens no earlier than the reader was last here', async () => {
  const lastActive = new Date(Date.now() - 21 * 3600000);
  const me = await person('back-yesterday', { lastActive });
  const pod = await Pod.create({ name: 'Launch', createdBy: me._id, members: [me._id] });
  jest.spyOn(ActivityService, 'getRecap').mockResolvedValue(recap(pod));
  const read = jest.spyOn(PGMessage, 'findByOthersSince').mockResolvedValue([]);
  await new DailyDigestService().generateUserDailyDigest(me._id, { requireAway: true });
  expect(read.mock.calls[0][2].getTime()).toBe(lastActive.getTime());
});
