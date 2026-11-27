/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * A stalled-connect episode through every real path that touches it, against a
 * real mongod: the scan's claim and nudge (once per token, never twice), its
 * close when the seat connects, the daily digest's +24h and +7d lines with the
 * sent email's marks, the digest's choice of who to email, and the
 * waiting-owner email's read. Every outcome pinned.
 *
 * ADR-034 step 2: this file runs as it is in every store mode. By default it
 * runs in mongo. In dual or pg-read (STORE_MODE_STALLED_CONNECT_EPISODE) it
 * needs a throwaway Postgres whose default schema has run the full migration
 * set (0029 for the episodes, and the earlier ones for the messages tables the
 * digest reads), its PG_* settings, and INTEGRATION_TEST=true with MONGO_URI (a replica-set mongod):
 * without INTEGRATION_TEST the test setup removes PG_HOST. Then the same
 * assertions hold and each test also checks Postgres matches Mongo (verify)
 * at its end. pg mode is pinned at the end: the scan claims nothing.
 */
const mockSendEmail = jest.fn();
jest.mock('../../services/emailService', () => ({ sendEmail: mockSendEmail }));
const mockPost = jest.fn();
jest.mock('../../services/agentMessageService', () => ({ postMessage: (...args) => mockPost(...args) }));
// The repository reads the services go through, as call-through spies: the real
// read runs and its result flows back, and a service that queried the model
// directly again would leave its spy uncalled. Wrapped here, before the
// services load, because the digest services destructure them at require time.
// Plain wrappers, not jest.fn(impl): restoreAllMocks would drop the impl.
const mockReads = {};
jest.mock('../../repositories/stalledConnectEpisodeRepository', () => {
  const actual = jest.requireActual('../../repositories/stalledConnectEpisodeRepository');
  const wrapped = {};
  ['findExplainedEpisodes', 'findOpenEpisodesPage', 'findDueStalledEpisodes', 'findInstallerStalledEpisodes',
    'findNewestOpenEpisodes'].forEach((name) => {
    mockReads[name] = [];
    wrapped[name] = (...args) => {
      mockReads[name].push(args);
      return actual[name](...args);
    };
  });
  return { ...actual, ...wrapped };
});
const readCalls = (name) => mockReads[name];

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentEvent = require('../../models/AgentEvent');
const { AgentInstallation } = require('../../models/AgentRegistry');
const Episode = require('../../models/StalledConnectEpisode');
const { stalledConnectEpisodeStore } = require('../../repositories/stalledConnectEpisodeRepository');
const { scan, RESOLVE_PAGE_SIZE } = require('../../services/stalledConnectService');
const { DailyDigestService } = require('../../services/dailyDigestService');
const ActivityService = require('../../services/activityService');
const digestEmailService = require('../../services/digestEmailService');
const emailReturns = require('../../services/emailReturnService');
const waiting = require('../../services/waitingOwnerEmailService');

const ENV = 'STORE_MODE_STALLED_CONNECT_EPISODE';
const MODE = process.env[ENV] || 'mongo';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const ACCEPTED = { data: { data: { succeeded: 1, failed: 0, failures: [] } } };
const pgPool = () => require('../../config/db-pg').pool; // eslint-disable-line global-require
const pgRow = async (id) => (await pgPool().query(
  'SELECT status, nudge_message_id, digested_at, digested_again_at, resolved_at, pg_version'
  + ' FROM stalled_connect_episodes WHERE id = $1',
  [String(id)],
)).rows[0];

let serial = 0;
// Obviously fake people, at the reserved example.com domain.
const person = (username, extra = {}) => {
  serial += 1;
  return User.create({
    username: `${username}${serial}`, email: `stall-flow-${serial}@example.com`, password: 'not-a-login',
    verified: true, lastActive: new Date(Date.now() - 2 * 86400000), ...extra,
  });
};
const botRow = (agentName, tokens) => User.create({
  username: `${agentName}-bot`, email: `${agentName}@agents.example.com`, password: 'not-a-login',
  isBot: true, botMetadata: { agentName, instanceId: 'default' }, agentRuntimeTokens: tokens,
});

describe(`stalled-connect episodes (${MODE})`, () => {
  const originalEnv = process.env;

  beforeAll(async () => {
    await setupMongoDb();
    await Promise.all([Episode.init(), User.init(), Pod.init(), AgentInstallation.init()]);
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await Promise.all([Episode.deleteMany({}), User.deleteMany({}), Pod.deleteMany({}),
      AgentInstallation.deleteMany({}), AgentEvent.deleteMany({})]);
    if (MODE !== 'mongo') {
      await pgPool().query('TRUNCATE stalled_connect_episodes');
      // Clears the store's 5-second flag cache on an empty collection.
      await stalledConnectEpisodeStore().repair();
    }
    process.env = {
      ...originalEnv, SMTP2GO_API_KEY: 'smtp-key', SMTP2GO_FROM_EMAIL: 'hello@example.com',
      FRONTEND_URL: 'https://app.example.com', BACKEND_URL: 'https://api.example.com',
    };
    mockSendEmail.mockReset().mockResolvedValue(ACCEPTED);
    mockPost.mockReset().mockResolvedValue({ success: true, message: { id: 'm1' } });
    jest.spyOn(emailReturns, 'noteSend').mockResolvedValue(undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    Object.values(mockReads).forEach((calls) => { calls.length = 0; });
  });
  afterEach(async () => {
    process.env = originalEnv;
    jest.restoreAllMocks();
    if (MODE !== 'mongo') {
      expect(await stalledConnectEpisodeStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    }
  });

  it('the scan claims one episode per token, nudges once, and closes it when the seat connects', async () => {
    const now = new Date();
    const issued = new Date(now.getTime() - 20 * MINUTE);
    const owner = await person('dana');
    const bot = await botRow('flow-agent', [{ tokenHash: 'h1', createdAt: issued }]);
    const team = await Pod.create({ name: 'Team', type: 'chat', createdBy: owner._id, members: [owner._id, bot._id] });
    await AgentInstallation.create({
      agentName: 'flow-agent', instanceId: 'default', podId: team._id, version: '1.0.0', installedBy: owner._id,
      status: 'active', config: { runtime: { host: 'byo', runtimeType: 'local-cli' } },
    });

    const first = await scan({ now });
    expect(first.nudged).toHaveLength(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
    // The scan reads through the repository: the explained-tokens read for this
    // agent, and the open-episode sweep from the start, one page at a time.
    expect(readCalls('findExplainedEpisodes')).toEqual([[['flow-agent']]]);
    expect(readCalls('findOpenEpisodesPage')[0]).toEqual([null, RESOLVE_PAGE_SIZE]);
    const [episode] = await Episode.find({}).lean();
    expect(episode).toMatchObject({ status: 'open', nudgeMessageId: 'm1', producer: 'timer' });
    if (MODE !== 'mongo') {
      expect(await pgRow(episode._id)).toMatchObject({ status: 'open', nudge_message_id: 'm1', pg_version: 2 });
    }

    // The same token on the next pass: already explained, no second claim or post.
    const second = await scan({ now });
    expect(second.nudged).toEqual([]);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(await Episode.countDocuments({})).toBe(1);

    // The wrapper listens: the next pass keeps the nudge's promise and closes it.
    await User.updateOne({ _id: bot._id }, { $set: { 'agentRuntimeTokens.0.lastListenedAt': new Date() } });
    const third = await scan({ now: new Date() });
    expect(third.resolved).toHaveLength(1);
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost.mock.calls[1][0].metadata.kind).toBe('stalled-connect-resolved');
    const closed = await Episode.findById(episode._id).lean();
    expect(closed).toMatchObject({ status: 'resolved', resolutionMessageId: 'm1' });
    if (MODE !== 'mongo') {
      expect(await pgRow(episode._id)).toMatchObject({ status: 'resolved', pg_version: 3 });
    }
    expect((await scan({ now: new Date() })).resolved).toEqual([]);
  });

  const digestSetup = async (openedHoursAgo) => {
    const me = await person('mk');
    const pod = await Pod.create({ name: 'Launch', createdBy: me._id, members: [me._id] });
    jest.spyOn(ActivityService, 'getRecap')
      .mockResolvedValue({ pods: [{ id: String(pod._id), name: 'Launch' }], needsYou: [], agents: [], board: [] });
    const installation = await AgentInstallation.create({
      agentName: 'codex', instanceId: 'mk', podId: pod._id, version: '1.0.0', status: 'active', installedBy: me._id,
    });
    // Seeded as mongo mode would have written it before the switch; backfill copies it.
    const episode = await Episode.create({
      installationId: installation._id, podId: String(pod._id), installedBy: me._id, agentName: 'codex',
      instanceId: 'mk', displayName: 'mk codex', tokenIssuedAt: new Date(Date.now() - openedHoursAgo * HOUR - MINUTE),
      nudgedAt: new Date(Date.now() - openedHoursAgo * HOUR),
    });
    if (MODE !== 'mongo') await stalledConnectEpisodeStore().backfill({ dryRun: false });
    return { me, pod, installation, episode };
  };
  const deliver = async (me) => {
    const digest = await new DailyDigestService().generateUserDailyDigest(me._id, { requireAway: true });
    await digestEmailService.sendDigestEmails([{ success: true, digest }]);
    return digest;
  };
  const LINE = "- mk codex isn't connected yet (Launch)";

  it('the digest says the line at +24h, marks it once the email is sent, then once more at +7d', async () => {
    const { me, episode } = await digestSetup(25);
    const asked = new Date();
    expect((await DailyDigestService.stalledInstallerIds(asked)).map(String)).toEqual([String(me._id)]);
    // Who is due: the repository's read, with the cutoff 24h before the asked time.
    expect(readCalls('findDueStalledEpisodes')).toEqual([[new Date(asked.getTime() - 24 * HOUR)]]);

    expect((await deliver(me)).content).toBe(LINE);
    // The installer's lines: the repository's read, for this installer, cutoff about 24h ago.
    const [[installer, cutoff]] = readCalls('findInstallerStalledEpisodes');
    expect(String(installer)).toBe(String(me._id));
    expect(Math.abs(cutoff.getTime() - (Date.now() - 24 * HOUR))).toBeLessThan(MINUTE);
    const marked = await Episode.findById(episode._id).lean();
    expect(marked.digestedAt).toBeInstanceOf(Date);
    expect(marked.digestedAgainAt).toBeUndefined();
    if (MODE !== 'mongo') {
      expect(await pgRow(episode._id)).toMatchObject({ digested_at: marked.digestedAt, digested_again_at: null });
    }
    // The next day: already said, so quiet, and nobody is due an email for it.
    expect((await deliver(me)).metadata.totalItems).toBe(0);
    expect(await DailyDigestService.stalledInstallerIds(new Date())).toEqual([]);

    // +7d: one more line, then never again.
    await Episode.updateOne({ _id: episode._id }, { $set: { nudgedAt: new Date(Date.now() - 7 * 24 * HOUR - HOUR) } });
    if (MODE !== 'mongo') await stalledConnectEpisodeStore().backfill({ dryRun: false });
    expect((await deliver(me)).content).toBe(LINE);
    const again = await Episode.findById(episode._id).lean();
    expect(again.digestedAgainAt).toBeInstanceOf(Date);
    expect((await deliver(me)).metadata.totalItems).toBe(0);
    if (MODE !== 'mongo') {
      expect(await pgRow(episode._id)).toMatchObject({ digested_again_at: again.digestedAgainAt });
    }
  });

  it('a send that fails leaves the line unmarked for the next digest', async () => {
    const { me, episode } = await digestSetup(25);
    mockSendEmail.mockRejectedValueOnce(new Error('smtp down'));
    await deliver(me);
    expect((await Episode.findById(episode._id).lean()).digestedAt).toBeUndefined();
    expect((await deliver(me)).content).toBe(LINE);
    expect((await Episode.findById(episode._id).lean()).digestedAt).toBeInstanceOf(Date);
  });

  it('the waiting-owner email reads the newest open episode and emails its owner once', async () => {
    const { me, pod } = await digestSetup(2);
    const ana = await person('ana');
    await Pod.updateOne({ _id: pod._id }, { $push: { members: ana._id } });
    await AgentEvent.create({
      agentName: 'codex', instanceId: 'mk', podId: pod._id, type: 'chat.mention', status: 'pending',
      payload: { userId: String(ana._id), username: ana.username, content: 'hello', senderIsHuman: true },
    });
    const first = await waiting.sweepWaitingOwnerEmails({ now: new Date() });
    expect(first).toMatchObject({ scanned: 1, sent: 1 });
    // The newest open episodes, through the repository, at the sweep's 500 limit.
    expect(readCalls('findNewestOpenEpisodes')).toEqual([[500]]);
    expect(mockSendEmail.mock.calls[0][0].to).toBe(me.email);
    expect((await waiting.sweepWaitingOwnerEmails({ now: new Date() })).sent).toBe(0);
  });

  it('pg: the scan claims nothing, posts nothing and writes nothing', async () => {
    process.env[ENV] = 'pg';
    const now = new Date();
    const owner = await person('pat');
    const bot = await botRow('pg-agent', [{ tokenHash: 'p1', createdAt: new Date(now.getTime() - 20 * MINUTE) }]);
    const team = await Pod.create({ name: 'Team', type: 'chat', createdBy: owner._id, members: [owner._id, bot._id] });
    await AgentInstallation.create({
      agentName: 'pg-agent', instanceId: 'default', podId: team._id, version: '1.0.0', installedBy: owner._id,
      status: 'active', config: { runtime: { host: 'byo', runtimeType: 'local-cli' } },
    });
    await scan({ now }).catch(() => null);
    expect(mockPost).not.toHaveBeenCalled();
    expect(await Episode.countDocuments({})).toBe(0);
  });
});
