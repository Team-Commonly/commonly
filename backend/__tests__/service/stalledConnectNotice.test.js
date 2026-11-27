// F666: the stalled-connect nudge reaches only the installer. It used to post
// into the pod as the agent, with the start command, where every member read
// it. Now the installer gets one private Activity "Needs you" row, and nothing
// is posted. A real mongod, because the claims are about rows: one per
// installation, idempotent across passes, closed when the agent connects.
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

const mockPost = jest.fn();
jest.mock('../../services/agentMessageService', () => ({ postMessage: (...args) => mockPost(...args) }));

const { AgentInstallation } = require('../../models/AgentRegistry');
const AttentionItem = require('../../models/AttentionItem');
const AttentionItemService = require('../../services/attentionItemService');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const StalledConnectEpisode = require('../../models/StalledConnectEpisode');
const { scan } = require('../../services/stalledConnectService');
const { settleInstallIntroOnFirstListen } = require('../../services/installIntroOnListen');

const MINUTE = 60 * 1000;
const NOW = new Date();
const ISSUED = new Date(NOW.getTime() - 20 * MINUTE);

const person = (name) => User.create({ username: name, email: `${name}@people.test`, password: 'not-a-login' });

const world = async ({ issuedAt = ISSUED } = {}) => {
  const installer = await person('ada');
  const member = await person('ben');
  const bot = await User.create({
    username: 'ada-agent-bot',
    email: 'ada-agent@agents.test',
    password: 'not-a-login',
    isBot: true,
    botMetadata: { agentName: 'ada-agent', instanceId: 'default', displayName: 'Ada Agent' },
    agentRuntimeTokens: [{ tokenHash: 'h1', createdAt: issuedAt }],
  });
  const pod = await Pod.create({
    name: 'Team', type: 'chat', createdBy: installer._id, members: [installer._id, member._id, bot._id],
  });
  const install = await AgentInstallation.create({
    agentName: 'ada-agent',
    instanceId: 'default',
    displayName: 'Ada Agent',
    podId: pod._id,
    version: '1.0.0',
    installedBy: installer._id,
    status: 'active',
    config: { runtime: { host: 'byo', runtimeType: 'local-cli' } },
  });
  return { installer, member, bot, pod, install };
};

describe('the stalled-connect nudge is private to the installer (F666)', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await clearMongoDb();
    mockPost.mockReset();
    mockPost.mockResolvedValue({ success: true, message: { id: 'm1' } });
  });

  it('gives the installer one Needs-you row and posts nothing as the agent', async () => {
    const { installer, pod, install } = await world();

    const result = await scan({ now: NOW });

    expect(mockPost).not.toHaveBeenCalled();
    const rows = await AttentionItem.find({}).lean();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(String(row.recipientUserId)).toBe(String(installer._id));
    expect(String(row.podId)).toBe(String(pod._id));
    expect(row.kind).toBe('blocked');
    expect(row.source).toEqual({ type: 'stalled_connect', id: String(install._id) });
    expect(row.status).toBe('open');
    expect(row.title).toContain("Ada Agent hasn't connected");
    // It points at the agent's panel; the command itself stays there.
    expect(row.detail).toContain('panel');
    expect(row.detail).not.toContain('agent run');
    expect(row.detail).not.toContain('npx');
    expect(result.nudged).toHaveLength(1);
  });

  it('gives another member of the pod nothing: no row, and no pod message to read', async () => {
    const { installer, member } = await world();

    await scan({ now: NOW });

    expect(await AttentionItem.countDocuments({ recipientUserId: member._id })).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
    // The ask still went to the person it was for.
    expect(await AttentionItem.countDocuments({ recipientUserId: installer._id })).toBe(1);
  });

  it('a later pass with the same token leaves an acknowledged row acknowledged', async () => {
    const { installer } = await world();
    await scan({ now: NOW });
    const first = await AttentionItem.findOne({}).lean();
    expect(await AttentionItemService.acknowledgeAttention(String(installer._id), String(first._id)))
      .toEqual({ success: true });

    await scan({ now: new Date(NOW.getTime() + 5 * MINUTE) });

    const rows = await AttentionItem.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]._id)).toBe(String(first._id));
    expect(rows[0].status).toBe('resolved');
    expect(rows[0].resolvedBy).toBe('acknowledged');
  });

  it('retries the notice on the next pass when the first write failed after the claim', async () => {
    const { installer } = await world();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = jest.spyOn(AttentionItemService, 'recordStalledConnect')
      .mockRejectedValueOnce(new Error('storage down'));
    try {
      await scan({ now: NOW });
      expect(await AttentionItem.countDocuments({})).toBe(0);

      await scan({ now: new Date(NOW.getTime() + 5 * MINUTE) });
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }

    const rows = await AttentionItem.find({ recipientUserId: installer._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
    expect(await StalledConnectEpisode.countDocuments({})).toBe(1);
  });

  it('keeps the episode open when closing its row fails, and closes both on the next pass', async () => {
    const { bot } = await world();
    await scan({ now: NOW });
    await User.updateOne({ _id: bot._id }, { $set: { 'agentRuntimeTokens.0.lastListenedAt': new Date() } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = jest.spyOn(AttentionItem, 'updateMany').mockRejectedValueOnce(new Error('storage down'));
    try {
      await scan({ now: new Date(NOW.getTime() + MINUTE) });
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
    expect((await StalledConnectEpisode.findOne({}).lean()).status).toBe('open');
    expect((await AttentionItem.findOne({}).lean()).status).toBe('open');

    await scan({ now: new Date(NOW.getTime() + 2 * MINUTE) });

    expect((await StalledConnectEpisode.findOne({}).lean()).status).toBe('resolved');
    const row = await AttentionItem.findOne({}).lean();
    expect(row.status).toBe('resolved');
    expect(row.resolvedBy).toBe('actioned');
  });

  it("tells a sibling install on the same token once the other install's notice closed quietly", async () => {
    const { installer, bot, install } = await world();
    const room = await Pod.create({
      name: 'Room', type: 'chat', createdBy: installer._id, members: [installer._id, bot._id],
    });
    const sibling = await AgentInstallation.create({
      agentName: 'ada-agent', instanceId: 'default', displayName: 'Ada Agent', podId: room._id,
      version: '1.0.0', installedBy: installer._id, status: 'active',
      config: { runtime: { host: 'byo', runtimeType: 'local-cli' } },
    });
    await scan({ now: NOW });
    // One notice covers both while both wait on the same listener.
    expect(await AttentionItem.countDocuments({})).toBe(1);
    const told = (await AttentionItem.findOne({}).lean()).source.id;
    const quiet = told === String(install._id) ? install : sibling;
    const other = quiet === install ? sibling : install;

    await AgentInstallation.updateOne({ _id: quiet._id }, { $set: { 'config.runtime.listens': false } });
    await scan({ now: new Date(NOW.getTime() + 5 * MINUTE) });

    const otherRow = await AttentionItem.findOne({ 'source.id': String(other._id) }).lean();
    expect(otherRow).toBeTruthy();
    expect(otherRow.status).toBe('open');
  });

  it('does not close the row as actioned when the runtime changes without a listen', async () => {
    const { install } = await world();
    await scan({ now: NOW });

    await AgentInstallation.updateOne({ _id: install._id }, { $set: { 'config.runtime': { runtimeType: 'native' } } });
    await scan({ now: new Date(NOW.getTime() + MINUTE) });

    const row = await AttentionItem.findOne({}).lean();
    expect(row.status).toBe('open');
    expect(row.resolvedBy).toBeUndefined();
    expect((await StalledConnectEpisode.findOne({}).lean()).status).toBe('open');
  });

  it('does not close a just-written row as actioned when the runtime changed before the write', async () => {
    const { install } = await world();
    const real = AttentionItemService.recordStalledConnect;
    const spy = jest.spyOn(AttentionItemService, 'recordStalledConnect').mockImplementation(async (notice) => {
      await AgentInstallation.updateOne({ _id: install._id }, { $set: { 'config.runtime': { runtimeType: 'native' } } });
      return real(notice);
    });
    try {
      await scan({ now: NOW });
    } finally {
      spy.mockRestore();
    }

    const row = await AttentionItem.findOne({}).lean();
    expect(row.status).toBe('open');
    expect(row.resolvedBy).toBeUndefined();
  });

  it("a slow pass closing an old episode leaves a reissued token's reopened row open", async () => {
    const { bot, install } = await world();
    await scan({ now: NOW });
    // The agent listened on the first token, and the slow pass reads that.
    await User.updateOne({ _id: bot._id }, { $set: { 'agentRuntimeTokens.0.lastListenedAt': new Date() } });
    const realFindById = AgentInstallation.findById.bind(AgentInstallation);
    const spy = jest.spyOn(AgentInstallation, 'findById').mockImplementationOnce((id) => ({
      lean: async () => {
        // While it decides, the key is replaced, and an overlapping pass opens
        // the new token's episode and reopens the row for it.
        await User.updateOne({ _id: bot._id }, {
          $set: { agentRuntimeTokens: [{ tokenHash: 'h2', createdAt: new Date(ISSUED.getTime() + MINUTE) }] },
        });
        await scan({ now: new Date(NOW.getTime() + 2 * MINUTE) });
        return realFindById(id).lean();
      },
    }));
    try {
      await scan({ now: new Date(NOW.getTime() + MINUTE) });
    } finally {
      spy.mockRestore();
    }

    expect(await StalledConnectEpisode.countDocuments({ installationId: install._id, status: 'open' })).toBe(1);
    const row = await AttentionItem.findOne({}).lean();
    expect(row.status).toBe('open');
  });

  it('makes no second row on a later pass', async () => {
    await world();

    await scan({ now: NOW });
    await scan({ now: new Date(NOW.getTime() + 5 * MINUTE) });

    expect(await AttentionItem.countDocuments({})).toBe(1);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('closes the row when the agent first listens, and the next pass posts nothing', async () => {
    const { bot, pod } = await world();
    await scan({ now: NOW });

    await settleInstallIntroOnFirstListen({ agentUserId: bot._id, podIds: [pod._id] });

    const row = await AttentionItem.findOne({}).lean();
    expect(row.status).toBe('resolved');
    expect(row.resolvedBy).toBe('actioned');

    // The listen lands; the scheduler closes the episode without a post.
    await User.updateOne({ _id: bot._id }, { $set: { 'agentRuntimeTokens.0.lastListenedAt': new Date() } });
    const after = await scan({ now: new Date(NOW.getTime() + MINUTE) });
    expect(after.resolved).toHaveLength(1);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('closes the row from the scheduler pass when the listen was missed by the hook', async () => {
    const { bot } = await world();
    await scan({ now: NOW });

    await User.updateOne({ _id: bot._id }, { $set: { 'agentRuntimeTokens.0.lastListenedAt': new Date() } });
    await scan({ now: new Date(NOW.getTime() + MINUTE) });

    const row = await AttentionItem.findOne({}).lean();
    expect(row.status).toBe('resolved');
    expect(row.resolvedBy).toBe('actioned');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('gives an agent that connected in time nothing, beside one that did not', async () => {
    const { installer, pod, bot } = await world();
    await User.updateOne({ _id: bot._id }, { $set: { 'agentRuntimeTokens.0.lastListenedAt': new Date(ISSUED.getTime() + MINUTE) } });
    const lateBot = await User.create({
      username: 'late-agent-bot', email: 'late-agent@agents.test', password: 'not-a-login', isBot: true,
      botMetadata: { agentName: 'late-agent', instanceId: 'default' },
      agentRuntimeTokens: [{ tokenHash: 'h9', createdAt: ISSUED }],
    });
    await Pod.updateOne({ _id: pod._id }, { $push: { members: lateBot._id } });
    const late = await AgentInstallation.create({
      agentName: 'late-agent', instanceId: 'default', podId: pod._id, version: '1.0.0',
      installedBy: installer._id, status: 'active', config: { runtime: { host: 'byo', runtimeType: 'local-cli' } },
    });

    await scan({ now: NOW });

    const rows = await AttentionItem.find({}).lean();
    expect(rows.map((row) => row.source.id)).toEqual([String(late._id)]);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('holds fire inside the patience window', async () => {
    await world({ issuedAt: new Date(NOW.getTime() - 2 * MINUTE) });

    await scan({ now: NOW });

    expect(await AttentionItem.countDocuments({})).toBe(0);
  });

  it('closes a row written just after the agent listened, when its hook ran first', async () => {
    const { bot, pod } = await world();
    // The listen lands, and its hook runs, between the pass's read and the write.
    const real = AttentionItemService.recordStalledConnect;
    const spy = jest.spyOn(AttentionItemService, 'recordStalledConnect').mockImplementation(async (notice) => {
      await User.updateOne({ _id: bot._id }, { $set: { 'agentRuntimeTokens.0.lastListenedAt': new Date() } });
      await settleInstallIntroOnFirstListen({ agentUserId: bot._id, podIds: [pod._id] });
      return real(notice);
    });

    try {
      await scan({ now: NOW });
    } finally {
      spy.mockRestore();
    }

    const row = await AttentionItem.findOne({}).lean();
    expect(row.status).toBe('resolved');
    expect(row.resolvedBy).toBe('actioned');
  });

  it('a reissue days later comes back for a since-poller past the first episode', async () => {
    const { installer, bot } = await world();
    await scan({ now: NOW });
    const first = await AttentionItem.findOne({}).lean();
    // Days pass: backdate the first episode's row, and the person handles it.
    const daysAgo = new Date(Date.now() - 3 * 24 * 60 * MINUTE);
    await AttentionItem.collection.updateOne({ _id: first._id }, {
      $set: { createdAt: daysAgo, sourceCreatedAt: daysAgo, status: 'resolved', resolvedBy: 'acknowledged' },
    });
    const cursor = new Date(Date.now() - 60 * MINUTE);

    await User.updateOne({ _id: bot._id }, {
      $set: { agentRuntimeTokens: [{ tokenHash: 'h2', createdAt: new Date(ISSUED.getTime() + MINUTE) }] },
    });
    await scan({ now: NOW });

    const queue = await AttentionItemService.getOpenQueue(String(installer._id), { since: cursor });
    expect(queue.items.map((item) => item.attentionItemId)).toEqual([String(first._id)]);
    const reopened = await AttentionItem.findById(first._id).lean();
    expect(reopened.createdAt.getTime()).toBeGreaterThan(cursor.getTime());
    expect(reopened.sourceCreatedAt.getTime()).toBeGreaterThan(cursor.getTime());
  });

  it('reopens a row in one write: a failure cannot leave it open under its old createdAt', async () => {
    const { installer, pod, install } = await world();
    await scan({ now: NOW });
    const first = await AttentionItem.findOne({}).lean();
    const daysAgo = new Date(Date.now() - 3 * 24 * 60 * MINUTE);
    await AttentionItem.collection.updateOne({ _id: first._id }, {
      $set: { createdAt: daysAgo, sourceCreatedAt: daysAgo, status: 'resolved', resolvedBy: 'acknowledged' },
    });
    const cursor = new Date(Date.now() - 60 * MINUTE);
    // Whichever write carries createdAt is the one that fails.
    const realCollectionUpdate = AttentionItem.collection.updateOne.bind(AttentionItem.collection);
    const collectionSpy = jest.spyOn(AttentionItem.collection, 'updateOne');
    collectionSpy.mockImplementation((filter, update, ...rest) => {
      if (update?.$set?.createdAt) return Promise.reject(new Error('storage down'));
      return realCollectionUpdate(filter, update, ...rest);
    });
    const realModelUpdate = AttentionItem.updateOne.bind(AttentionItem);
    const modelSpy = jest.spyOn(AttentionItem, 'updateOne').mockImplementation((filter, update, options) => {
      if (update?.$set?.createdAt) throw new Error('storage down');
      return realModelUpdate(filter, update, options);
    });
    try {
      await AttentionItemService.recordStalledConnect({
        recipientUserId: installer._id, podId: pod._id, installationId: install._id,
        episodeId: '6560f0f0f0f0f0f0f0f0f0f0', title: "Ada Agent hasn't connected", detail: 'Open its panel.',
      }).catch(() => {});
    } finally {
      collectionSpy.mockRestore();
      modelSpy.mockRestore();
    }

    const row = await AttentionItem.findById(first._id).lean();
    if (row.status === 'open') expect(row.createdAt.getTime()).toBeGreaterThan(cursor.getTime());
    else expect(row.resolvedBy).toBe('acknowledged');
  });

  it('a retry of the same episode after the row was written keeps the acknowledgement', async () => {
    const { installer } = await world();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The row is written, then recording that it was fails.
    const spy = jest.spyOn(StalledConnectEpisode, 'updateOne').mockRejectedValueOnce(new Error('storage down'));
    try {
      await scan({ now: NOW });
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
    const first = await AttentionItem.findOne({}).lean();
    expect(first.status).toBe('open');
    expect((await StalledConnectEpisode.findOne({}).lean()).noticedAt).toBeFalsy();
    expect(await AttentionItemService.acknowledgeAttention(String(installer._id), String(first._id)))
      .toEqual({ success: true });

    await scan({ now: new Date(NOW.getTime() + 5 * MINUTE) });

    const row = await AttentionItem.findById(first._id).lean();
    expect(row.status).toBe('resolved');
    expect(row.resolvedBy).toBe('acknowledged');
    // The retry finished recording the delivery.
    expect((await StalledConnectEpisode.findOne({}).lean()).noticedAt).toBeTruthy();
  });

  it('an older episode never re-tags a row a newer episode already wrote', async () => {
    const { installer, pod, install } = await world();
    const older = '6560f0f0f0f0f0f0f0f0f0f0';
    const newer = '6560f0f0f0f0f0f0f0f0f0f1';
    const notice = {
      recipientUserId: installer._id, podId: pod._id, installationId: install._id,
      title: "Ada Agent hasn't connected", detail: 'Open its panel.',
    };
    await AttentionItemService.recordStalledConnect({ ...notice, episodeId: newer });
    const first = await AttentionItem.findOne({}).lean();
    await AttentionItemService.acknowledgeAttention(String(installer._id), String(first._id));

    expect(await AttentionItemService.recordStalledConnect({ ...notice, episodeId: older }))
      .toEqual({ recorded: true });

    const row = await AttentionItem.findById(first._id).lean();
    expect(row.stalledConnectEpisodeId).toBe(newer);
    expect(row.resolvedBy).toBe('acknowledged');
    expect(await AttentionItem.countDocuments({})).toBe(1);
  });

  it('closes a notice published before an uninstall closed its episode', async () => {
    const { install } = await world();
    await scan({ now: NOW });
    expect((await AttentionItem.findOne({}).lean()).status).toBe('open');

    await AgentInstallation.updateOne({ _id: install._id }, { $set: { status: 'uninstalled' } });
    await scan({ now: new Date(NOW.getTime() + MINUTE) });

    expect((await AttentionItem.findOne({}).lean()).status).toBe('resolved');
    expect((await StalledConnectEpisode.findOne({}).lean()).status).toBe('resolved');
  });

  it('closes a notice published after its episode closed', async () => {
    const { install } = await world();
    const real = AttentionItemService.recordStalledConnect;
    // The pass claimed the episode and paused; meanwhile the agent was
    // uninstalled and another pass closed the episode.
    const spy = jest.spyOn(AttentionItemService, 'recordStalledConnect').mockImplementation(async (notice) => {
      await AgentInstallation.updateOne({ _id: install._id }, { $set: { status: 'uninstalled' } });
      await StalledConnectEpisode.updateMany({}, { $set: { status: 'resolved', resolvedAt: new Date() } });
      return real(notice);
    });
    try {
      await scan({ now: NOW });
    } finally {
      spy.mockRestore();
    }

    const rows = await AttentionItem.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('resolved');
  });

  it('closes a notice written between the close pass resolving its row and closing its episode', async () => {
    const { installer, pod, install } = await world();
    await scan({ now: NOW });
    const episode = await StalledConnectEpisode.findOne({}).lean();
    await AttentionItem.deleteMany({});
    await AgentInstallation.updateOne({ _id: install._id }, { $set: { status: 'uninstalled' } });
    const real = AttentionItemService.resolveStalledConnectEpisode;
    let wrote = false;
    const spy = jest.spyOn(AttentionItemService, 'resolveStalledConnectEpisode').mockImplementation(async (...args) => {
      await real(...args);
      if (wrote) return;
      wrote = true;
      // A slower pass that claimed this episode writes its row now, after the
      // close pass resolved the (absent) row and before it closes the episode.
      await AttentionItemService.recordStalledConnect({
        recipientUserId: installer._id, podId: pod._id, installationId: install._id,
        episodeId: episode._id, title: "Ada Agent hasn't connected", detail: 'Open its panel.',
      });
    });
    try {
      await scan({ now: new Date(NOW.getTime() + MINUTE) });
    } finally {
      spy.mockRestore();
    }

    expect((await StalledConnectEpisode.findOne({}).lean()).status).toBe('resolved');
    expect((await AttentionItem.findOne({}).lean()).status).toBe('resolved');
  });

  it('a reissued token reopens the same row, never a second one', async () => {
    const { installer, bot } = await world();
    await scan({ now: NOW });
    await AttentionItem.updateOne({}, { $set: { status: 'resolved', resolvedBy: 'acknowledged', resolvedAt: new Date() } });

    await User.updateOne({ _id: bot._id }, {
      $set: { agentRuntimeTokens: [{ tokenHash: 'h2', createdAt: new Date(ISSUED.getTime() + MINUTE) }] },
    });
    await scan({ now: NOW });

    const rows = await AttentionItem.find({ recipientUserId: installer._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
    expect(rows[0].resolvedBy).toBeUndefined();
  });
});
