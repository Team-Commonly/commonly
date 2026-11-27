// A real mongod because the claim is the round trip: `lastMcpSeenAt` written by
// the auth stamp, through each token store's own schema, and read back through
// the scan's own projection. A mock of `updateOne` can't tell whether the field
// persists, or whether the projection still carries it.
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

const mockPost = jest.fn();
jest.mock('../../services/agentMessageService', () => ({ postMessage: (...args) => mockPost(...args) }));

const { AgentInstallation } = require('../../models/AgentRegistry');
const StalledConnectEpisode = require('../../models/StalledConnectEpisode');
const AttentionItem = require('../../models/AttentionItem');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { usageStamp } = require('../../middleware/agentRuntimeAuth');
const { scan } = require('../../services/stalledConnectService');

const MINUTE = 60 * 1000;
// The real clock, because usageStamp stamps with it.
const NOW = new Date();
const ISSUED = new Date(NOW.getTime() - 20 * MINUTE);
const mcpClient = { headers: { 'user-agent': 'commonly-mcp/1.0.0' } };
const otherClient = { headers: { 'user-agent': 'node' } };

// The installer is in the pod: Activity only shows a row for a pod they can open.
const seat = async (agentName, runtimeTokens) => {
  const installer = await User.create({
    username: `${agentName}-person`, email: `${agentName}@people.test`, password: 'not-a-login',
  });
  const pod = await Pod.create({ name: `${agentName} pod`, type: 'chat', createdBy: installer._id, members: [installer._id] });
  return AgentInstallation.create({
    agentName,
    instanceId: 'default',
    podId: pod._id,
    version: '1.0.0',
    installedBy: installer._id,
    status: 'active',
    config: { runtime: { host: 'byo', runtimeType: 'local-cli' } },
    runtimeTokens,
  });
};
const rows = () => AttentionItem.find({ 'source.type': 'stalled_connect' }).sort({ _id: 1 }).lean();

const botRow = (agentName, tokens) => User.create({
  username: `${agentName}-bot`,
  email: `${agentName}@agents.test`,
  password: 'not-a-login',
  isBot: true,
  botMetadata: { agentName, instanceId: 'default' },
  agentRuntimeTokens: tokens,
});

// F666: the notice is the installer's private Needs-you row; nothing is posted.
describe('a seat that an MCP client has used gets no stalled-connect row', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await clearMongoDb();
    mockPost.mockReset();
    mockPost.mockResolvedValue({ success: true, message: { id: 'm1' } });
  });
  afterEach(() => expect(mockPost).not.toHaveBeenCalled());

  describe('an agent made on the page', () => {
    const made = { runtime: { host: 'byo', runtimeType: 'webhook', adapter: 'claude' } };
    const person = (name) => User.create({ username: name, email: `${name}@people.test`, password: 'not-a-login' });
    const row = (podId, installedBy) => AgentInstallation.create({
      agentName: 'shared-agent', instanceId: 'default', podId, version: '1.0.0', installedBy, status: 'active', config: made,
    });
    const team = (owner, bot) => Pod.create({ name: `${owner.username} team`, type: 'chat', createdBy: owner._id, members: [owner._id, bot._id] });

    it('sends its one owner to Connect', async () => {
      const owner = await person('dana');
      const bot = await botRow('shared-agent', [{ tokenHash: 'h1', createdAt: ISSUED }]);
      await row((await team(owner, bot))._id, owner._id);

      await scan({ now: NOW });
      const [notice] = await rows();
      expect(String(notice.recipientUserId)).toBe(String(owner._id));
      expect(notice.detail).toContain('press Connect');
    });

    it('keeps two installers on the command: a replacement would be refused', async () => {
      const [dana, river] = [await person('dana'), await person('river')];
      const bot = await botRow('shared-agent', [{ tokenHash: 'h1', createdAt: ISSUED }]);
      await row((await team(dana, bot))._id, dana._id);
      await row((await team(river, bot))._id, river._id);

      await scan({ now: NOW });
      const got = await rows();
      expect(got.map((row) => String(row.recipientUserId)).sort()).toEqual([String(dana._id), String(river._id)].sort());
      got.forEach((row) => expect(row.detail).toContain('its panel has the command that starts it'));
    });
  });

  it('nudges the owner, not a guest whose room row names them', async () => {
    const owner = await User.create({ username: 'dana', email: 'dana@people.test', password: 'not-a-login' });
    const guest = await User.create({ username: 'river', email: 'river@people.test', password: 'not-a-login' });
    const bot = await botRow('dana-agent', [{ tokenHash: 'h1', createdAt: ISSUED }]);
    const runtime = { runtime: { host: 'byo', runtimeType: 'local-cli' } };
    const row = (podId, installedBy) => AgentInstallation.create({
      agentName: 'dana-agent', instanceId: 'default', podId, version: '1.0.0', installedBy, status: 'active', config: runtime,
    });
    const room = await Pod.create({ name: 'Dana agent', type: 'agent-room', createdBy: guest._id, members: [guest._id, bot._id] });
    const team = await Pod.create({ name: 'Team', type: 'chat', createdBy: owner._id, members: [owner._id, bot._id] });
    await row(room._id, guest._id);
    await row(team._id, owner._id);

    const result = await scan({ now: NOW });
    const got = await rows();
    expect(got.map((row) => String(row.podId))).toEqual([String(team._id)]);
    expect(String(got[0].recipientUserId)).toBe(String(owner._id));
    expect(result.skippedGuest).toBe(1);
  });

  it('leaves an identity that declared no listener alone, and still nudges its listening twin', async () => {
    const quiet = await seat('quiet-agent', [{ tokenHash: 'hq', createdAt: ISSUED }]);
    await AgentInstallation.updateOne({ _id: quiet._id }, { $set: { 'config.runtime.listens': false } });
    await seat('loud-agent', [{ tokenHash: 'hl', createdAt: ISSUED }]);

    const result = await scan({ now: NOW });
    expect(result.skippedNoListener).toBe(1);
    const got = await rows();
    expect(got).toHaveLength(1);
    expect(got[0].title).toContain('loud-agent');
    expect(await StalledConnectEpisode.countDocuments({ agentName: 'quiet-agent' })).toBe(0);
  });

  describe('an episode opened before the install declared no listener', () => {
    it('closes on MCP use without offering a listener', async () => {
      const row = await seat('late-quiet', [{ tokenHash: 'lq', createdAt: ISSUED }]);
      await AgentInstallation.updateOne({ 'runtimeTokens.tokenHash': 'lq' }, { $set: usageStamp('runtimeTokens.$', mcpClient) });
      await scan({ now: NOW });
      expect(await StalledConnectEpisode.countDocuments({ status: 'open' })).toBe(1);
      await AgentInstallation.updateOne({ _id: row._id }, { $set: { 'config.runtime.listens': false } });

      const result = await scan({ now: NOW });
      expect(result.resolved).toHaveLength(1);
      expect(await rows()).toHaveLength(0);
    });

    it('closes quietly when it was never used, since nothing will ever start', async () => {
      const row = await seat('never-quiet', [{ tokenHash: 'nq', createdAt: ISSUED }]);
      await scan({ now: NOW });
      expect(await rows()).toHaveLength(1);
      await AgentInstallation.updateOne({ _id: row._id }, { $set: { 'config.runtime.listens': false } });

      const result = await scan({ now: NOW });
      expect(result.resolved).toHaveLength(1);
      expect(await StalledConnectEpisode.countDocuments({ status: 'open' })).toBe(0);
      // Closed, and not as acted on: nobody started it.
      const [closed] = await rows();
      expect(closed.status).toBe('resolved');
      expect(closed.resolvedBy).toBeUndefined();
    });
  });

  it('tells one person about one token once, across their pod and their room', async () => {
    const owner = await User.create({ username: 'ori', email: 'ori@people.test', password: 'not-a-login' });
    const bot = await botRow('ori-agent', [{ tokenHash: 'h1', createdAt: ISSUED }]);
    const row = (podId) => AgentInstallation.create({
      agentName: 'ori-agent', instanceId: 'default', podId, version: '1.0.0', installedBy: owner._id, status: 'active',
      config: { runtime: { host: 'byo', runtimeType: 'local-cli' } },
    });
    const team = await Pod.create({ name: 'Team', type: 'chat', createdBy: owner._id, members: [owner._id, bot._id] });
    const room = await Pod.create({ name: 'Ori agent', type: 'agent-room', createdBy: owner._id, members: [owner._id, bot._id] });
    await row(team._id);
    await row(room._id);

    const first = await scan({ now: NOW });
    expect((await rows()).map((r) => String(r.podId))).toEqual([String(team._id)]);
    expect(first.skippedSameToken).toBe(1);

    await scan({ now: NOW });
    expect(await rows()).toHaveLength(1);
    expect(await StalledConnectEpisode.countDocuments({})).toBe(1);
  });

  describe('a sibling install still gets a row when the first did not reach them', () => {
    let owner;
    let team;
    let room;
    const row = (podId) => AgentInstallation.create({
      agentName: 'sol-agent', instanceId: 'default', podId, version: '1.0.0', installedBy: owner._id, status: 'active',
      config: { runtime: { host: 'byo', runtimeType: 'local-cli' } },
    });
    const postedTo = async () => (await rows()).map((r) => String(r.podId));

    beforeEach(async () => {
      owner = await User.create({ username: 'sol', email: 'sol@people.test', password: 'not-a-login' });
      const bot = await botRow('sol-agent', [{ tokenHash: 'h1', createdAt: ISSUED }]);
      team = await Pod.create({ name: 'Team', type: 'chat', createdBy: owner._id, members: [owner._id, bot._id] });
      room = await Pod.create({ name: 'Sol agent', type: 'agent-room', createdBy: owner._id, members: [owner._id, bot._id] });
      await row(team._id);
      await row(room._id);
    });

    it('they were not in the first pod', async () => {
      await Pod.updateOne({ _id: team._id }, { $pull: { members: owner._id } });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await scan({ now: NOW });
      warn.mockRestore();
      expect(await postedTo()).toEqual([String(room._id)]);
    });

    it('the row that heard it was uninstalled', async () => {
      // A second team pod: with only a room left, the owner reads as a guest.
      const other = await Pod.create({ name: 'Other', type: 'chat', createdBy: owner._id, members: [owner._id] });
      await AgentInstallation.updateOne({ podId: room._id }, { $set: { status: 'uninstalled' } });
      await row(other._id);
      await scan({ now: NOW });
      await AgentInstallation.updateOne({ podId: team._id }, { $set: { status: 'uninstalled' } });
      await scan({ now: NOW });
      expect(await postedTo()).toEqual([String(team._id), String(other._id)]);
    });

    it('they have left the pod that heard it', async () => {
      await scan({ now: NOW });
      await Pod.updateOne({ _id: team._id }, { $pull: { members: owner._id } });
      await scan({ now: NOW });
      expect(await postedTo()).toEqual([String(team._id), String(room._id)]);
    });
  });

  it('a reissued token opens a second episode on the same row', async () => {
    const owner = await User.create({ username: 'ivy', email: 'ivy@people.test', password: 'not-a-login' });
    const bot = await botRow('ivy-agent', [{ tokenHash: 'h1', createdAt: ISSUED }]);
    const pod = await Pod.create({ name: 'Ivy', type: 'chat', createdBy: owner._id, members: [owner._id, bot._id] });
    await AgentInstallation.create({
      agentName: 'ivy-agent', instanceId: 'default', podId: pod._id, version: '1.0.0', installedBy: owner._id, status: 'active',
      config: { runtime: { host: 'byo', runtimeType: 'local-cli' } },
    });
    const first = await scan({ now: NOW });
    await User.updateOne({ _id: bot._id }, {
      $set: { agentRuntimeTokens: [{ tokenHash: 'h2', createdAt: new Date(ISSUED.getTime() + MINUTE) }] },
    });
    const second = await scan({ now: NOW });
    expect(first.nudged).toHaveLength(1);
    expect(second.nudged).toHaveLength(1);
    expect(await StalledConnectEpisode.countDocuments({})).toBe(2);
    expect(await rows()).toHaveLength(1);
  });

  const expectMcpClose = async () => {
    const first = await scan({ now: NOW });
    expect(first.nudged).toEqual([]);
    expect(await rows()).toHaveLength(0);
    expect(await StalledConnectEpisode.countDocuments({ status: 'open' })).toBe(1);

    const second = await scan({ now: NOW });
    expect(second.resolved).toHaveLength(1);
    expect(await StalledConnectEpisode.countDocuments({ status: 'open' })).toBe(0);

    const third = await scan({ now: NOW });
    expect(third.resolved).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  };

  it('a stamp on the installation token, read through the scan', async () => {
    await seat('mcp-install', [{ tokenHash: 'a', createdAt: ISSUED }]);
    await AgentInstallation.updateOne(
      { 'runtimeTokens.tokenHash': 'a' },
      { $set: usageStamp('runtimeTokens.$', mcpClient) },
    );

    await expectMcpClose();
  });

  it('a stamp on the bot row token, read through the scan', async () => {
    await seat('mcp-user', []);
    await botRow('mcp-user', [{ tokenHash: 'b', createdAt: ISSUED }]);
    await User.updateOne(
      { 'agentRuntimeTokens.tokenHash': 'b' },
      { $set: usageStamp('agentRuntimeTokens.$', mcpClient) },
    );

    await expectMcpClose();
  });

  it('another client using the token still gets the row', async () => {
    await seat('not-mcp', [{ tokenHash: 'c', createdAt: ISSUED }]);
    await AgentInstallation.updateOne(
      { 'runtimeTokens.tokenHash': 'c' },
      { $set: usageStamp('runtimeTokens.$', otherClient) },
    );

    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it('an MCP call on a superseded token does not stop the new token\'s row', async () => {
    const older = new Date(ISSUED.getTime() - 60 * MINUTE);
    await seat('reissued', [
      { tokenHash: 'old', createdAt: older },
      { tokenHash: 'new', createdAt: ISSUED },
    ]);
    await AgentInstallation.updateOne(
      { 'runtimeTokens.tokenHash': 'old' },
      { $set: usageStamp('runtimeTokens.$', mcpClient) },
    );

    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(1);
  });
});
