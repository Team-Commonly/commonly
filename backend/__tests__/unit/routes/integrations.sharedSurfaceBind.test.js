// F143 (Cofounder, 11-04): binding a pod to a chat surface people outside the
// pod can read — a Slack channel, a Discord guild channel, a Telegram group —
// takes authority over the POD: its creator or an instance admin. A Telegram
// private chat with the bot stays member-level. POST /api/integrations and the
// PATCH retarget paths consult the one rule in services/chatRelay/bindSurface.
const request = require('supertest');
const express = require('express');

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: req.header('x-test-user') || 'member-1' };
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
  ingestIngressRateLimit: (_req, _res, next) => next(),
  ingestIntegrationsRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/DiscordIntegration', () => function DiscordIntegration(data) {
  Object.assign(this, data);
  this.save = jest.fn().mockResolvedValue(this);
});
jest.mock('../../../services/discordService', () => jest.fn());
jest.mock('../../../models/Integration', () => {
  function Integration(data) {
    Object.assign(this, data);
    this._id = this._id || 'integration-new';
    this.save = jest.fn().mockResolvedValue(this);
    Integration.created.push(this);
  }
  Integration.created = [];
  Integration.findById = jest.fn();
  Integration.findOne = jest.fn();
  Integration.findByIdAndUpdate = jest.fn();
  Integration.aggregate = jest.fn().mockResolvedValue([]);
  return Integration;
});

const axios = require('axios');
const Integration = require('../../../models/Integration');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const integrationRoutes = require('../../../routes/integrations');

const app = express();
app.use(express.json());
app.use('/api/integrations', integrationRoutes);

const CREATOR = 'creator-1';
const MEMBER = 'member-1';
const ADMIN = 'admin-1';
const POD_1 = '64b64c1f7e5b8f0a00000001';
const POD_2 = '64b64c1f7e5b8f0a00000002';
const POD_3 = '64b64c1f7e5b8f0a00000003';
const REFUSAL = 'Only the pod creator can connect a shared channel to this pod';
const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';

const pods = {
  [POD_1]: {
    _id: POD_1, type: 'chat', createdBy: CREATOR, members: [CREATOR, MEMBER, ADMIN], 
  },
  // MEMBER is a plain member of pod 2 as well; CREATOR made it.
  [POD_2]: {
    _id: POD_2, type: 'chat', createdBy: CREATOR, members: [CREATOR, MEMBER], 
  },
  // MEMBER's own pod.
  [POD_3]: {
    _id: POD_3, type: 'chat', createdBy: MEMBER, members: [MEMBER], 
  },
};
const users = {
  [CREATOR]: { _id: CREATOR, role: 'user' },
  [MEMBER]: { _id: MEMBER, role: 'user' },
  [ADMIN]: { _id: ADMIN, role: 'admin' },
};

const create = (as, body) => request(app).post('/api/integrations').set('x-test-user', as).send(body);
const patch = (as, body) => request(app)
  .patch('/api/integrations/64b64c1f7e5b8f0a12345674')
  .set('x-test-user', as)
  .send(body);

beforeEach(() => {
  jest.clearAllMocks();
  Integration.created.length = 0;
  process.env.DISCORD_BOT_TOKEN = 'bot-token';
  Pod.findById.mockImplementation(async (id) => pods[String(id)] || null);
  User.findById.mockImplementation(async (id) => users[String(id)] || null);
  Integration.findByIdAndUpdate.mockResolvedValue({ _id: 'integration-1' });
});

describe('POST /api/integrations — a shared surface needs authority over the pod', () => {
  it('refuses a plain member creating a Slack connector, and writes nothing', async () => {
    const res = await create(MEMBER, { podId: POD_1, type: 'slack', config: { channelId: 'C123' } });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe(REFUSAL);
    expect(res.body.code).toBe('shared_surface_needs_pod_authority');
    expect(Integration.created).toHaveLength(0);
  });

  it('refuses a plain member even when the body claims a Slack DM (chatType is server-owned)', async () => {
    const res = await create(MEMBER, { podId: POD_1, type: 'slack', config: { chatType: 'im', chatId: 'D1' } });

    expect(res.status).toBe(403);
    expect(Integration.created).toHaveLength(0);
  });

  it.each([
    ['the pod creator', CREATOR],
    ['an instance admin who did not create the pod', ADMIN],
  ])('lets %s create a Slack connector', async (_label, as) => {
    const res = await create(as, { podId: POD_1, type: 'slack', config: { channelId: 'C123' } });

    expect(res.status).toBe(201);
    expect(Integration.created).toHaveLength(1);
  });

  it('refuses a plain member binding a Discord channel with the one shared message, before any Discord call', async () => {
    const res = await create(MEMBER, {
      podId: POD_1, type: 'discord', config: { serverId: GUILD, channelId: CHANNEL },
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe(REFUSAL);
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(Integration.created).toHaveLength(0);
  });

  it('refuses a plain member creating a GroupMe connector, and writes nothing', async () => {
    const res = await create(MEMBER, { podId: POD_1, type: 'groupme', config: { groupId: '123', botId: 'b' } });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe(REFUSAL);
    expect(Integration.created).toHaveLength(0);
  });

  it.each([
    ['the pod creator', CREATOR],
    ['an instance admin who did not create the pod', ADMIN],
  ])('lets %s create a GroupMe connector', async (_label, as) => {
    const res = await create(as, { podId: POD_1, type: 'groupme', config: { groupId: '123', botId: 'b' } });

    expect(res.status).toBe(201);
    expect(Integration.created).toHaveLength(1);
  });

  it('lets a plain member create a Telegram connector: the chat is judged where the code is redeemed', async () => {
    const res = await create(MEMBER, { podId: POD_1, type: 'telegram', config: {} });

    expect(res.status).toBe(201);
    expect(Integration.created).toHaveLength(1);
    expect(Integration.created[0].config.connectCode).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('PATCH /api/integrations/:id — a member cannot retarget onto a shared surface', () => {
  const groupmeRow = (createdBy) => ({
    _id: 'integration-1',
    type: 'groupme',
    scope: 'pod',
    podId: POD_1,
    createdBy: { toString: () => createdBy },
    config: { toObject: () => ({ groupId: '123', botId: 'b' }) },
  });

  it.each([['groupId', '999'], ['botId', 'other-bot']])(
    'refuses a member pointing their GroupMe row at another group via %s',
    async (field, value) => {
      Integration.findById.mockResolvedValue(groupmeRow(MEMBER));

      const res = await patch(MEMBER, { config: { [field]: value } });

      expect(res.status).toBe(403);
      expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    },
  );

  it('lets the pod creator point a GroupMe row at another group', async () => {
    Integration.findById.mockResolvedValue(groupmeRow(MEMBER));

    const res = await patch(CREATOR, { config: { groupId: '999' } });

    expect(res.status).toBe(200);
  });

  const slackDmRow = (createdBy) => ({
    _id: 'integration-1',
    type: 'slack',
    scope: 'pod',
    podId: POD_1,
    createdBy: { toString: () => createdBy },
    config: { toObject: () => ({ chatType: 'im', chatId: 'D1', teamId: 'T1' }) },
  });

  it('refuses a member pointing their Slack DM row at a channel, and writes nothing', async () => {
    Integration.findById.mockResolvedValue(slackDmRow(MEMBER));

    const res = await patch(MEMBER, { config: { channelId: 'C999' } });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe(REFUSAL);
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('lets the same member change a field that is not the surface', async () => {
    Integration.findById.mockResolvedValue(slackDmRow(MEMBER));

    const res = await patch(MEMBER, { config: { relayAllAgentMessages: true } });

    expect(res.status).toBe(200);
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('lets the pod creator point a Slack row at a channel', async () => {
    Integration.findById.mockResolvedValue(slackDmRow(MEMBER));

    const res = await patch(CREATOR, { config: { channelId: 'C999' } });

    expect(res.status).toBe(200);
    const [, update] = Integration.findByIdAndUpdate.mock.calls[0];
    expect(update['config.channelId']).toBe('C999');
  });

  const userScopedTelegram = (chatType) => ({
    _id: 'integration-1',
    type: 'telegram',
    scope: 'user',
    podId: POD_1,
    createdBy: { toString: () => MEMBER },
    config: { toObject: () => ({ chatId: '-100', chatType, linkedUserId: MEMBER }) },
  });

  it('refuses a member moving a group-bound connector to another pod they did not create', async () => {
    Integration.findById.mockResolvedValue(userScopedTelegram('supergroup'));

    const res = await patch(MEMBER, { podId: POD_2 });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe(REFUSAL);
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('lets a member move their private-chat connector to another pod', async () => {
    Integration.findById.mockResolvedValue(userScopedTelegram('private'));

    const res = await patch(MEMBER, { podId: POD_2 });

    expect(res.status).toBe(200);
    const [, update] = Integration.findByIdAndUpdate.mock.calls[0];
    expect(update.podId).toBe(POD_2);
  });

  it('judges a channel retarget against the pod the row moves to, not the one it leaves', async () => {
    Integration.findById.mockResolvedValue({
      _id: 'integration-1',
      type: 'slack',
      scope: 'user',
      podId: POD_3,
      createdBy: { toString: () => MEMBER },
      config: { toObject: () => ({ chatType: 'im', chatId: 'D1', linkedUserId: MEMBER }) },
    });

    // MEMBER created POD_3, so the channel alone would pass there; POD_2 is not theirs.
    const res = await patch(MEMBER, { podId: POD_2, config: { channelId: 'C999' } });

    expect(res.status).toBe(403);
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
