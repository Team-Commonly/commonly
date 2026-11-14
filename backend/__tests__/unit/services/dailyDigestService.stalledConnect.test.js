// F502: someone who installed an agent and never started it heard about it
// once, from the nudge in the pod. If they never came back to the pod, they
// never saw it: "+7d goes to the digest" (StalledConnectEpisode.digestedAt)
// was never built, and the digest never read episodes. Ruling (Cofounder,
// 11-14): a digest line 24h after the episode opens, a second at +7d, then
// none. No new email type; it rides the digest.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const StalledConnectEpisode = require('../../../models/StalledConnectEpisode').default
  || require('../../../models/StalledConnectEpisode');
const { DailyDigestService } = require('../../../services/dailyDigestService');
const ActivityService = require('../../../services/activityService');

const HOUR = 3600000;
let serial = 0;
const person = async (username) => {
  serial += 1;
  return User.create({
    username, email: `stall-${serial}@example.com`, password: 'Password123!',
    lastActive: new Date(Date.now() - 2 * 86400000),
  });
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
afterEach(async () => { jest.restoreAllMocks(); await clearMongoDb(); });

const setup = async ({ openedHoursAgo, status = 'open', digestedAt, digestedAgainAt, installer } = {}) => {
  const me = await person('mk');
  const pod = await Pod.create({ name: 'Launch', createdBy: me._id, members: [me._id] });
  jest.spyOn(ActivityService, 'getRecap').mockResolvedValue({ pods: [{ id: String(pod._id), name: 'Launch' }], needsYou: [], agents: [], board: [] });
  const episode = await StalledConnectEpisode.create({
    installationId: new mongoose.Types.ObjectId(),
    podId: String(pod._id),
    installedBy: (installer || me)._id,
    agentName: 'codex',
    instanceId: 'mk',
    displayName: 'mk codex',
    tokenIssuedAt: new Date(Date.now() - openedHoursAgo * HOUR - 60000),
    nudgedAt: new Date(Date.now() - openedHoursAgo * HOUR),
    status,
    ...(digestedAt ? { digestedAt } : {}),
    ...(digestedAgainAt ? { digestedAgainAt } : {}),
  });
  return { me, pod, episode };
};

const digestFor = (me, requireAway = true) => new DailyDigestService().generateUserDailyDigest(me._id, { requireAway });
const reload = (episode) => StalledConnectEpisode.findById(episode._id).lean();

test('an episode open 24h makes a digest line naming the agent, and the digest is sent', async () => {
  const { me, episode } = await setup({ openedHoursAgo: 25 });
  const digest = await digestFor(me);
  expect(digest.metadata.totalItems).toBe(1);
  expect(digest.content).toBe("- mk codex isn't connected yet (Launch)");
  expect((await reload(episode)).digestedAt).toBeTruthy();
});

test('the next day it is quiet, and at +7d it comes once more, then never again', async () => {
  const { me, episode } = await setup({ openedHoursAgo: 49, digestedAt: new Date(Date.now() - 24 * HOUR) });
  expect((await digestFor(me)).metadata.totalItems).toBe(0);

  await StalledConnectEpisode.updateOne({ _id: episode._id }, { $set: { nudgedAt: new Date(Date.now() - 7 * 24 * HOUR - HOUR) } });
  const second = await digestFor(me);
  expect(second.content).toBe("- mk codex isn't connected yet (Launch)");
  expect((await reload(episode)).digestedAgainAt).toBeTruthy();

  expect((await digestFor(me)).metadata.totalItems).toBe(0);
});

test('an episode first seen past +7d gets one line, not two', async () => {
  const { me, episode } = await setup({ openedHoursAgo: 8 * 24 });
  expect((await digestFor(me)).metadata.totalItems).toBe(1);
  const after = await reload(episode);
  expect(after.digestedAt).toBeTruthy();
  expect(after.digestedAgainAt).toBeTruthy();
  expect((await digestFor(me)).metadata.totalItems).toBe(0);
});

test('a resolved episode, one under 24h, and someone else\'s make no line', async () => {
  const resolved = await setup({ openedHoursAgo: 30, status: 'resolved' });
  expect((await digestFor(resolved.me)).metadata.totalItems).toBe(0);
  await clearMongoDb();

  const young = await setup({ openedHoursAgo: 5 });
  expect((await digestFor(young.me)).metadata.totalItems).toBe(0);
  await clearMongoDb();

  const other = await person('other');
  const theirs = await setup({ openedHoursAgo: 30, installer: other });
  expect((await digestFor(theirs.me)).metadata.totalItems).toBe(0);
});

test('an on-demand digest shows the line but does not use it up', async () => {
  const { me, episode } = await setup({ openedHoursAgo: 25 });
  expect((await digestFor(me, false)).content).toBe("- mk codex isn't connected yet (Launch)");
  expect((await reload(episode)).digestedAt).toBeFalsy();
});
