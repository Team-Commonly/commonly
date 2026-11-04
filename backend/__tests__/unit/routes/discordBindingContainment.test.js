// TASK-123 (a): Discord's binding identity — the guild and channel a row is
// anchored to — must come from Discord, never from a request body or query
// string.
//
// Two refusals per site: SHAPE first (an id in a shape Discord would not accept
// must not be looked up at all), then AUTHORITY. Both are witnessed here, and so
// is the positive half at every site, because a guard that refuses everything
// passes every refusal test. The stack-order witness on the channels route has a
// behavioural counterpart in discordChannelsRateLimit.test.js, which runs the
// real limiter against real requests.
const request = require('supertest');
const express = require('express');

const MEMBER = 'user-1';
const OUTSIDER = 'user-2';
const GUILD = '123456789012345678'; // 18 digits, a valid snowflake
const OTHER_GUILD = '345678901234567890';
const CHANNEL = '234567890123456789';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const authHeader = req.header('Authorization');
  if (!authHeader) {
    return res.status(401).json({ message: 'No token, authorization denied' });
  }
  const token = authHeader.replace('Bearer ', '');
  req.user = { id: token === 'outsider-token' ? 'user-2' : 'user-1', role: 'member' };
  req.userId = req.user.id;
  return next();
});

jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

// Stubbed to a pass-through so the stack ORDER can be asserted by identity: a
// presence witness, not a behavioural one — the same instrument
// `installables.test.js` uses for its catalog route. The behavioural half is
// `discordChannelsRateLimit.test.js`. Mounted first, the limiter refuses an
// over-budget caller before `auth`'s lookups as well as this handler's two.
jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
  ingestIngressRateLimit: (_req, _res, next) => next(),
  ingestIntegrationsRateLimit: (_req, _res, next) => next(),
}));

jest.mock('../../../models/Integration', () => {
  let lastInstance = null;

  function Integration(data) {
    Object.assign(this, data);
    this._id = data._id || '6a8f6de1a1dccf2e02f31459';
    this.save = jest.fn().mockResolvedValue(this);
    lastInstance = this;
  }

  Integration.findById = jest.fn();
  Integration.findOne = jest.fn();
  Integration.findByIdAndUpdate = jest.fn();
  Integration.__getLastInstance = () => lastInstance;

  return Integration;
});

jest.mock('../../../models/DiscordIntegration', () => {
  function DiscordIntegration(data) {
    Object.assign(this, data);
    this.save = jest.fn().mockResolvedValue(this);
  }
  DiscordIntegration.findOne = jest.fn();
  DiscordIntegration.findOneAndDelete = jest.fn();
  return DiscordIntegration;
});

jest.mock('../../../models/Pod', () => ({
  find: jest.fn(),
  findById: jest.fn(),
}));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../services/discordService', () => {
  const DiscordService = jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(true),
    connect: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue(true),
    registerSlashCommands: jest.fn().mockResolvedValue(true),
  }));
  DiscordService.registerCommandsForAllIntegrations = jest.fn().mockResolvedValue({ success: true });
  return DiscordService;
});

jest.mock('../../../services/discordMultiCommandService', () => ({
  runDiscordCommandForIntegrations: jest.fn(),
}));

// The create path encrypts the webhook URL. This suite is about binding
// containment, not the envelope, so the envelope is stubbed here — leaving it
// real would have the route await a Mongo write against no connection (the
// suites that own that behaviour are integration.discordTokenCopy and the
// connectorSecrets unit file).
jest.mock('../../../services/connectorSecrets', () => ({
  put: jest.fn(async () => 'secret-ref-1'),
  get: jest.fn(),
  revoke: jest.fn(),
  listWithUnavailableKey: jest.fn(),
}));

const axios = require('axios');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const Integration = require('../../../models/Integration');

const discordRoutes = require('../../../routes/discord');
const integrationRoutes = require('../../../routes/integrations');
const authMiddleware = require('../../../middleware/auth');
const integrationRateLimit = require('../../../middleware/integrationRateLimit');

const app = express();
app.use(express.json());
app.use('/api/discord', discordRoutes);
app.use('/api/integrations', integrationRoutes);

const discordRow = (overrides = {}) => ({
  _id: 'integration-1',
  type: 'discord',
  podId: 'pod-1',
  createdBy: { toString: () => MEMBER },
  config: { serverId: GUILD, channelId: CHANNEL },
  ...overrides,
});

// The outbound call that carries the instance bot token: any test asserting a
// refusal asserts this was NOT made.
const outboundCalls = () => axios.get.mock.calls.length + axios.post.mock.calls.length;

// The channels route reads the caller's pod ids and nothing else, so it asks
// Mongo for `_id` alone and skips hydration. Chainable and thenable, so the same
// handle records the query AND can be awaited like the real one.
const podQuery = (rows) => {
  const query = {
    select: jest.fn(() => query),
    lean: jest.fn(() => query),
    then: (onFulfilled, onRejected) => Promise.resolve(rows).then(onFulfilled, onRejected),
  };
  return query;
};
const podIdsQuery = (rows) => {
  const query = podQuery(rows);
  Pod.find.mockReturnValue(query);
  return query;
};

describe('Discord binding containment (TASK-123 a)', () => {
  const savedKeys = process.env.CONNECTOR_SECRET_KEYS;
  const savedActiveKey = process.env.CONNECTOR_SECRET_ACTIVE_KEY;

  afterAll(() => {
    process.env.CONNECTOR_SECRET_KEYS = savedKeys;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = savedActiveKey;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FRONTEND_URL = 'https://app.example.test';
    process.env.DISCORD_BOT_TOKEN = 'bot-secret';
    process.env.DISCORD_CLIENT_ID = 'client-id';
    process.env.DISCORD_CLIENT_SECRET = 'client-secret';
    process.env.JWT_SECRET = 'test-jwt-secret';
    // The create path encrypts the webhook URL (TASK-124 part 2), so a connector
    // secret ring is part of the deployment this route runs against.
    process.env.CONNECTOR_SECRET_KEYS = `k1:${Buffer.alloc(32, 1).toString('base64')}`;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k1';
    podIdsQuery([{ _id: 'pod-1' }]);
    Pod.findById.mockResolvedValue({ _id: 'pod-1', members: [MEMBER], createdBy: MEMBER });
    User.findById.mockResolvedValue({ _id: MEMBER, role: 'member' });
    axios.get.mockResolvedValue({ data: [{ type: 0, id: CHANNEL, name: 'general' }] });
    axios.post.mockResolvedValue({ data: { id: 'wh-1', token: 'wh-token', name: 'Guild' } });
  });

  describe('GET /api/discord/channels/:guildId', () => {
    it('mounts the channel-list limiter before auth', () => {
      // The handler does two database reads before it can answer. Mounted
      // first, the limiter refuses an over-budget caller before `auth`'s lookups
      // as well as these two. Presence, not behaviour: the limiter is stubbed in
      // this file, so only the stack can witness it.
      const route = discordRoutes.stack.find((layer) => layer.route
        && layer.route.path === '/channels/:guildId'
        && layer.route.methods.get);
      const handles = route.route.stack.map((layer) => layer.handle);

      expect(handles[0]).toBe(integrationRateLimit.listIntegrationsRateLimit);
      expect(handles[1]).toBe(authMiddleware);
    });
    it('asks for the caller’s pod ids only, without hydrating the documents', async () => {
      const query = podIdsQuery([{ _id: 'pod-1' }]);
      Integration.findOne.mockResolvedValue(discordRow());

      const res = await request(app)
        .get(`/api/discord/channels/${GUILD}`)
        .set('Authorization', 'Bearer user-token');

      // The read is every pod the caller belongs to, to collect `_id`s. Hydrating
      // those documents — members arrays included — is work the route never uses,
      // and it is what makes an unthrottled flood expensive. Pinned to the
      // projection it actually needs.
      expect(res.status).toBe(200);
      expect(query.select).toHaveBeenCalledWith('_id');
      expect(query.lean).toHaveBeenCalled();
    });
    it('refuses a guild id that is not a snowflake, before any lookup or outbound call', async () => {
      const res = await request(app)
        .get('/api/discord/channels/guild-1')
        .set('Authorization', 'Bearer user-token');

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_discord_id', field: 'guildId' });
      expect(Integration.findOne).not.toHaveBeenCalled();
      expect(outboundCalls()).toBe(0);
    });

    it('refuses a dot-segment guild id rather than letting it reach another Discord endpoint', async () => {
      const res = await request(app)
        .get(`/api/discord/channels/${encodeURIComponent('../../users/@me')}`)
        .set('Authorization', 'Bearer user-token');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_discord_id');
      expect(outboundCalls()).toBe(0);
    });

    it('answers 404 for a well-formed guild the caller has no binding to, without an outbound call', async () => {
      Integration.findOne.mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/discord/channels/${OTHER_GUILD}`)
        .set('Authorization', 'Bearer user-token');

      expect(res.status).toBe(404);
      // The scope is in the query, not in a later comparison: the guild is only
      // accepted if a row bound to it belongs to a pod of the caller's.
      expect(Integration.findOne).toHaveBeenCalledWith({
        type: 'discord',
        'config.serverId': OTHER_GUILD,
        podId: { $in: ['pod-1'] },
      });
      expect(outboundCalls()).toBe(0);
    });

    it('does not look outside the caller’s own pods for a binding', async () => {
      podIdsQuery([]);
      Integration.findOne.mockResolvedValue(discordRow());

      const res = await request(app)
        .get(`/api/discord/channels/${GUILD}`)
        .set('Authorization', 'Bearer user-token');

      expect(res.status).toBe(404);
      expect(Integration.findOne).not.toHaveBeenCalled();
      expect(outboundCalls()).toBe(0);
    });

    it('still lists channels for a member of a bound pod', async () => {
      Integration.findOne.mockResolvedValue(discordRow());

      const res = await request(app)
        .get(`/api/discord/channels/${GUILD}`)
        .set('Authorization', 'Bearer user-token');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: CHANNEL, name: 'general', topic: undefined }]);
      expect(axios.get).toHaveBeenCalledWith(
        `https://discord.com/api/guilds/${GUILD}/channels`,
        { headers: { Authorization: 'Bot bot-secret' } },
      );
    });
  });

  // F89: on a first install no binding exists yet, so the channel picker reads
  // through the proof the OAuth callback minted. It is scoped to one pod and one
  // guild, the guild taken from Discord's token response, and the caller must
  // still belong to that pod.
  describe('GET /api/discord/channels/:guildId on a first install', () => {
    const { mintDiscordInstallProof } = require('../../../utils/discordInstallProof');
    const firstInstall = (proof) => {
      Integration.findOne.mockResolvedValue(null);
      return request(app)
        .get(`/api/discord/channels/${GUILD}${proof === undefined ? '' : `?install=${encodeURIComponent(proof)}`}`)
        .set('Authorization', 'Bearer user-token');
    };

    it('lists channels for a member of the pod the proof names', async () => {
      const res = await firstInstall(mintDiscordInstallProof({ podId: 'pod-1', guildId: GUILD, userId: MEMBER }));

      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: CHANNEL, name: 'general', topic: undefined }]);
    });

    it('still answers 404 with no proof', async () => {
      const res = await firstInstall(undefined);

      expect(res.status).toBe(404);
      expect(outboundCalls()).toBe(0);
    });

    it.each([
      ['a proof for another guild', () => mintDiscordInstallProof({ podId: 'pod-1', guildId: OTHER_GUILD, userId: MEMBER })],
      ['a proof for a pod the caller is not in', () => mintDiscordInstallProof({ podId: 'pod-9', guildId: GUILD, userId: MEMBER })],
      ['an expired proof', () => mintDiscordInstallProof({ podId: 'pod-1', guildId: GUILD, userId: MEMBER }, -60)],
      ['a token that is not a proof', () => require('jsonwebtoken').sign({ id: MEMBER }, process.env.JWT_SECRET)],
      ['a forged proof', () => require('jsonwebtoken').sign({ pur: 'discord-install', pod: 'pod-1', gid: GUILD }, 'not-the-secret')],
    ])('refuses %s, without an outbound call', async (_label, makeProof) => {
      const res = await firstInstall(makeProof());

      expect(res.status).toBe(404);
      expect(outboundCalls()).toBe(0);
    });

    it('does not authenticate a request on its own', async () => {
      const proof = mintDiscordInstallProof({ podId: 'pod-1', guildId: GUILD, userId: MEMBER });
      expect(require('jsonwebtoken').decode(proof)).not.toHaveProperty('id');
      expect(require('jsonwebtoken').decode(proof)).not.toHaveProperty('user');
    });
  });

  describe('GET /api/discord/callback', () => {
    // install-link's signed state for MEMBER and pod-1 (a bare pod_<id> is refused).
    const STATE = () => encodeURIComponent(require('../../../utils/discordInstallProof')
      .mintDiscordInstallState({ podId: 'pod-1', userId: MEMBER }));
    it('refuses a malformed guild_id before the code exchange', async () => {
      const res = await request(app)
        .get(`/api/discord/callback?code=abc&state=${STATE()}&guild_id=guild-1`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/discord/error');
      // Not even the token exchange: a malformed id must not reach Discord.
      expect(outboundCalls()).toBe(0);
    });

    it('still completes the exchange for a well-formed guild_id', async () => {
      const res = await request(app)
        .get(`/api/discord/callback?code=abc&state=${STATE()}&guild_id=${GUILD}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/discord/success');
      expect(axios.post.mock.calls[0][0]).toBe('https://discord.com/api/oauth2/token');
    });

    it('hands the success page a proof for the guild Discord names in the token response', async () => {
      axios.post.mockResolvedValueOnce({ data: { token_type: 'Bearer', guild: { id: GUILD, name: 'Guild' } } });
      const { readDiscordInstallProof } = require('../../../utils/discordInstallProof');

      const res = await request(app)
        .get(`/api/discord/callback?code=abc&state=${STATE()}&guild_id=${GUILD}`);

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.pathname).toBe('/discord/success');
      expect(readDiscordInstallProof(location.searchParams.get('install'))).toEqual({ podId: 'pod-1', guildId: GUILD, userId: MEMBER });
    });

    it('refuses a guild_id that differs from the guild in the token response', async () => {
      axios.post.mockResolvedValueOnce({ data: { token_type: 'Bearer', guild: { id: OTHER_GUILD } } });

      const res = await request(app)
        .get(`/api/discord/callback?code=abc&state=${STATE()}&guild_id=${GUILD}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/discord/error');
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('mints no proof when the token response names no guild', async () => {
      const res = await request(app)
        .get(`/api/discord/callback?code=abc&state=${STATE()}&guild_id=${GUILD}`);

      expect(res.status).toBe(302);
      expect(new URL(res.headers.location).searchParams.has('install')).toBe(false);
    });

    it('redirects a post-exchange guild failure without logging provider data', async () => {
      const sentinel = 'dummy-bot-token-sentinel';
      axios.get.mockRejectedValueOnce({ response: { data: { detail: sentinel } } });
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await request(app)
          .get(`/api/discord/callback?code=abc&state=${STATE()}&guild_id=${GUILD}`);
        expect(axios.post).toHaveBeenCalledWith(
          'https://discord.com/api/oauth2/token', expect.anything(), expect.anything(),
        );
        expect(res.status).toBe(302);
        expect(res.headers.location).toContain('/discord/error');
        expect(JSON.stringify([...log.mock.calls, ...errorLog.mock.calls])).not.toContain(sentinel);
        expect(res.headers.location).not.toContain(sentinel);
      } finally {
        log.mockRestore();
        errorLog.mockRestore();
      }
    });
  });

  describe('POST /api/integrations', () => {
    const post = (body) => request(app)
      .post('/api/integrations')
      .set('Authorization', 'Bearer user-token')
      .send(body);
    // The channel lookup the create path makes before the webhook (F90).
    const channelIn = (guildId) => axios.get.mockImplementation(async (url) => (
      url === `https://discord.com/api/channels/${CHANNEL}`
        ? { data: { id: CHANNEL, type: 0, guild_id: guildId } }
        : { data: [] }));

    beforeEach(() => {
      // Authority by default: the caller's pod is already bound to the guild,
      // and the channel is in it. The F90 block below takes each away.
      Integration.findOne.mockResolvedValue(discordRow());
      channelIn(GUILD);
    });

    it('refuses a malformed serverId before the row or the webhook exists', async () => {
      const res = await post({ podId: 'pod-1', type: 'discord', config: { serverId: 'guild-1', channelId: CHANNEL } });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_discord_id', field: 'serverId' });
      expect(Integration.__getLastInstance()).toBeNull();
      expect(outboundCalls()).toBe(0);
    });

    it('refuses a malformed channelId, the field the webhook URL is built from', async () => {
      const res = await post({ podId: 'pod-1', type: 'discord', config: { serverId: GUILD, channelId: 'chan-1' } });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_discord_id', field: 'channelId' });
      expect(Integration.__getLastInstance()).toBeNull();
      expect(outboundCalls()).toBe(0);
    });

    it('refuses a body-supplied botToken instead of storing it', async () => {
      const res = await post({
        podId: 'pod-1',
        type: 'discord',
        config: { serverId: GUILD, channelId: CHANNEL, botToken: 'caller-token' },
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'server_owned_config_key', field: 'botToken' });
      expect(Integration.__getLastInstance()).toBeNull();
      expect(outboundCalls()).toBe(0);
    });

    it('accepts the consent callback’s exact payload, whose botToken is empty by design', async () => {
      // The live bind posts `botToken: ''` (`DiscordCallback.tsx:100`). A
      // key-presence check refuses this and breaks every real bind, so the
      // refusal has to be a VALUE test and this payload has to be the witness:
      // `''` is not supplied, so no 400, and the shared strip then drops the key
      // rather than storing an empty holder — while `resolveEffectiveConfig`
      // fills the token from the environment for the manifest check, so the row
      // is created and nothing is lost by dropping it.
      const res = await post({
        podId: 'pod-1',
        type: 'discord',
        config: {
          serverId: GUILD,
          serverName: 'Guild',
          channelId: CHANNEL,
          channelName: 'general',
          webhookUrl: '',
          botToken: '',
          permissions: ['read_messages', 'send_messages', 'read_message_history'],
        },
      });

      expect(res.status).toBe(201);
      expect(Integration.__getLastInstance().config).not.toHaveProperty('botToken');
      // The URL the create path derived is encrypted, not written to the row: the
      // strip above must not have eaten the ref the reader resolves through.
      expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        { $set: { 'config.webhookUrlRef': 'secret-ref-1' } },
      );
      expect(axios.post).toHaveBeenCalledWith(
        `https://discord.com/api/channels/${CHANNEL}/webhooks`,
        { name: 'Commonly Bot', avatar: null },
        { headers: { Authorization: 'Bot bot-secret', 'Content-Type': 'application/json' } },
      );
    });

    it('treats an explicitly empty id as missing, not as malformed', async () => {
      // `isSupplied`, not `field in config`: the manifest's required-field check
      // owns "missing" and says so in its own body. A shape refusal here would
      // answer a different question and drop the `missing` list the UI reads.
      const res = await post({ podId: 'pod-1', type: 'discord', config: { serverId: GUILD, channelId: '' } });

      expect(res.status).toBe(400);
      expect(res.body.missing).toEqual(['channelId']);
      expect(res.body.code).toBeUndefined();
      expect(outboundCalls()).toBe(0);
    });

    // `isSupplied` must be the EXACT complement of the manifest's missing test
    // (`getMissingRequiredFields` counts `undefined`/`null`/`''` as missing, and
    // nothing else). Two tests that are merely similar leave a third state, and
    // it is the dangerous one: not "missing", so the write proceeds; not
    // "supplied", so this guard never judges it — and it reaches the
    // `discord.com/api/...` URL unjudged. Measured at the previous head, all
    // three of these returned 201, stored the row and made the outbound call.
    [
      {
        label: 'a whitespace-only channelId',
        config: { serverId: GUILD, channelId: '  ' },
        code: 'invalid_discord_id',
      },
      {
        label: 'an array serverId',
        config: { serverId: [], channelId: CHANNEL },
        code: 'invalid_discord_id',
      },
      {
        label: 'a whitespace-only botToken',
        config: { serverId: GUILD, channelId: CHANNEL, botToken: '  ' },
        code: 'server_owned_config_key',
      },
    ].forEach(({ label, config, code }) => {
      it(`refuses ${label} instead of skipping it as absent`, async () => {
        // Snapshot, not `toBeNull()`: the accept-path test above legitimately
        // leaves an instance behind, so this asserts no NEW row was written.
        const before = Integration.__getLastInstance();
        const res = await post({ podId: 'pod-1', type: 'discord', config });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe(code);
        expect(Integration.__getLastInstance()).toBe(before);
        expect(outboundCalls()).toBe(0);
      });
    });

    it('CONTROL: a non-Discord write carrying a botToken stores the row without the token', async () => {
      // The load-bearing assertion for the strip: `SERVER_OWNED_CONFIG_KEYS` is
      // applied to every type, and `resolveEffectiveConfig` returns early for all
      // of them, so this is the field's only closure on Slack. The write is
      // still accepted (the strip is silent, and the `botToken` refusal above is
      // Discord-scoped), and the caller's value is gone from the stored config.
      // Nothing loses a credential it had: Slack's live bind stores
      // `botTokenRef`, and the instance-wide `SLACK_BOT_TOKEN` fallback is
      // retired (TASK-151). This test
      // previously asserted the opposite — that the caller's token was stored —
      // which is the state the strip removes.
      const res = await post({
        podId: 'pod-1',
        type: 'slack',
        config: { botToken: 'xoxb-caller', signingSecret: 'shh', channelId: 'C012345' },
      });

      expect(res.status).toBe(201);
      const stored = Integration.__getLastInstance();
      expect(stored.config).not.toHaveProperty('botToken');
      expect(stored.config.channelId).toBe('C012345');
    });

    it('drops a caller-supplied webhookUrl and webhookUrlRef from the stored config', async () => {
      // Both names join the server-owned list with this change: the URL is a
      // bearer credential the server derives from the Discord API on both
      // writers, and the ref is a pointer a caller must not be able to aim at
      // another row's secret. A planted `config.webhookUrl` would also be picked
      // up as the resolver's legacy fallback.
      const res = await post({
        podId: 'pod-1',
        type: 'discord',
        config: {
          serverId: GUILD,
          channelId: CHANNEL,
          webhookUrl: 'https://discord.com/api/webhooks/999/caller-token',
          webhookUrlRef: 'somebody-elses-ref',
        },
      });

      expect(res.status).toBe(201);
      const stored = Integration.__getLastInstance();
      expect(stored.config).not.toHaveProperty('webhookUrl');
      expect(stored.config).not.toHaveProperty('webhookUrlRef');
      // The ref on the row is the one the server wrote from the envelope.
      expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        { $set: { 'config.webhookUrlRef': 'secret-ref-1' } },
      );
    });

    describe('authority over the guild and channel (F90)', () => {
      const { mintDiscordInstallProof } = require('../../../utils/discordInstallProof');
      const BODY = { podId: 'pod-1', type: 'discord', config: { serverId: GUILD, channelId: CHANNEL } };
      const created = () => axios.post.mock.calls.length > 0;

      it('refuses a guild with no binding in the caller’s pods and no proof, before any row or outbound call', async () => {
        Integration.findOne.mockResolvedValue(null);
        const before = Integration.__getLastInstance();

        const res = await post(BODY);

        expect(res.status).toBe(404);
        expect(Integration.__getLastInstance()).toBe(before);
        expect(outboundCalls()).toBe(0);
      });

      it('counts only a binding the caller made, in one of their own pods', async () => {
        // Membership of a pod someone else bound is not authority: a listed pod
        // can be joined by anyone.
        await post(BODY);

        expect(Integration.findOne).toHaveBeenCalledWith({
          type: 'discord', 'config.serverId': GUILD, podId: { $in: ['pod-1'] }, createdBy: 'user-1',
        });
      });

      it('accepts a first install on the callback’s proof for this pod and guild, and does not store it', async () => {
        Integration.findOne.mockResolvedValue(null);
        const install = mintDiscordInstallProof({ podId: 'pod-1', guildId: GUILD, userId: MEMBER });

        const res = await post({ ...BODY, install });

        expect(res.status).toBe(201);
        expect(JSON.stringify(Integration.__getLastInstance().config)).not.toContain(install);
      });

      it.each([
        ['a proof for another pod', () => mintDiscordInstallProof({ podId: 'pod-2', guildId: GUILD, userId: MEMBER })],
        ['a proof for another guild', () => mintDiscordInstallProof({ podId: 'pod-1', guildId: OTHER_GUILD, userId: MEMBER })],
        ['an expired proof', () => mintDiscordInstallProof({ podId: 'pod-1', guildId: GUILD, userId: MEMBER }, -10)],
        ['a session token in the proof field', () => 'user-token'],
      ])('refuses %s', async (_label, make) => {
        Integration.findOne.mockResolvedValue(null);

        const res = await post({ ...BODY, install: make() });

        expect(res.status).toBe(404);
        expect(created()).toBe(false);
      });

      it('refuses a channel that belongs to another guild, before the row or the webhook', async () => {
        channelIn(OTHER_GUILD);
        const before = Integration.__getLastInstance();

        const res = await post(BODY);

        expect(res.status).toBe(404);
        expect(Integration.__getLastInstance()).toBe(before);
        expect(created()).toBe(false);
      });

      it.each([['a thread', 11], ['a category', 4], ['a forum', 15]])('refuses %s', async (_label, type) => {
        axios.get.mockResolvedValue({ data: { id: CHANNEL, type, guild_id: GUILD } });

        const res = await post(BODY);

        expect(res.status).toBe(404);
        expect(created()).toBe(false);
      });

      it('refuses a channel Discord does not return', async () => {
        axios.get.mockRejectedValue(Object.assign(new Error('404'), { response: { status: 404 } }));

        const res = await post(BODY);

        expect(res.status).toBe(404);
        expect(created()).toBe(false);
      });
    });
  });

  describe('PATCH /api/integrations/:id', () => {
    const patch = (body) => request(app)
      .patch('/api/integrations/64b64c7f8a9e2f0012345678')
      .set('Authorization', 'Bearer user-token')
      .send(body);

    it('refuses a malformed serverId on an existing Discord row', async () => {
      Integration.findById.mockResolvedValue(discordRow());

      const res = await patch({ config: { serverId: 'guild-1' } });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_discord_id', field: 'serverId' });
      expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('refuses a body-supplied botToken on an existing Discord row', async () => {
      Integration.findById.mockResolvedValue(discordRow());

      const res = await patch({ config: { botToken: 'caller-token' } });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'server_owned_config_key', field: 'botToken' });
      expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    // F90: the binding is fixed once the row exists. A retarget would aim the
    // instance bot at a channel the create path never checked; a new binding
    // goes through the create path, which does check.
    it.each([
      ['serverId', { serverId: OTHER_GUILD }],
      ['channelId', { channelId: '345678901234567891' }],
    ])('refuses a retarget of %s', async (field, config) => {
      Integration.findById.mockResolvedValue(discordRow());

      const res = await patch({ config });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'discord_binding_fixed', field });
      expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('accepts the binding it already has', async () => {
      Integration.findById.mockResolvedValue(discordRow());
      Integration.findByIdAndUpdate.mockResolvedValue(discordRow());

      const res = await patch({ config: { serverId: GUILD, channelId: CHANNEL } });

      expect(res.status).toBe(200);
      expect(Integration.findByIdAndUpdate).toHaveBeenCalled();
    });

    it('leaves a connector untouched when the request does not carry the binding', async () => {
      Integration.findById.mockResolvedValue(discordRow());
      Integration.findByIdAndUpdate.mockResolvedValue(discordRow());

      const res = await patch({ status: 'connected' });

      expect(res.status).toBe(200);
      expect(Integration.findByIdAndUpdate).toHaveBeenCalled();
    });

    it('CONTROL: a non-Discord PATCH carrying a botToken drops it instead of storing it', async () => {
      // PATCH is the field's second writer: the strip runs on `config` before
      // `incoming` is built, so the key never reaches the `config.<key>` update
      // path that persists every other incoming key. Asserted on the update
      // payload, which is where a stored credential would show up.
      Integration.findById.mockResolvedValue(discordRow({ type: 'slack', config: { channelId: 'C012345' } }));
      Integration.findByIdAndUpdate.mockResolvedValue(discordRow({ type: 'slack' }));

      const res = await patch({ config: { botToken: 'xoxb-patch' } });

      expect(res.status).toBe(200);
      const update = Integration.findByIdAndUpdate.mock.calls[0][1];
      expect(Object.keys(update).filter((key) => key.includes('botToken'))).toEqual([]);
    });
  });
  // F131: the installer's Discord user id is proven by the OAuth callback's
  // users/@me read, carried in the signed install proof, and stored server-side
  // as config.discordUserId. Live relay on a Discord row needs it.
  describe('the installer’s Discord identity (F131)', () => {
    const { mintDiscordInstallProof, readDiscordInstallProof, mintDiscordInstallState } = require('../../../utils/discordInstallProof');
    const INSTALLER_DISCORD = '456789012345678901';
    const STATE = () => encodeURIComponent(mintDiscordInstallState({ podId: 'pod-1', userId: MEMBER }));
    const callback = () => request(app).get(`/api/discord/callback?code=abc&state=${STATE()}&guild_id=${GUILD}`);
    const proofIn = (res) => readDiscordInstallProof(new URL(res.headers.location).searchParams.get('install'));
    const meResponds = (impl) => axios.get.mockImplementation(async (url, ...rest) => (
      url === 'https://discord.com/api/users/@me' ? impl(url, ...rest) : { data: { name: 'Guild' } }));

    it('asks Discord for identify on the install link', async () => {
      const res = await request(app).get('/api/discord/install-link/pod-1').set('Authorization', 'Bearer user-token');

      expect(res.status).toBe(200);
      expect(new URL(res.body.installUrl).searchParams.get('scope').split(' ')).toEqual(
        expect.arrayContaining(['bot', 'applications.commands', 'identify']),
      );
    });

    it('reads users/@me with the exchange’s user token and carries that id in the proof', async () => {
      axios.post.mockResolvedValueOnce({ data: { access_token: 'user-access', guild: { id: GUILD } } });
      meResponds(async () => ({ data: { id: INSTALLER_DISCORD, username: 'sam' } }));

      const res = await callback();

      expect(axios.get).toHaveBeenCalledWith(
        'https://discord.com/api/users/@me',
        expect.objectContaining({ headers: { Authorization: 'Bearer user-access' } }),
      );
      expect(new URL(res.headers.location).pathname).toBe('/discord/success');
      expect(proofIn(res)).toEqual({
        podId: 'pod-1', guildId: GUILD, userId: MEMBER, discordUserId: INSTALLER_DISCORD,
      });
    });

    it('a failed users/@me read still installs, with no Discord id in the proof', async () => {
      axios.post.mockResolvedValueOnce({ data: { access_token: 'user-access', guild: { id: GUILD } } });
      meResponds(async () => { throw Object.assign(new Error('401'), { response: { status: 401 } }); });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const res = await callback();

        expect(new URL(res.headers.location).pathname).toBe('/discord/success');
        expect(proofIn(res)).toEqual({ podId: 'pod-1', guildId: GUILD, userId: MEMBER });
      } finally {
        warn.mockRestore();
      }
    });

    it('never takes a malformed id from users/@me', async () => {
      axios.post.mockResolvedValueOnce({ data: { access_token: 'user-access', guild: { id: GUILD } } });
      meResponds(async () => ({ data: { id: 'not-a-snowflake' } }));

      const res = await callback();

      expect(proofIn(res).discordUserId).toBeUndefined();
    });

    describe('POST /api/integrations', () => {
      const BODY = { podId: 'pod-1', type: 'discord', config: { serverId: GUILD, channelId: CHANNEL } };
      const post = (body) => request(app).post('/api/integrations').set('Authorization', 'Bearer user-token').send(body);
      const stored = () => Integration.__getLastInstance().config;

      beforeEach(() => {
        Integration.findOne.mockResolvedValue(null);
        axios.get.mockImplementation(async (url) => (
          url === `https://discord.com/api/channels/${CHANNEL}`
            ? { data: { id: CHANNEL, type: 0, guild_id: GUILD } }
            : { data: [] }));
      });

      it('stores the proof’s Discord id as config.discordUserId', async () => {
        const install = mintDiscordInstallProof({
          podId: 'pod-1', guildId: GUILD, userId: MEMBER, discordUserId: INSTALLER_DISCORD,
        });

        const res = await post({ ...BODY, install });

        expect(res.status).toBe(201);
        expect(stored().discordUserId).toBe(INSTALLER_DISCORD);
      });

      it('strips a body-supplied discordUserId, with or without a proof', async () => {
        const noId = mintDiscordInstallProof({ podId: 'pod-1', guildId: GUILD, userId: MEMBER });
        const res = await post({ ...BODY, config: { ...BODY.config, discordUserId: '999999999999999999' }, install: noId });
        expect(res.status).toBe(201);
        expect(stored().discordUserId).toBeUndefined();

        const withId = mintDiscordInstallProof({
          podId: 'pod-1', guildId: GUILD, userId: MEMBER, discordUserId: INSTALLER_DISCORD,
        });
        await post({ ...BODY, config: { ...BODY.config, discordUserId: '999999999999999999' }, install: withId });
        expect(stored().discordUserId).toBe(INSTALLER_DISCORD);
      });

      it('takes no Discord id from a binding made on the prior-binding arm', async () => {
        Integration.findOne.mockResolvedValue(discordRow());

        const res = await post(BODY);

        expect(res.status).toBe(201);
        expect(stored().discordUserId).toBeUndefined();
      });

      it('refuses live relay on create without a proven Discord id, before the row or the webhook', async () => {
        Integration.findOne.mockResolvedValue(discordRow());
        const before = Integration.__getLastInstance();

        const res = await post({ ...BODY, config: { ...BODY.config, liveRelay: true } });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Discord account/);
        expect(Integration.__getLastInstance()).toBe(before);
        expect(axios.post).not.toHaveBeenCalled();
      });

      it('allows live relay on create with the proof, stamping the installer as the linked user', async () => {
        const install = mintDiscordInstallProof({
          podId: 'pod-1', guildId: GUILD, userId: MEMBER, discordUserId: INSTALLER_DISCORD,
        });

        const res = await post({ ...BODY, config: { ...BODY.config, liveRelay: true }, install });

        expect(res.status).toBe(201);
        expect(stored()).toMatchObject({ liveRelay: true, linkedUserId: MEMBER, discordUserId: INSTALLER_DISCORD });
      });
    });

    describe('PATCH /api/integrations/:id', () => {
      const patch = (body) => request(app)
        .patch('/api/integrations/64b64c7f8a9e2f0012345678')
        .set('Authorization', 'Bearer user-token')
        .send(body);
      const provenRow = (overrides = {}) => discordRow({
        config: { serverId: GUILD, channelId: CHANNEL, discordUserId: INSTALLER_DISCORD },
        ...overrides,
      });

      it('strips a body-supplied discordUserId', async () => {
        Integration.findById.mockResolvedValue(discordRow());
        Integration.findByIdAndUpdate.mockResolvedValue(discordRow());

        const res = await patch({ config: { discordUserId: '999999999999999999', channelName: 'general' } });

        expect(res.status).toBe(200);
        const update = Integration.findByIdAndUpdate.mock.calls[0][1];
        expect(Object.keys(update).filter((key) => key.includes('discordUserId'))).toEqual([]);
      });

      it('refuses live relay on a row with no proven Discord id', async () => {
        Integration.findById.mockResolvedValue(discordRow());

        const res = await patch({ config: { liveRelay: true } });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Discord account/);
        expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
      });

      it('lets the installer turn live relay on, stamped as the linked user', async () => {
        Integration.findById.mockResolvedValue(provenRow());
        Integration.findByIdAndUpdate.mockResolvedValue(provenRow());

        const res = await patch({ config: { liveRelay: true } });

        expect(res.status).toBe(200);
        expect(Integration.findByIdAndUpdate.mock.calls[0][1]).toMatchObject({
          'config.liveRelay': true, 'config.linkedUserId': MEMBER,
        });
      });

      it('refuses the pod creator who did not add the bot: their id would author the installer’s lines', async () => {
        // MEMBER created the pod (canDeleteIntegration passes) but user-3 added the bot.
        Integration.findById.mockResolvedValue(provenRow({ createdBy: { toString: () => 'user-3' } }));

        const res = await patch({ config: { liveRelay: true } });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Only the person who added the bot/);
        expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
      });
    });
  });
});
