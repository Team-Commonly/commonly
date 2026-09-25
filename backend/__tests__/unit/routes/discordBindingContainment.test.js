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
}));

jest.mock('../../../models/Integration', () => {
  let lastInstance = null;

  function Integration(data) {
    Object.assign(this, data);
    this._id = data._id || 'integration-new';
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
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FRONTEND_URL = 'https://app.example.test';
    process.env.DISCORD_BOT_TOKEN = 'bot-secret';
    process.env.DISCORD_CLIENT_ID = 'client-id';
    process.env.DISCORD_CLIENT_SECRET = 'client-secret';
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

  describe('GET /api/discord/callback', () => {
    it('refuses a malformed guild_id before the code exchange', async () => {
      const res = await request(app)
        .get('/api/discord/callback?code=abc&state=pod_pod-1&guild_id=guild-1');

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/discord/error');
      // Not even the token exchange: a malformed id must not reach Discord.
      expect(outboundCalls()).toBe(0);
    });

    it('still completes the exchange for a well-formed guild_id', async () => {
      const res = await request(app)
        .get(`/api/discord/callback?code=abc&state=pod_pod-1&guild_id=${GUILD}`);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/discord/success');
      expect(axios.post.mock.calls[0][0]).toBe('https://discord.com/api/oauth2/token');
    });
  });

  describe('POST /api/integrations', () => {
    const post = (body) => request(app)
      .post('/api/integrations')
      .set('Authorization', 'Bearer user-token')
      .send(body);

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
      // the empty token is filled from the environment by
      // `resolveEffectiveConfig`, and `getMissingRequiredFields` reports `''` as
      // missing, so it is neither refused here nor lost.
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

    it('CONTROL: a Slack write carrying a botToken is untouched by the Discord refusal', async () => {
      // The load-bearing assertion. `SERVER_OWNED_CONFIG_KEYS` is applied to
      // every type, and `resolveEffectiveConfig` returns early for all of them,
      // so a shared-list version of this fix strips Slack's token with nothing
      // to inject it back and 400s here. This control fails on that version and
      // passes on the Discord-scoped one; nothing else in the file can see it.
      const res = await post({
        podId: 'pod-1',
        type: 'slack',
        config: { botToken: 'xoxb-caller', signingSecret: 'shh', channelId: 'C012345' },
      });

      expect(res.status).toBe(201);
      const stored = Integration.__getLastInstance();
      expect(stored.config.botToken).toBe('xoxb-caller');
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

    it('still accepts a well-formed retarget', async () => {
      Integration.findById.mockResolvedValue(discordRow());
      Integration.findByIdAndUpdate.mockResolvedValue(discordRow({ config: { serverId: OTHER_GUILD } }));

      const res = await patch({ config: { serverId: OTHER_GUILD } });

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
  });
});
