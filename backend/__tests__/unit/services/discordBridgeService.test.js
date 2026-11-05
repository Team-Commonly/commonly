// F131 (D249): a bound Discord channel's lines relay live into its pod, through
// the shared chat-relay core, only when their author is the Discord account the
// install proved. Everyone else's lines keep the buffer-for-summary path.
//
// The claim store is an in-memory stand-in for WebhookDelivery's unique index,
// with the real webhookDeliveryService over it, so "two replicas, one write" is
// the same duplicate-key path production takes.
jest.mock('discord.js', () => ({
  Client: jest.fn(),
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
}));
jest.mock('../../../models/Integration', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/pg/Message', () => ({ create: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/pg/Pod', () => ({ findById: jest.fn(async () => ({ id: 'pod-1' })) }));
jest.mock('../../../services/messageAgentDeliveryService', () => ({ deliverMessageToAgents: jest.fn() }));
jest.mock('../../../config/socket', () => ({ getIO: jest.fn(() => null) }));
jest.mock('../../../models/WebhookDelivery', () => {
  const claimed = new Set();
  return {
    __claimed: claimed,
    __unavailable: { value: false },
    create: jest.fn(async function create({ provider, deliveryId }) {
      // eslint-disable-next-line global-require
      const self = require('../../../models/WebhookDelivery');
      if (self.__unavailable.value) throw new Error('mongo down');
      const key = `${provider}|${deliveryId}`;
      if (claimed.has(key)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      claimed.add(key);
      return {};
    }),
    deleteOne: jest.fn(),
  };
});

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const PGMessage = require('../../../models/pg/Message');
const WebhookDelivery = require('../../../models/WebhookDelivery');
const {
  relayDiscordMessageToPod,
  relayDiscordMessageForIntegration,
  discordInboundAdapter,
} = require('../../../services/discordBridgeService');
const discordGatewayService = require('../../../services/discordGatewayService');

const GUILD = '123456789012345678';
const CHANNEL = '234567890123456789';
const INSTALLER_DISCORD = '345678901234567890';
const OTHER_DISCORD = '456789012345678901';
const INSTALLER = 'user-1';

const row = (overrides = {}, config = {}) => ({
  _id: 'integration-1',
  podId: 'pod-1',
  type: 'discord',
  isActive: true,
  status: 'connected',
  createdBy: INSTALLER,
  ...overrides,
  config: {
    serverId: GUILD,
    channelId: CHANNEL,
    liveRelay: true,
    linkedUserId: INSTALLER,
    discordUserId: INSTALLER_DISCORD,
    ...config,
  },
});

let nextId = 1000;
const discordMessage = (overrides = {}) => ({
  id: String(nextId++),
  type: 0,
  system: false,
  webhookId: null,
  guild: { id: GUILD },
  channel: { id: CHANNEL },
  author: { id: INSTALLER_DISCORD, username: 'sam', bot: false },
  member: { displayName: 'Sam' },
  content: 'ship it @kai',
  createdAt: new Date('2026-11-04T12:00:00Z'),
  attachments: new Map(),
  ...overrides,
});

const writes = () => PGMessage.create.mock.calls;

describe('Discord inbound live relay (F131)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    WebhookDelivery.__claimed.clear();
    WebhookDelivery.__unavailable.value = false;
    Pod.findById.mockReturnValue({
      select: () => ({ lean: async () => ({ _id: 'pod-1', type: 'chat', members: [INSTALLER] }) }),
    });
    User.findById.mockReturnValue({ select: () => ({ lean: async () => ({ username: 'sam' }) }) });
    PGMessage.create.mockResolvedValue({ id: 'pg-1' });
    PGMessage.findById.mockResolvedValue({ id: 'pg-1', content: 'x' });
  });

  test('writes the proven sender’s line into the bound pod as the linked user', async () => {
    const result = await relayDiscordMessageToPod({ integration: row(), message: discordMessage() });

    expect(result).toEqual({ relayed: true });
    expect(writes()).toHaveLength(1);
    const [podId, userId, content] = writes()[0];
    expect(podId).toBe('pod-1');
    expect(userId).toBe(INSTALLER);
    // Mentions stay text, so an @agent in the line still wakes that agent.
    expect(content).toBe('💬 Sam (via Discord): ship it @kai');
  });

  test('does not write another guild member’s line live', async () => {
    const result = await relayDiscordMessageToPod({
      integration: row(),
      message: discordMessage({ author: { id: OTHER_DISCORD, username: 'mallory', bot: false } }),
    });

    expect(result).toEqual({ relayed: false });
    expect(writes()).toHaveLength(0);
    // Not even a claim: nothing about an unproven line touches the claim store.
    expect(WebhookDelivery.create).not.toHaveBeenCalled();
  });

  test('a row with no proven discordUserId relays nothing live', async () => {
    const result = await relayDiscordMessageToPod({
      integration: row({}, { discordUserId: undefined }),
      message: discordMessage(),
    });

    expect(result).toEqual({ relayed: false });
    expect(writes()).toHaveLength(0);
  });

  test('a row whose linked user is not the installer relays nothing live', async () => {
    // The Discord id was proven for the row's creator. Authoring that account's
    // lines as anyone else would be the misattribution this whole rule is for.
    const result = await relayDiscordMessageToPod({
      integration: row({}, { linkedUserId: 'user-9' }),
      message: discordMessage(),
    });

    expect(result).toEqual({ relayed: false });
    expect(writes()).toHaveLength(0);
  });

  test.each([
    ['live relay off', row({}, { liveRelay: false })],
    ['an admin pause', row({}, { adminPause: { reason: 'abuse' } })],
    ['an inactive row', row({ isActive: false })],
    ['a row in error', row({ status: 'error' })],
    ['a row bound to another channel', row({}, { channelId: '567890123456789012' })],
  ])('relays nothing for %s', async (_label, integration) => {
    await relayDiscordMessageToPod({ integration, message: discordMessage() });
    expect(writes()).toHaveLength(0);
  });

  test.each([
    ['a bot author', { author: { id: INSTALLER_DISCORD, username: 'bot', bot: true } }],
    // Our own channel webhook echoes every outbound line back through the gateway.
    ['a webhook author', { webhookId: '678901234567890123' }],
    ['a system message', { system: true }],
    ['a pin notice', { type: 6 }],
  ])('ignores %s', async (_label, overrides) => {
    const result = await relayDiscordMessageToPod({ integration: row(), message: discordMessage(overrides) });
    expect(result).toEqual({ relayed: false });
    expect(writes()).toHaveLength(0);
  });

  test('a reply relays like a plain line', async () => {
    await relayDiscordMessageToPod({ integration: row(), message: discordMessage({ type: 19 }) });
    expect(writes()).toHaveLength(1);
  });

  test('attachments become links after the text', async () => {
    await relayDiscordMessageToPod({
      integration: row(),
      message: discordMessage({
        content: 'the deck',
        attachments: new Map([['a1', { url: 'https://cdn.discordapp.com/attachments/1/2/deck.pdf' }]]),
      }),
    });

    expect(writes()[0][2]).toBe('💬 Sam (via Discord): the deck\nhttps://cdn.discordapp.com/attachments/1/2/deck.pdf');
  });

  test('the same Discord message delivered twice writes one pod message', async () => {
    const message = discordMessage();

    const results = await Promise.all([
      relayDiscordMessageToPod({ integration: row(), message }),
      relayDiscordMessageToPod({ integration: row(), message }),
    ]);

    expect(writes()).toHaveLength(1);
    expect(results.filter((r) => r.relayed)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
  });

  test('the claim is per row: one message reaches each row bound to its channel once', async () => {
    const message = discordMessage();

    await relayDiscordMessageToPod({ integration: row(), message });
    await relayDiscordMessageToPod({ integration: row({ _id: 'integration-2', podId: 'pod-1' }), message });

    expect(writes()).toHaveLength(2);
  });

  test('fails closed when the claim store is unavailable', async () => {
    WebhookDelivery.__unavailable.value = true;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const message = discordMessage();
      const result = await relayDiscordMessageToPod({ integration: row(), message });
      expect(result).toEqual({ relayed: false });
      expect(writes()).toHaveLength(0);
      // The operator is the audience for this exception (review rule 19): the
      // log names the row and the message so the missed line can be found.
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('integration-1');
      expect(logged).toContain(message.id);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  describe('a transient failure loading the author, while the claim is held', () => {
    const podOk = { select: () => ({ lean: async () => ({ _id: 'pod-1', type: 'chat', members: [INSTALLER] }) }) };
    const podThrows = () => { throw new Error('mongo blip'); };

    test('is retried, and the line is written once', async () => {
      Pod.findById.mockImplementationOnce(podThrows).mockReturnValue(podOk);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await relayDiscordMessageToPod({ integration: row(), message: discordMessage() });
        expect(result).toEqual({ relayed: true });
        expect(writes()).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    test('three throws write nothing, and say so with the row and message', async () => {
      Pod.findById.mockImplementation(podThrows);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const message = discordMessage();
        const result = await relayDiscordMessageToPod({ integration: row(), message });
        expect(result).toEqual({ relayed: false });
        expect(writes()).toHaveLength(0);
        expect(Pod.findById).toHaveBeenCalledTimes(3);
        const logged = JSON.stringify(error.mock.calls);
        expect(logged).toContain('integration-1');
        expect(logged).toContain(message.id);
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    });

    test('the write itself is never retried', async () => {
      PGMessage.create.mockRejectedValueOnce(new Error('pg down'));
      await expect(relayDiscordMessageToPod({ integration: row(), message: discordMessage() })).rejects.toThrow('pg down');
      expect(writes()).toHaveLength(1);
    });
  });

  test('does not write when the linked user has left the pod, and says nothing in the channel', async () => {
    Pod.findById.mockReturnValue({
      select: () => ({ lean: async () => ({ _id: 'pod-1', type: 'chat', members: ['user-7'] }) }),
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await relayDiscordMessageToPod({ integration: row(), message: discordMessage() });
      expect(result).toEqual({ relayed: false });
      expect(writes()).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  describe('the gateway', () => {
    const target = (overrides = {}) => ({
      integrationId: 'integration-1',
      webhookListenerEnabled: true,
      maxBufferSize: 50,
      liveRelay: true,
      discordUserId: INSTALLER_DISCORD,
      ...overrides,
    });

    beforeEach(() => {
      discordGatewayService.channelCache = new Map();
      jest.spyOn(discordGatewayService, 'ensureChannelCache').mockResolvedValue();
      Integration.findByIdAndUpdate.mockResolvedValue({});
      Integration.findById.mockReturnValue({ select: () => ({ lean: async () => row() }) });
    });

    afterEach(() => {
      discordGatewayService.ensureChannelCache.mockRestore();
    });

    test('buffers every line and relays the proven one, re-reading the row', async () => {
      discordGatewayService.channelCache.set(`${GUILD}:${CHANNEL}`, [target()]);

      await discordGatewayService.handleMessageCreate(discordMessage());

      expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith('integration-1', expect.objectContaining({
        $push: { 'config.messageBuffer': expect.anything() },
      }));
      expect(Integration.findById).toHaveBeenCalledWith('integration-1');
      expect(writes()).toHaveLength(1);
    });

    test('still buffers another member’s line, and writes nothing live', async () => {
      discordGatewayService.channelCache.set(`${GUILD}:${CHANNEL}`, [target()]);

      await discordGatewayService.handleMessageCreate(
        discordMessage({ author: { id: OTHER_DISCORD, username: 'mallory', bot: false } }),
      );

      expect(Integration.findByIdAndUpdate).toHaveBeenCalledTimes(1);
      expect(writes()).toHaveLength(0);
    });

    // F132 review follow-up: the cached proven id pre-filters, so a line from
    // anyone but the installer costs no row read at all.
    test('does not read the row for a line from anyone but the cached installer', async () => {
      discordGatewayService.channelCache.set(`${GUILD}:${CHANNEL}`, [target()]);

      await discordGatewayService.handleMessageCreate(
        discordMessage({ author: { id: OTHER_DISCORD, username: 'mallory', bot: false } }),
      );

      expect(Integration.findById).not.toHaveBeenCalled();
      expect(Integration.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    });

    test('does not read the row when the cache holds no proven installer', async () => {
      discordGatewayService.channelCache.set(`${GUILD}:${CHANNEL}`, [target({ discordUserId: undefined })]);

      await discordGatewayService.handleMessageCreate(discordMessage());

      expect(Integration.findById).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(0);
    });

    test('does not hand a non-live row to the bridge', async () => {
      discordGatewayService.channelCache.set(`${GUILD}:${CHANNEL}`, [target({ liveRelay: false })]);

      await discordGatewayService.handleMessageCreate(discordMessage());

      expect(Integration.findById).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(0);
    });

    test('two replicas’ gateways receiving one message write it once', async () => {
      discordGatewayService.channelCache.set(`${GUILD}:${CHANNEL}`, [target()]);
      const message = discordMessage();

      await Promise.all([
        discordGatewayService.handleMessageCreate(message),
        discordGatewayService.handleMessageCreate(message),
      ]);

      expect(writes()).toHaveLength(1);
    });
  });

  test('relayDiscordMessageForIntegration answers nothing for a missing row', async () => {
    Integration.findById.mockReturnValue({ select: () => ({ lean: async () => null }) });
    await expect(relayDiscordMessageForIntegration('gone', discordMessage())).resolves.toEqual({ relayed: false });
  });

  describe('live-relay rule (the adapter’s declaration)', () => {
    test('refuses a row without a proven Discord user', () => {
      expect(discordInboundAdapter.liveRelayRefusal({ config: {}, createdBy: INSTALLER }, INSTALLER)).toMatch(/Discord account/);
    });

    test('refuses anyone but the installer, whose id linkedUserId would be stamped from', () => {
      const proven = { config: { discordUserId: INSTALLER_DISCORD }, createdBy: { toString: () => INSTALLER } };
      expect(discordInboundAdapter.liveRelayRefusal(proven, 'pod-creator')).toMatch(/Only the person who added the bot/);
      expect(discordInboundAdapter.liveRelayRefusal(proven, INSTALLER)).toBeNull();
    });
  });
});
