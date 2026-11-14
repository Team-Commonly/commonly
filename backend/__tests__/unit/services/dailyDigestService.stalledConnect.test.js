// F502: someone who installed an agent and never started it heard about it
// once, from the nudge in the pod. If they never came back to the pod, they
// never saw it: "+7d goes to the digest" (StalledConnectEpisode.digestedAt)
// was never built, and the digest never read episodes. Ruling (Cofounder,
// 11-14): a digest line 24h after the episode opens, a second at +7d, then
// none. No new email type; it rides the digest, and a line is used up only
// once an email carrying it was accepted.
const mockSendEmail = jest.fn();
jest.mock('../../../services/emailService', () => ({ sendEmail: mockSendEmail }));

const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const StalledConnectEpisode = require('../../../models/StalledConnectEpisode');
const { DailyDigestService } = require('../../../services/dailyDigestService');
const ActivityService = require('../../../services/activityService');
const digestEmailService = require('../../../services/digestEmailService');

const HOUR = 3600000;
const LINE = "- mk codex isn't connected yet (Launch)";
const originalEnv = process.env;
let serial = 0;
const person = async (username, lastActive = new Date(Date.now() - 2 * 86400000)) => {
  serial += 1;
  return User.create({
    username, email: `stall-${serial}@example.com`, password: 'Password123!', verified: true, lastActive,
  });
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(() => {
  process.env = { ...originalEnv, SMTP2GO_API_KEY: 'smtp-key', SMTP2GO_FROM_EMAIL: 'hello@commonly.me' };
  mockSendEmail.mockReset().mockResolvedValue({ data: { data: { succeeded: 1 } } });
});
afterEach(async () => { process.env = originalEnv; jest.restoreAllMocks(); await clearMongoDb(); });

const install = (me, pod, status = 'active') => AgentInstallation.create({
  agentName: 'codex', instanceId: 'mk', podId: pod._id, version: '1.0.0', status, installedBy: me._id,
});
const openEpisode = (me, pod, installation, openedHoursAgo, extra = {}) => StalledConnectEpisode.create({
  installationId: installation._id,
  podId: String(pod._id),
  installedBy: me._id,
  agentName: 'codex',
  instanceId: 'mk',
  displayName: 'mk codex',
  tokenIssuedAt: new Date(Date.now() - openedHoursAgo * HOUR - 60000),
  nudgedAt: new Date(Date.now() - openedHoursAgo * HOUR),
  ...extra,
});

const setup = async ({ openedHoursAgo, status = 'open', digestedAt, installer, installStatus } = {}) => {
  const me = await person('mk');
  const pod = await Pod.create({ name: 'Launch', createdBy: me._id, members: [me._id] });
  jest.spyOn(ActivityService, 'getRecap').mockResolvedValue({ pods: [{ id: String(pod._id), name: 'Launch' }], needsYou: [], agents: [], board: [] });
  const owner = installer || me;
  const installation = await install(owner, pod, installStatus);
  const episode = await openEpisode(owner, pod, installation, openedHoursAgo, { status, ...(digestedAt ? { digestedAt } : {}) });
  return { me, pod, installation, episode };
};

const digestFor = (me, requireAway = true) => new DailyDigestService().generateUserDailyDigest(me._id, { requireAway });
// The scheduled path: build the digest, then send it, which is when a line is used up.
const deliver = async (me) => {
  const digest = await digestFor(me);
  await digestEmailService.sendDigestEmails([{ success: true, digest }]);
  return digest;
};
const reload = (episode) => StalledConnectEpisode.findById(episode._id).lean();

test('an episode open 24h makes a digest line naming the agent; the email uses it up', async () => {
  const { me, episode } = await setup({ openedHoursAgo: 25 });
  const digest = await deliver(me);
  expect(digest.metadata.totalItems).toBe(1);
  expect(digest.content).toBe(LINE);
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
  expect((await reload(episode)).digestedAt).toBeTruthy();
});

test('a send that fails, or a digest never sent, leaves the line for the next digest', async () => {
  const { me, episode } = await setup({ openedHoursAgo: 25 });
  mockSendEmail.mockRejectedValueOnce(new Error('smtp down'));
  await deliver(me);
  expect((await reload(episode)).digestedAt).toBeFalsy();
  await digestFor(me);
  expect((await reload(episode)).digestedAt).toBeFalsy();
});

test('the next day it is quiet, and at +7d it comes once more, then never again', async () => {
  const { me, episode } = await setup({ openedHoursAgo: 49, digestedAt: new Date(Date.now() - 24 * HOUR) });
  expect((await deliver(me)).metadata.totalItems).toBe(0);

  await StalledConnectEpisode.updateOne({ _id: episode._id }, { $set: { nudgedAt: new Date(Date.now() - 7 * 24 * HOUR - HOUR) } });
  expect((await deliver(me)).content).toBe(LINE);
  expect((await reload(episode)).digestedAgainAt).toBeTruthy();

  expect((await deliver(me)).metadata.totalItems).toBe(0);
});

test('an episode first seen past +7d gets one line, not two', async () => {
  const { me, episode } = await setup({ openedHoursAgo: 8 * 24 });
  expect((await deliver(me)).metadata.totalItems).toBe(1);
  const after = await reload(episode);
  expect(after.digestedAt).toBeTruthy();
  expect(after.digestedAgainAt).toBeTruthy();
  expect((await deliver(me)).metadata.totalItems).toBe(0);
});

test("a resolved episode, one under 24h, someone else's, and an uninstalled agent make no line", async () => {
  expect((await digestFor((await setup({ openedHoursAgo: 30, status: 'resolved' })).me)).metadata.totalItems).toBe(0);
  await clearMongoDb();
  expect((await digestFor((await setup({ openedHoursAgo: 5 })).me)).metadata.totalItems).toBe(0);
  await clearMongoDb();
  const other = await person('other');
  expect((await digestFor((await setup({ openedHoursAgo: 30, installer: other })).me)).metadata.totalItems).toBe(0);
  await clearMongoDb();
  // The sweep can lag an uninstall; the digest reads the install itself.
  expect((await digestFor((await setup({ openedHoursAgo: 30, installStatus: 'uninstalled' })).me)).metadata.totalItems).toBe(0);
});

test('a reissued token opens a second episode, and the digest still says it once', async () => {
  const { me, pod, installation } = await setup({ openedHoursAgo: 7 * 24 + 2 });
  await StalledConnectEpisode.create({
    installationId: installation._id, podId: String(pod._id), installedBy: me._id, agentName: 'codex', instanceId: 'mk',
    displayName: 'mk codex', tokenIssuedAt: new Date(Date.now() - 26 * HOUR), nudgedAt: new Date(Date.now() - 25 * HOUR),
  });
  expect((await digestFor(me)).content).toBe(LINE);
});

test('an on-demand digest shows the line but carries no marks', async () => {
  const { me, episode } = await setup({ openedHoursAgo: 25 });
  const digest = await digestFor(me, false);
  expect(digest.content).toBe(LINE);
  expect(digest.metadata.stalledMarks).toBeUndefined();
  expect((await reload(episode)).digestedAt).toBeFalsy();
});

// The person this is for is often someone who never came back: no recent
// activity, no pod summaries. The scheduled run must still pick them up.
test('the scheduled run reaches an installer gone 8 days whose +7d line is due', async () => {
  const at = new Date(); at.setUTCHours(6, 0, 0, 0);
  const me = await person('gone', new Date(at.getTime() - 8 * 24 * HOUR));
  const pod = await Pod.create({ name: 'Launch', createdBy: me._id, members: [me._id] });
  jest.spyOn(ActivityService, 'getRecap').mockResolvedValue({ pods: [{ id: String(pod._id), name: 'Launch' }], needsYou: [], agents: [], board: [] });
  const installation = await install(me, pod);
  await StalledConnectEpisode.create({
    installationId: installation._id, podId: String(pod._id), installedBy: me._id, agentName: 'codex', instanceId: 'mk',
    displayName: 'mk codex', tokenIssuedAt: new Date(at.getTime() - 8 * 24 * HOUR), nudgedAt: new Date(at.getTime() - 8 * 24 * HOUR + HOUR),
    digestedAt: new Date(at.getTime() - 7 * 24 * HOUR),
  });
  const results = await new DailyDigestService().generateAllDailyDigests({ at });
  const mine = results.find((r) => String(r.userId) === String(me._id));
  expect(mine?.digest?.content).toBe(LINE);
});

test('an episode id from a stored digest only marks an episode still open', async () => {
  const { me, episode } = await setup({ openedHoursAgo: 25 });
  const digest = await digestFor(me);
  await StalledConnectEpisode.updateOne({ _id: episode._id }, { $set: { status: 'resolved' } });
  await digestEmailService.sendDigestEmails([{ success: true, digest }]);
  expect((await reload(episode)).digestedAt).toBeFalsy();
  expect(mongoose.isValidObjectId(digest.metadata.stalledMarks[0].episodeId)).toBe(true);
});
