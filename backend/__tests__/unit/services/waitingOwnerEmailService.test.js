// F522: a teammate @mentions an agent that was installed and never connected.
// The mention waits in the agent's queue and nothing answers; the owner heard
// nothing until the digest's +24h line. Ruling (Cofounder, 11-14): one email
// to the owner, at most once per agent per 24h, "<teammate> is waiting on
// <agent> in <pod>", with the finish-connecting link and a return tag. F512's
// rules: written by people only, never about the owner's own mentions, and
// the digest opt-out applies.
const mockSendEmail = jest.fn();
jest.mock('../../../services/emailService', () => ({ sendEmail: mockSendEmail }));

const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const AgentEvent = require('../../../models/AgentEvent');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const StalledConnectEpisode = require('../../../models/StalledConnectEpisode');
const emailReturns = require('../../../services/emailReturnService');
const waiting = require('../../../services/waitingOwnerEmailService');

const HOUR = 3600000;
const ACCEPTED = { data: { data: { succeeded: 1, failed: 0, failures: [] } } };
const originalEnv = process.env;
let serial = 0;

const person = (username, extra = {}) => {
  serial += 1;
  return User.create({
    username, email: `${username}-${serial}@example.com`, password: 'Password123!', verified: true, ...extra,
  });
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(() => {
  process.env = {
    ...originalEnv, SMTP2GO_API_KEY: 'smtp-key', SMTP2GO_FROM_EMAIL: 'hello@commonly.me',
    FRONTEND_URL: 'https://commonly.me', BACKEND_URL: 'https://api.commonly.me',
  };
  mockSendEmail.mockReset().mockResolvedValue(ACCEPTED);
  jest.spyOn(emailReturns, 'noteSend').mockResolvedValue(undefined);
});
afterEach(async () => { process.env = originalEnv; jest.restoreAllMocks(); await clearMongoDb(); });

// The owner installed codex/mk in Launch 2h ago and never ran it; ana is a teammate.
const setup = async ({ ownerExtra = {} } = {}) => {
  const owner = await person('mk', ownerExtra);
  const ana = await person('ana');
  const pod = await Pod.create({ name: 'Launch', createdBy: owner._id, members: [owner._id, ana._id] });
  const installation = await AgentInstallation.create({
    agentName: 'codex', instanceId: 'mk', podId: pod._id, version: '1.0.0', status: 'active', installedBy: owner._id,
  });
  const episode = await StalledConnectEpisode.create({
    installationId: installation._id, podId: String(pod._id), installedBy: owner._id,
    agentName: 'codex', instanceId: 'mk', displayName: 'mk codex',
    tokenIssuedAt: new Date(Date.now() - 2 * HOUR), nudgedAt: new Date(Date.now() - 2 * HOUR + 15 * 60000),
  });
  return { owner, ana, pod, installation, episode };
};

// What a mention leaves in the agent's queue.
const mentionFrom = async (sender, pod, { at = new Date(), human = true, status = 'pending', type = 'chat.mention', agent = 'codex' } = {}) => {
  const row = await AgentEvent.create({
    agentName: agent, instanceId: 'mk', podId: pod._id, type, status,
    payload: { userId: String(sender._id), username: sender.username, content: 'private words', ...(human === null ? {} : { senderIsHuman: human }) },
  });
  await AgentEvent.collection.updateOne({ _id: row._id }, { $set: { createdAt: at } });
  return row;
};
const sweep = (now = new Date()) => waiting.sweepWaitingOwnerEmails({ now });

test('a teammate mentioning a never-connected agent emails its owner once, with the connect link and a tag', async () => {
  const { owner, ana, pod } = await setup();
  await mentionFrom(ana, pod);
  await mentionFrom(ana, pod);
  const r = await sweep();
  expect(r.sent).toBe(1);
  const mail = mockSendEmail.mock.calls[0][0];
  expect(mail.to).toBe(owner.email);
  expect(mail.subject).toBe('ana is waiting on mk codex in Launch');
  expect(mail.textBody).toContain('ana left mk codex 2 messages');
  const link = `https://commonly.me/v2/agents/byo?pod=${pod._id}&name=codex&instanceId=mk&reconnect=1&em=waiting.`;
  expect(mail.textBody).toContain(link);
  expect(mail.textBody).toContain('/api/email/unsubscribe/');
  // Who and where, never what.
  expect(mail.textBody).not.toContain('private words');
  expect(mail.htmlBody).not.toContain('private words');
  const sendId = new RegExp('em=waiting\\.([a-f0-9]{24})').exec(mail.textBody)[1];
  expect(emailReturns.noteSend).toHaveBeenCalledWith(expect.objectContaining({ sendId, kind: 'waiting', recipientUserId: owner._id }));
  // The next pass finds nothing new.
  expect((await sweep()).sent).toBe(0);
});

test('at most one email per agent per 24h, and after that only for a mention newer than the last email', async () => {
  const { ana, pod } = await setup();
  const t0 = new Date();
  await mentionFrom(ana, pod, { at: new Date(t0.getTime() - 60000) });
  expect((await sweep(t0)).sent).toBe(1);
  await mentionFrom(ana, pod, { at: new Date(t0.getTime() + HOUR) });
  expect((await sweep(new Date(t0.getTime() + 2 * HOUR))).sent).toBe(0);
  // 25h on, the +1h mention is newer than the email, so it goes; then nothing new, so quiet.
  expect((await sweep(new Date(t0.getTime() + 25 * HOUR))).sent).toBe(1);
  expect((await sweep(new Date(t0.getTime() + 50 * HOUR))).sent).toBe(0);
  expect(mockSendEmail).toHaveBeenCalledTimes(2);
});

test('only people count: agent mentions, unstamped events and the owner\'s own mentions send nothing', async () => {
  const { owner, ana, pod } = await setup();
  await mentionFrom(ana, pod, { human: false });
  await mentionFrom(ana, pod, { human: null });
  await mentionFrom(owner, pod);
  expect((await sweep()).sent).toBe(0);
});

test('delivered, older-token, other-agent and stale events are not waiting', async () => {
  const { ana, pod } = await setup();
  await mentionFrom(ana, pod, { status: 'acked' });
  await mentionFrom(ana, pod, { at: new Date(Date.now() - 3 * HOUR) }); // before the current token
  await mentionFrom(ana, pod, { agent: 'claude' });
  expect((await sweep()).sent).toBe(0);
});

test('a thread mention counts as waiting too', async () => {
  const { ana, pod } = await setup();
  await mentionFrom(ana, pod, { type: 'thread.mention' });
  expect((await sweep()).sent).toBe(1);
});

test('the digest opt-out, an unverified owner, an owner who left the pod and a removed agent send nothing', async () => {
  const optedOut = await setup({ ownerExtra: { emailPreferences: { dailyDigest: false } } });
  await mentionFrom(optedOut.ana, optedOut.pod);
  expect((await sweep()).sent).toBe(0);
  await clearMongoDb();

  const unverified = await setup({ ownerExtra: { verified: false } });
  await mentionFrom(unverified.ana, unverified.pod);
  expect((await sweep()).sent).toBe(0);
  await clearMongoDb();

  const left = await setup();
  await Pod.updateOne({ _id: left.pod._id }, { $pull: { members: left.owner._id } });
  await mentionFrom(left.ana, left.pod);
  expect((await sweep()).sent).toBe(0);
  await clearMongoDb();

  const removed = await setup();
  await AgentInstallation.updateOne({ _id: removed.installation._id }, { $set: { status: 'uninstalled' } });
  await mentionFrom(removed.ana, removed.pod);
  expect((await sweep()).sent).toBe(0);
});

test('a connected agent (episode resolved) sends nothing', async () => {
  const { ana, pod, episode } = await setup();
  await StalledConnectEpisode.updateOne({ _id: episode._id }, { $set: { status: 'resolved', resolvedAt: new Date() } });
  await mentionFrom(ana, pod);
  expect((await sweep()).sent).toBe(0);
});

test('names who is waiting: two people, then three', async () => {
  const { pod } = await setup();
  const bo = await person('bo');
  const cy = await person('cy');
  const ana = await User.findOne({ username: 'ana' });
  await mentionFrom(ana, pod, { at: new Date(Date.now() - 3 * 60000) });
  await mentionFrom(bo, pod, { at: new Date(Date.now() - 2 * 60000) });
  await sweep();
  const mail = mockSendEmail.mock.calls[0][0];
  expect(mail.subject).toBe('bo is waiting on mk codex in Launch');
  expect(mail.textBody).toContain('bo and ana left mk codex 2 messages');
  expect(waiting.whoIsWaiting(['cy', 'bo', 'ana'])).toBe('cy and 2 others');
  expect(cy).toBeTruthy();
});

test('a refused send gives the window back; a timeout keeps it', async () => {
  const { ana, pod, installation } = await setup();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  await mentionFrom(ana, pod);
  mockSendEmail.mockResolvedValueOnce({ data: { data: { succeeded: 0, failed: 1, failures: ['x'] } } });
  expect((await sweep()).failed).toBe(1);
  expect((await AgentInstallation.findById(installation._id).lean()).waitingEmailAt).toBeUndefined();
  expect(emailReturns.noteSend).not.toHaveBeenCalled();

  mockSendEmail.mockRejectedValueOnce(Object.assign(new Error('timeout of 30000ms exceeded'), { isAxiosError: true }));
  expect((await sweep()).failed).toBe(1);
  expect((await AgentInstallation.findById(installation._id).lean()).waitingEmailAt).toBeInstanceOf(Date);
  expect((await sweep()).sent).toBe(0);
});

test('two passes at once send one email', async () => {
  const { ana, pod } = await setup();
  await mentionFrom(ana, pod);
  const now = new Date();
  const [a, b] = await Promise.all([sweep(now), sweep(now)]);
  expect(a.sent + b.sent).toBe(1);
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
});

test('nothing goes when SMTP is not configured', async () => {
  const { ana, pod } = await setup();
  await mentionFrom(ana, pod);
  delete process.env.SMTP2GO_API_KEY;
  expect(await sweep()).toMatchObject({ disabled: true, sent: 0 });
  expect(mongoose.connection.readyState).toBe(1);
});
