// F132 (D249): a Discord row with live relay on carries the pod's agent lines
// back to its bound channel, by mode, through the shared chat-relay core — the
// same ladder Telegram and Slack run. What only Discord knows is pinned here:
// the channel webhook send, the 2000-character limit, a send that can never
// ping a guild, and the webhook's rate limit.
jest.mock('discord.js', () => ({
  Client: jest.fn(),
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
}));
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn(), create: jest.fn() }));
jest.mock('../../../models/Integration', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/pg/Message', () => ({ create: jest.fn(), findById: jest.fn() }));
jest.mock('../../../services/channelVerdictService', () => ({ record: jest.fn() }));
jest.mock('../../../services/connectorSecrets', () => ({ get: jest.fn() }));

const axios = require('axios');
const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const PGMessage = require('../../../models/pg/Message');
const connectorSecrets = require('../../../services/connectorSecrets');
const { relayAgentMessageThroughAdapter } = require('../../../services/chatRelay/chatRelayCore');
const {
  discordRelayAdapter,
  discordWebhookPacing,
  relayDiscordMessageToPod,
  DISCORD_CONTENT_LIMIT,
} = require('../../../services/discordBridgeService');
const deliveryFailures = require('../../../services/connectorDeliveryFailureService');

const POD = '64b7f0c2a1b2c3d4e5f60718';
const CREATOR = '64b7f0c2a1b2c3d4e5f60719';
const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const INSTALLER_DISCORD = '345678901234567890';
const WEBHOOK_ID = '456789012345678901';
const WEBHOOK_URL = `https://discord.com/api/webhooks/${WEBHOOK_ID}/tok-en_123`;

let rowSeq = 0;
const discordRow = (configOverrides = {}, rowOverrides = {}) => {
  rowSeq += 1;
  return {
    _id: `row-${rowSeq}`,
    type: 'discord',
    podId: POD,
    isActive: true,
    status: 'connected',
    createdBy: CREATOR,
    config: {
      serverId: GUILD,
      channelId: CHANNEL,
      webhookUrlRef: 'secret-ref-1',
      liveRelay: true,
      relayAllAgentMessages: true,
      linkedUserId: CREATOR,
      discordUserId: INSTALLER_DISCORD,
      ...configOverrides,
    },
    ...rowOverrides,
  };
};

const ok = (id = '999000111222333444') => ({ status: 200, data: { id }, headers: {} });
const failure = (status, data, headers = {}) => ({ status, data, headers });

const relay = (integration, overrides = {}) => relayAgentMessageThroughAdapter(discordRelayAdapter, {
  podId: POD,
  agentUsername: 'kai',
  displayName: 'Kai',
  content: 'The build is green.',
  podMessageId: 'pod-msg-1',
  integration,
  ...overrides,
});

const sentBody = (call = 0) => axios.post.mock.calls[call][1];

let sleeps;
beforeEach(() => {
  jest.clearAllMocks();
  discordWebhookPacing.reset();
  sleeps = [];
  discordWebhookPacing.sleep = jest.fn(async (ms) => { sleeps.push(ms); });
  Pod.findById.mockReturnValue({ select: () => ({ lean: async () => ({ name: 'Launch', members: [CREATOR] }) }) });
  connectorSecrets.get.mockResolvedValue(WEBHOOK_URL);
  axios.post.mockResolvedValue(ok());
  Integration.findByIdAndUpdate.mockResolvedValue({});
  Integration.findOneAndUpdate.mockResolvedValue(null);
});

describe('mode', () => {
  test('mirror: every agent line reaches the bound channel webhook', async () => {
    await relay(discordRow({ relayAllAgentMessages: true }));
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url] = axios.post.mock.calls[0];
    expect(url).toBe(`${WEBHOOK_URL}?wait=true`);
    expect(sentBody().content).toBe('[Launch] **Kai**: The build is green.');
    // The sent line is remembered, as on the other platforms.
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      $push: expect.objectContaining({
        'config.relayMap': expect.objectContaining({
          $each: [expect.objectContaining({ externalMessageId: '999000111222333444', agentUsername: 'kai' })],
        }),
      }),
    }));
  });

  test('attention: an ordinary line stays in the pod; an escalation reaches the channel', async () => {
    const row = discordRow({ relayAllAgentMessages: false });
    await relay(row, { content: 'Just a status note.' });
    expect(axios.post).not.toHaveBeenCalled();
    await relay(row, { content: '[ESCALATE] the deploy needs a human' });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(sentBody().content).toContain('[ESCALATE] the deploy needs a human');
  });

  test('mute holds every line until it expires', async () => {
    await relay(discordRow({ relayMutedUntil: new Date(Date.now() + 60_000) }));
    expect(axios.post).not.toHaveBeenCalled();
    await relay(discordRow({ relayMutedUntil: new Date(Date.now() - 60_000) }));
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});

describe('who it sends for', () => {
  test.each([
    ['live relay off', discordRow({ liveRelay: false })],
    ['an admin pause', discordRow({ adminPause: { reason: 'x' } })],
    ['an error row', discordRow({}, { status: 'error' })],
    // CodeRabbit 4475336541: disconnect sets 'disconnected' and leaves isActive
    // and liveRelay alone, so status itself must be 'connected'.
    ['a disconnected row', discordRow({}, { status: 'disconnected' })],
    ['a pending row', discordRow({}, { status: 'pending' })],
    ['no proven installer', discordRow({ discordUserId: undefined })],
    ['live relay switched on by someone other than the creator', discordRow({ linkedUserId: '64b7f0c2a1b2c3d4e5f60799' })],
    ['a row for another pod', discordRow({}, { podId: '64b7f0c2a1b2c3d4e5f60700' })],
  ])('sends nothing for %s', async (_label, row) => {
    await relay(row);
    expect(axios.post).not.toHaveBeenCalled();
  });

  // Review finding 1: the channel is shared and the installer controls it, so
  // an installer who left the pod stops receiving the pod's agent lines there.
  test('sends nothing once the installer is no longer a listed pod member', async () => {
    Pod.findById.mockReturnValue({
      select: () => ({ lean: async () => ({ name: 'Launch', members: ['64b7f0c2a1b2c3d4e5f60799'] }) }),
    });
    await relay(discordRow());
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('sends nothing when the pod cannot be read (fails closed)', async () => {
    Pod.findById.mockReturnValue({ select: () => ({ lean: async () => { throw new Error('mongo down'); } }) });
    await relay(discordRow());
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('a current member installer is unchanged', async () => {
    await relay(discordRow());
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('the fallback lookup selects only a connected row', async () => {
    Integration.findOne.mockReturnValue({ lean: async () => null });
    await relayAgentMessageThroughAdapter(discordRelayAdapter, {
      podId: POD, agentUsername: 'kai', displayName: 'Kai', content: 'x', podMessageId: 'm',
    });
    expect(Integration.findOne).toHaveBeenCalledWith(expect.objectContaining({ status: 'connected' }));
  });

  test.each([
    ['a foreign host', 'https://example.com/collect'],
    ['plain http', 'http://discord.com/api/webhooks/1/x'],
    ['a look-alike host', 'https://discord.com.evil.example/api/webhooks/1/x'],
    ['userinfo before another host', 'https://discord.com@evil.example/api/webhooks/1/x'],
    ['a query string', 'https://discord.com/api/webhooks/1/x?foo=bar'],
    ['a non-numeric webhook id', 'https://discord.com/api/webhooks/abc/x'],
  ])('sends nothing when the stored webhook URL is %s', async (_label, url) => {
    connectorSecrets.get.mockResolvedValue(url);
    await relay(discordRow());
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('content', () => {
  test('a long line is cut to Discord’s 2000-character limit, with an ellipsis', async () => {
    await relay(discordRow(), { content: 'x'.repeat(5000) });
    const { content } = sentBody();
    expect(content.length).toBe(DISCORD_CONTENT_LIMIT);
    expect(content.startsWith('[Launch] **Kai**: xxx')).toBe(true);
    expect(content.endsWith('…')).toBe(true);
  });

  test('a cut never splits a surrogate pair', async () => {
    const prefixLength = '[Launch] **Kai**: '.length;
    // Puts an emoji's high surrogate exactly at the cut point.
    const content = `${'x'.repeat(DISCORD_CONTENT_LIMIT - 2 - prefixLength)}😀${'y'.repeat(50)}`;
    await relay(discordRow(), { content });
    const sent = sentBody().content;
    expect(sent.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(/[\ud800-\udbff]…$/.test(sent)).toBe(false);
  });

  test('the send can ping no one: allowed_mentions is empty, and @everyone/@here are defused', async () => {
    await relay(discordRow(), { content: '@everyone and @here, see <@123456789012345678> and <@&987654321098765432>' });
    const body = sentBody();
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).not.toMatch(/@everyone|@here/);
    expect(body.content).toContain('@​everyone');
  });

  test('the display name is markdown-escaped so an agent cannot restyle the prefix', async () => {
    await relay(discordRow(), { displayName: '**Boss**' });
    expect(sentBody().content.startsWith('[Launch] **\\*\\*Boss\\*\\***: ')).toBe(true);
  });

  // Review finding 4: a pod name is user-chosen; it must not become a masked
  // link or a mass mention in the prefix.
  test('the pod name cannot forge a link or a mass mention in the prefix', async () => {
    Pod.findById.mockReturnValue({
      select: () => ({ lean: async () => ({ name: 'x](https://evil) [y @everyone', members: [CREATOR] }) }),
    });
    await relay(discordRow());
    const { content } = sentBody();
    expect(content.startsWith('[x\\]\\(https://evil\\) \\[y @\u200beveryone] **Kai**: ')).toBe(true);
    expect(content).not.toMatch(/(^|[^\\])\]\(https:\/\/evil/);
    expect(content).not.toMatch(/@everyone/);
  });

  test('a decision card renders inside the limit and links back to the pod', async () => {
    await relay(discordRow(), {
      card: {
        title: 'Choose a train',
        question: 'Which rollout should ship? '.repeat(200),
        options: [{ label: 'Canary' }, { label: 'Fast lane', recommended: true }],
      },
    });
    const { content, allowed_mentions: mentions } = sentBody();
    expect(content.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(content).toContain('Kai needs a ruling');
    expect(content).toMatch(/<https?:\/\/[^>]+\/v2\/pods\/64b7f0c2a1b2c3d4e5f60718\?message=pod-msg-1>$/);
    expect(mentions).toEqual({ parse: [] });
  });
});

describe('failures', () => {
  test.each([
    [404, 10003, 'DISCORD_CHANNEL_GONE_REASON'],
    [403, 50013, 'DISCORD_NO_PERMISSION_REASON'],
  ])('a %i with code %i marks the bound channel as failing', async (status, code, reasonKey) => {
    axios.post.mockResolvedValue(failure(status, { code, message: 'nope' }));
    const row = discordRow();
    await relay(row);
    expect(Integration.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: row._id, 'config.channelId': CHANNEL },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'error', errorMessage: deliveryFailures[reasonKey] }),
      }),
      expect.anything(),
    );
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('a 429 waits out retry_after once, then sends — never a tight retry', async () => {
    axios.post
      .mockResolvedValueOnce(failure(429, { message: 'You are being rate limited.', retry_after: 1.5, global: false }))
      .mockResolvedValueOnce(ok());
    await relay(discordRow());
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(sleeps).toContain(1500);
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('a long 429 does not retry; the lane cools down and the next line is not sent into it', async () => {
    axios.post.mockResolvedValueOnce(failure(429, { message: 'slow down', retry_after: 30 }));
    const row = discordRow();
    await relay(row);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(sleeps.some((ms) => ms >= 30_000)).toBe(false);
    await relay(row, { content: 'second line' });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
  });

  // Review finding 5: a burst cannot grow the lane's queue without bound.
  test('a lane holds at most maxQueueDepth lines; the rest are dropped and logged', async () => {
    let release;
    axios.post.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(ok()); }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const row = discordRow();
      const depth = discordWebhookPacing.maxQueueDepth;
      const sends = Array.from({ length: depth + 5 }, (_unused, index) => relay(row, { content: `line ${index}` }));
      await new Promise((resolve) => { setImmediate(resolve); });
      while (!release) await new Promise((resolve) => { setImmediate(resolve); }); // eslint-disable-line no-await-in-loop
      release();
      await Promise.all(sends);
      expect(axios.post).toHaveBeenCalledTimes(depth);
      const dropped = warn.mock.calls.filter(([line]) => /line dropped/.test(String(line)));
      expect(dropped).toHaveLength(5);
      expect(String(dropped[0][0])).toMatch(/rate-limited/);
    } finally {
      warn.mockRestore();
    }
  });

  test('back-to-back lines to one webhook are paced at about 5 per 2 seconds', async () => {
    const row = discordRow();
    await Promise.all([relay(row, { content: 'one' }), relay(row, { content: 'two' }), relay(row, { content: 'three' })]);
    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(sleeps.filter((ms) => ms > 0).length).toBeGreaterThanOrEqual(2);
    sleeps.filter((ms) => ms > 0).forEach((ms) => expect(ms).toBeLessThanOrEqual(discordWebhookPacing.minIntervalMs));
  });
});

describe('echo', () => {
  test('the channel’s copy of a relayed agent line is not relayed back into the pod', async () => {
    const echo = {
      id: '999000111222333444',
      type: 0,
      webhookId: WEBHOOK_ID,
      guild: { id: GUILD },
      channel: { id: CHANNEL },
      author: { id: WEBHOOK_ID, username: 'Commonly Bot', bot: true },
      content: '[Launch] **Kai**: The build is green.',
    };
    await expect(relayDiscordMessageToPod({ integration: discordRow(), message: echo }))
      .resolves.toEqual({ relayed: false });
    expect(PGMessage.create).not.toHaveBeenCalled();
  });
});
