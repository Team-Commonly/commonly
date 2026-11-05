// F133 (D249): the Discord bridge commands /mode /status /mute /unmute /tldr
// /summary /help, through the signed HTTP interactions endpoint and the shared
// chat-relay core. Every accepted request here is signed with a real Ed25519
// key, the way Discord signs them.
const request = require('supertest');
const express = require('express');
const nacl = require('tweetnacl');

const keyPair = nacl.sign.keyPair();
process.env.DISCORD_PUBLIC_KEY = Buffer.from(keyPair.publicKey).toString('hex');
process.env.DISCORD_APPLICATION_ID = 'app-1';

// A Mongo stand-in that honours the query it is given: equality on dotted
// paths and `$exists: false`. The binding check is then tested against a
// query that really filters, not a mock that returns whatever it is told.
const mockRows = [];
const mockGet = (doc, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), doc);
const mockMatches = (doc, query) => Object.entries(query).every(([path, want]) => {
  const have = mockGet(doc, path);
  if (want && typeof want === 'object' && '$exists' in want) return want.$exists ? have !== undefined : have === undefined;
  return have === want;
});
jest.mock('../../../models/Integration', () => ({
  find: jest.fn((query) => ({ lean: () => Promise.resolve(mockRows.filter((row) => mockMatches(row, query))) })),
  findOne: jest.fn(),
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../models/DiscordIntegration', () => ({}));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
const User = require('../../../models/User');
jest.mock('../../../models/Pod', () => {
  const pod = { _id: 'pod-1', name: 'Launch', createdBy: 'user-owner', members: ['user-owner'] };
  return {
    findById: jest.fn(() => ({
      select: () => ({ lean: () => Promise.resolve(pod) }),
      lean: () => Promise.resolve(pod),
    })),
    find: jest.fn(),
  };
});
jest.mock('../../../models/Summary', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/discordService', () => jest.fn());
jest.mock('../../../services/discordMultiCommandService', () => ({
  ...jest.requireActual('../../../services/discordMultiCommandService'),
  runCommandForIntegration: jest.fn(),
}));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn().mockResolvedValue({}) }));

const axios = require('axios');
const Integration = require('../../../models/Integration');
const Summary = require('../../../models/Summary');
const { runCommandForIntegration } = require('../../../services/discordMultiCommandService');
const discordRoutes = require('../../../routes/discord');

const app = express();
app.use('/api/discord/interactions', express.raw({ type: '*/*' }));
app.use('/api/discord', discordRoutes);

const INSTALLER = '111111111111111111';
const STRANGER = '222222222222222222';
const GUILD = '333333333333333333';
const CHANNEL = '444444444444444444';
const OTHER_CHANNEL = '555555555555555555';

const row = (config = {}) => ({
  _id: 'row-1',
  type: 'discord',
  isActive: true,
  status: 'connected',
  podId: 'pod-1',
  createdBy: 'user-owner',
  config: {
    serverId: GUILD,
    channelId: CHANNEL,
    discordUserId: INSTALLER,
    linkedUserId: 'user-owner',
    liveRelay: true,
    ...config,
  },
});

const send = (body, { secretKey = keyPair.secretKey } = {}) => {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(`${timestamp}${raw}`), secretKey)).toString('hex');
  return request(app)
    .post('/api/discord/interactions')
    .set('Content-Type', 'application/json')
    .set('X-Signature-Ed25519', signature)
    .set('X-Signature-Timestamp', timestamp)
    .send(raw);
};

const command = (name, { actor = INSTALLER, channel = CHANNEL, guild = GUILD, options } = {}) => send({
  type: 2,
  id: 'interaction-1',
  token: 'interaction-token',
  application_id: 'app-1',
  guild_id: guild,
  channel_id: channel,
  member: { user: { id: actor } },
  data: { type: 1, name, ...(options ? { options } : {}) },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRows.length = 0;
  mockRows.push(row());
  // The pod's creator: the bind rule /tldr re-checks (F143) passes for them.
  User.findById.mockResolvedValue({ _id: 'user-owner', role: 'user' });
});

describe('who may change settings', () => {
  test.each([['mirror', true], ['attention', false]])('the installer sets /mode %s on the row', async (mode, flag) => {
    const res = await command('mode', { options: [{ name: 'mode', value: mode }] });
    expect(res.status).toBe(200);
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith('row-1', {
      $set: { 'config.relayAllAgentMessages': flag },
    });
    expect(res.body.type).toBe(4);
    expect(res.body.data.flags).toBe(64);
    expect(res.body.data.content).toContain(`**${mode}**`);
  });

  test('someone else in the channel is refused, ephemerally, and told who can change it', async () => {
    const res = await command('mode', { actor: STRANGER, options: [{ name: 'mode', value: 'mirror' }] });
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(res.body.data.flags).toBe(64);
    expect(res.body.data.content).toContain(`<@${INSTALLER}>`);
    // The refusal names the installer without pinging them.
    expect(res.body.data.allowed_mentions).toEqual({ parse: [] });
  });

  test('/mute and /unmute from someone else are refused too', async () => {
    const mute = await command('mute', { actor: STRANGER, options: [{ name: 'duration', value: '30m' }] });
    const unmute = await command('unmute', { actor: STRANGER });
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(mute.body.data.content).toContain('can change its relay settings');
    expect(unmute.body.data.content).toContain('can change its relay settings');
  });

  test('a row with no proven Discord account admits no one', async () => {
    mockRows[0] = row({ discordUserId: undefined });
    const res = await command('mode', { options: [{ name: 'mode', value: 'mirror' }] });
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(res.body.data.content).toContain("doesn't record their Discord account");
  });

  test('/mode with no choice is a read, open to anyone', async () => {
    mockRows[0] = row({ relayAllAgentMessages: true });
    const res = await command('mode', { actor: STRANGER });
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(res.body.data.content).toContain('Relay mode: **mirror**');
  });
});

describe('/mute and /unmute', () => {
  test('/mute 30m sets relayMutedUntil thirty minutes out', async () => {
    const before = Date.now();
    const res = await command('mute', { options: [{ name: 'duration', value: '30m' }] });
    const [[id, update]] = Integration.findByIdAndUpdate.mock.calls;
    expect(id).toBe('row-1');
    const until = update.$set['config.relayMutedUntil'].getTime();
    expect(until).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    expect(res.body.data.content).toContain('Muted for 30 min');
    expect(res.body.data.flags).toBe(64);
  });

  test('/unmute clears relayMutedUntil', async () => {
    await command('unmute');
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith('row-1', { $unset: { 'config.relayMutedUntil': '' } });
  });
});

test('/status reports mode, mute and relay state, to anyone, ephemerally', async () => {
  const until = new Date(Date.now() + 45 * 60_000);
  mockRows[0] = row({ relayAllAgentMessages: true, relayMutedUntil: until, leadAgentUsername: 'nova' });
  const res = await command('status', { actor: STRANGER });
  expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  expect(res.body.data.flags).toBe(64);
  expect(res.body.data.content).toContain('Pod: **Launch**');
  expect(res.body.data.content).toContain('Mode: **mirror**');
  expect(res.body.data.content).toContain('Relay: on');
  expect(res.body.data.content).toContain(`muted until <t:${Math.floor(until.getTime() / 1000)}:t>`);
  expect(res.body.data.content).toContain('Lead agent: nova');
});

test('/status says when relay is on but the connection is not', async () => {
  mockRows[0] = { ...row(), status: 'disconnected' };
  const res = await command('status');
  expect(res.body.data.content).toContain('Relay: on, but the connection is disconnected');
});

describe('channel binding', () => {
  test.each([
    ['another channel in the same guild', { channel: OTHER_CHANNEL }],
    ['the same channel id under another guild', { guild: '666666666666666666' }],
  ])('a command from %s is refused and changes nothing', async (_label, where) => {
    const res = await command('mode', { ...where, options: [{ name: 'mode', value: 'mirror' }] });
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(res.body.data.flags).toBe(64);
    expect(res.body.data.content).toContain("isn't connected to a Commonly pod");
  });

  test('/tldr in an unbound channel posts nothing', async () => {
    Summary.findOne.mockReturnValue({ sort: () => Promise.resolve({ title: 'T', content: 'secret pod text' }) });
    const res = await command('tldr', { channel: OTHER_CHANNEL });
    expect(res.body.data.flags).toBe(64);
    expect(res.body.data.content).not.toContain('secret pod text');
  });
});

test('a bad signature gets 401 before anything is read', async () => {
  const res = await send({
    type: 2, guild_id: GUILD, channel_id: CHANNEL, member: { user: { id: INSTALLER } }, data: { type: 1, name: 'mode' },
  }, { secretKey: nacl.sign.keyPair().secretKey });
  expect(res.status).toBe(401);
  expect(Integration.find).not.toHaveBeenCalled();
});

test('PING is answered with PONG', async () => {
  const res = await send({ type: 1 });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ type: 1 });
});

test('/tldr from a row the pod creator did not bind is refused, ephemerally', async () => {
  User.findById.mockResolvedValue({ _id: 'user-member', role: 'user' });
  mockRows[0] = { ...row(), createdBy: 'user-member' };
  Summary.findOne.mockReturnValue({ sort: () => Promise.resolve({ title: 'T', content: 'pod text' }) });
  const res = await command('tldr');
  expect(res.body.data.flags).toBe(64);
  expect(res.body.data.content).toContain("Only the pod's creator can share");
});

test('/tldr in the bound channel posts the summary publicly, with no mentions and escaped markdown', async () => {
  Summary.findOne.mockReturnValue({
    sort: () => Promise.resolve({ title: 'Week **one**', content: 'Ship it @everyone, see [x](https://evil)' }),
  });
  const res = await command('tldr', { actor: STRANGER });
  expect(res.body.type).toBe(4);
  expect(res.body.data.flags).toBe(0);
  expect(res.body.data.allowed_mentions).toEqual({ parse: [] });
  expect(res.body.data.content).toContain('**Week \\*\\*one\\*\\***');
  expect(res.body.data.content).not.toMatch(/@everyone/);
  expect(res.body.data.content).toContain('\\[x\\]\\(https://evil\\)');
  expect(res.body.data.content.length).toBeLessThanOrEqual(2000);
});

test('/summary defers, then edits the reply with the result', async () => {
  mockRows[0] = row({ webhookListenerEnabled: true });
  runCommandForIntegration.mockResolvedValue({ result: { success: true, content: '✅ Queued 4 Discord message(s).' } });
  const res = await command('summary', { actor: STRANGER });
  expect(res.body).toEqual({ type: 5, data: { flags: 64 } });
  await new Promise((resolve) => { setImmediate(resolve); });
  await new Promise((resolve) => { setImmediate(resolve); });
  expect(runCommandForIntegration).toHaveBeenCalledWith(expect.objectContaining({ commandName: 'discord-push' }));
  expect(axios.patch).toHaveBeenCalledWith(
    'https://discord.com/api/v10/webhooks/app-1/interaction-token/messages/@original',
    { content: '✅ Queued 4 Discord message(s).', allowed_mentions: { parse: [] } },
    expect.any(Object),
  );
});

test('/help answers anywhere, ephemerally', async () => {
  const res = await command('help', { channel: OTHER_CHANNEL });
  expect(res.body.data.flags).toBe(64);
  expect(res.body.data.content).toContain('/mode');
  expect(res.body.data.content).toContain('/tldr');
});
