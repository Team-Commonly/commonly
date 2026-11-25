// F625 (discord routes): a failure around a call to Discord's API must not put
// the client's message in an unauthenticated response, and no route may log the
// whole error: an AxiosError carries its request config, `Authorization: Bot
// <token>` and the URL included. Each test throws such an error and checks the
// response body and everything the route logged.
const request = require('supertest');
const express = require('express');
const nacl = require('tweetnacl');
const util = require('util');

const keyPair = nacl.sign.keyPair();
process.env.DISCORD_PUBLIC_KEY = Buffer.from(keyPair.publicKey).toString('hex');

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: 'admin-user', role: 'admin' };
  req.userId = 'admin-user';
  return next();
});
jest.mock('../../../middleware/adminAuth', () => (_req, _res, next) => next());
jest.mock('../../../models/Integration', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findById: jest.fn(),
}));
jest.mock('../../../models/DiscordIntegration', () => ({ findOne: jest.fn(), findOneAndDelete: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../services/discordService', () => {
  const DiscordService = jest.fn();
  DiscordService.registerCommandsForAllIntegrations = jest.fn();
  return DiscordService;
});
jest.mock('../../../services/discordMultiCommandService', () => ({ runDiscordCommandForIntegrations: jest.fn() }));

const axios = require('axios');
const Integration = require('../../../models/Integration');
const User = require('../../../models/User');
const DiscordService = require('../../../services/discordService');
const discordRoutes = require('../../../routes/discord');

const TOKEN = 'bot-secret-token-xyz';
const LEAK = /10\.0\.0\.5|db\.internal\.example|ECONNREFUSED|:443|bot-secret-token-xyz/;

// A real AxiosError carries its request config: the Authorization header and URL.
const axiosError = () => Object.assign(
  new Error('connect ECONNREFUSED 10.0.0.5:443 via db.internal.example'),
  {
    code: 'ECONNREFUSED',
    config: {
      url: 'https://discord.com/api/v10/applications/123/commands',
      headers: { Authorization: `Bot ${TOKEN}` },
    },
  },
);

const app = express();
app.use('/api/discord/interactions', express.raw({ type: '*/*' }));
app.use('/api/discord', discordRoutes);

describe('Discord routes keep a failure out of the response and the log (F625)', () => {
  const saved = { ...process.env };
  let logged;
  const printedLog = () => logged.mock.calls
    .map((call) => call.map((arg) => util.inspect(arg, { depth: 6 })).join(' '))
    .join('\n');

  beforeEach(() => {
    process.env.DISCORD_CLIENT_ID = '123';
    process.env.DISCORD_BOT_TOKEN = TOKEN;
    logged = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  const expectCleanLog = () => {
    expect(printedLog()).not.toMatch(new RegExp(TOKEN));
    expect(printedLog()).not.toMatch(/discord\.com\/api/);
    expect(printedLog()).toMatch(/ECONNREFUSED/);
  };

  it('GET /health answers 500 with fixed text and logs no token', async () => {
    axios.get.mockRejectedValue(axiosError());
    const res = await request(app).get('/api/discord/health');
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('error');
    expect(typeof res.body.error).toBe('string');
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
    expect(JSON.stringify(res.body)).not.toMatch(/bot-secret-token-xyz/);
    expectCleanLog();
  });

  it('POST /interactions (slash command) logs no token and answers the ephemeral failure', async () => {
    Integration.find.mockReturnValue({
      populate: () => Promise.resolve([{ _id: 'row-1', podId: { name: 'Launch' }, config: {} }]),
    });
    DiscordService.mockImplementation(() => ({
      initialize: jest.fn().mockRejectedValue(axiosError()),
    }));
    const raw = JSON.stringify({
      type: 2,
      id: 'i-1',
      token: 'interaction-token',
      guild_id: '333333333333333333',
      channel_id: '444444444444444444',
      member: { user: { id: '111111111111111111' } },
      data: { type: 1, name: 'ping' },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = Buffer.from(
      nacl.sign.detached(Buffer.from(`${timestamp}${raw}`), keyPair.secretKey),
    ).toString('hex');
    const res = await request(app)
      .post('/api/discord/interactions')
      .set('Content-Type', 'application/json')
      .set('X-Signature-Ed25519', signature)
      .set('X-Signature-Timestamp', timestamp)
      .send(raw);
    expect(res.status).toBe(200);
    expect(res.body.data.content).toMatch(/error occurred/);
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
    expectCleanLog();
  });

  it('POST /register-commands/:id logs no token and answers fixed text', async () => {
    User.findById.mockResolvedValue({ _id: 'admin-user', role: 'admin' });
    Integration.findById.mockResolvedValue({
      _id: 'integration-1',
      type: 'discord',
      createdBy: { toString: () => 'admin-user' },
      config: { serverId: 'guild-1' },
    });
    DiscordService.mockImplementation(() => ({
      initialize: jest.fn().mockRejectedValue(axiosError()),
      registerSlashCommands: jest.fn(),
    }));
    const res = await request(app).post('/api/discord/register-commands/integration-1');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to register slash commands');
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
    expectCleanLog();
  });

  it('POST /register-all logs no token and returns no error text from the failure', async () => {
    DiscordService.registerCommandsForAllIntegrations.mockRejectedValue(axiosError());
    const res = await request(app).post('/api/discord/register-all');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe('string');
    expect(JSON.stringify(res.body)).not.toMatch(LEAK);
    expectCleanLog();
  });
});
