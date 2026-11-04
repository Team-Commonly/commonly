// The shared chat-relay core: the mode/mute decision, the command semantics,
// the outbound ladder over adapters, and the registry that drives the
// dispatcher's selector. The platform bridges' own suites pin each platform's
// wording and wiring; this one pins what the platforms now share.
jest.mock('../../../models/Integration', () => ({
  findByIdAndUpdate: jest.fn(),
  findOneAndUpdate: jest.fn(),
  aggregate: jest.fn(),
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../services/channelVerdictService', () => ({ record: jest.fn() }));

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const verdicts = require('../../../services/channelVerdictService');
const {
  TELEGRAM_BLOCKED_REASON,
} = require('../../../services/connectorDeliveryFailureService');
const {
  applyRelayCommand,
  isRelayMuted,
  relayModeOf,
  relayAgentMessageThroughAdapter,
} = require('../../../services/chatRelay/chatRelayCore');
const {
  chatRelayAdapters,
  chatRelayIntegrationTypes,
} = require('../../../services/chatRelay/adapters');
const { eventHandlers, activeHandlersForPod } = require('../../../services/installable/eventHandlers');

const NOW = new Date('2026-11-04T12:00:00Z');
const MIN = 60000;

describe('mode and mute', () => {
  test('mirror is exactly relayAllAgentMessages === true', () => {
    expect(relayModeOf({ _id: 'i', config: { relayAllAgentMessages: true } })).toBe('mirror');
    expect(relayModeOf({ _id: 'i', config: { relayAllAgentMessages: false } })).toBe('attention');
    expect(relayModeOf({ _id: 'i' })).toBe('attention');
  });

  test('a mute holds only while its time is in the future', () => {
    const at = (offset) => ({ _id: 'i', config: { relayMutedUntil: new Date(NOW.getTime() + offset) } });
    expect(isRelayMuted(at(MIN), NOW)).toBe(true);
    expect(isRelayMuted(at(-MIN), NOW)).toBe(false);
    expect(isRelayMuted(at(0), NOW)).toBe(false);
    expect(isRelayMuted({ _id: 'i', config: {} }, NOW)).toBe(false);
    // A stored ISO string reads the same as a Date.
    const isoLater = new Date(NOW.getTime() + MIN).toISOString();
    expect(isRelayMuted({ _id: 'i', config: { relayMutedUntil: isoLater } }, NOW)).toBe(true);
  });
});

describe('applyRelayCommand', () => {
  const integration = { _id: 'i', config: { relayAllAgentMessages: true, liveRelay: true } };

  test('help needs no connector; everything else does', () => {
    expect(applyRelayCommand({ name: 'help' }, null)).toEqual({ kind: 'help' });
    ['mode', 'status', 'mute', 'unmute'].forEach((name) => {
      expect(applyRelayCommand({ name }, null)).toEqual({ kind: 'not-linked' });
    });
  });

  test('mode with no argument shows, with a bad one is usage, and neither writes', () => {
    expect(applyRelayCommand({ name: 'mode' }, integration)).toEqual({ kind: 'mode-show', mode: 'mirror' });
    expect(applyRelayCommand({ name: 'mode', arg: 'loud' }, integration)).toEqual({ kind: 'mode-usage' });
    // The core compares as given; lowercasing is a platform's spelling choice.
    expect(applyRelayCommand({ name: 'mode', arg: 'Mirror' }, integration)).toEqual({ kind: 'mode-usage' });
  });

  test('mode sets the one stored flag', () => {
    expect(applyRelayCommand({ name: 'mode', arg: 'attention' }, integration)).toEqual({
      kind: 'mode-set', mode: 'attention', update: { $set: { 'config.relayAllAgentMessages': false } },
    });
    expect(applyRelayCommand({ name: 'mode', arg: 'mirror' }, integration).update)
      .toEqual({ $set: { 'config.relayAllAgentMessages': true } });
  });

  test.each([
    [undefined, 60], ['15', 15], ['0', 60], ['-5', 1], ['99999', 1440], ['soon', 60],
  ])('mute %p is %i minutes from now', (arg, minutes) => {
    const outcome = applyRelayCommand({ name: 'mute', arg }, integration, NOW);
    const until = new Date(NOW.getTime() + minutes * MIN);
    expect(outcome).toEqual({
      kind: 'mute', minutes, until, update: { $set: { 'config.relayMutedUntil': until } }, 
    });
  });

  test('unmute unsets only the owner mute', () => {
    expect(applyRelayCommand({ name: 'unmute' }, integration))
      .toEqual({ kind: 'unmute', update: { $unset: { 'config.relayMutedUntil': '' } } });
  });

  test('status reports mode, relay, an active mute only, and the lead', () => {
    const muted = new Date(NOW.getTime() + MIN);
    expect(applyRelayCommand({ name: 'status' }, {
      _id: 'i', config: { relayMutedUntil: muted, leadAgentUsername: 'nova' },
    }, NOW)).toEqual({
      kind: 'status', mode: 'attention', liveRelay: false, mutedUntil: muted, lead: 'nova',
    });
    expect(applyRelayCommand({ name: 'status' }, {
      _id: 'i',
      config: { relayAllAgentMessages: true, liveRelay: true, relayMutedUntil: new Date(NOW.getTime() - MIN) },
    }, NOW)).toEqual({
      kind: 'status', mode: 'mirror', liveRelay: true, mutedUntil: null, lead: null,
    });
  });
});

describe('relayAgentMessageThroughAdapter', () => {
  const POD = 'pod-1';
  const row = (id, config = {}) => ({
    _id: id, type: 'fake', scope: 'pod', podId: POD, config: { chatId: `chat-${id}`, ...config },
  });
  const fakeAdapter = (provider, sendResult, extra = {}) => ({
    provider,
    relayMapKey: `${provider}MessageId`,
    findLiveIntegration: jest.fn(async () => null),
    isRelayableIntegration: jest.fn(() => true),
    send: jest.fn(async ({ integration }) => ({ chatId: integration.config.chatId, ...sendResult })),
    logOutboundFailure: jest.fn(),
    ...extra,
  });
  const message = (integration, extra = {}) => ({
    podId: POD, agentUsername: 'nova', displayName: 'Nova', content: 'plain update', integration, ...extra,
  });
  const card = { title: 'Ship?', question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] };

  beforeEach(() => {
    jest.clearAllMocks();
    Integration.findByIdAndUpdate.mockResolvedValue({});
    Integration.findOneAndUpdate.mockResolvedValue({ _id: 'matched' });
  });

  test('fans out over two adapters: one lands, one fails and its failure is classified', async () => {
    const ok = fakeAdapter('alpha', { externalMessageId: 'm-1', result: { success: true } });
    // A Telegram-shaped 403 from the second platform: the classifier sorts it by
    // shape, so the core hands the provider's result over untouched.
    const blocked = { success: false, errorCode: 403, description: 'Forbidden: bot was blocked by the user' };
    const failing = fakeAdapter('beta', { externalMessageId: null, result: blocked });
    const mirror = { relayAllAgentMessages: true };

    await Promise.all([
      relayAgentMessageThroughAdapter(ok, message(row('a', mirror))),
      relayAgentMessageThroughAdapter(failing, message(row('b', mirror))),
    ]);

    expect(ok.send).toHaveBeenCalledTimes(1);
    expect(failing.send).toHaveBeenCalledTimes(1);
    // The landed line is remembered under its adapter's key so a reply routes back.
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith('a', {
      $push: {
        'config.relayMap': {
          $each: [{
            alphaMessageId: 'm-1', agentUsername: 'nova', podMessageId: null, podId: POD, 
          }],
          $slice: -100,
        },
      },
    });
    // The failed one flips its own connector, matched on its own bound chat.
    expect(Integration.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(Integration.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'b', 'config.chatId': 'chat-b' },
      expect.objectContaining({ $set: expect.objectContaining({ errorMessage: TELEGRAM_BLOCKED_REASON }) }),
      { new: true },
    );
    expect(ok.logOutboundFailure).not.toHaveBeenCalled();
    expect(failing.logOutboundFailure).not.toHaveBeenCalled();
  });

  test('an adapter that names a delivery error has it logged after classification', async () => {
    const adapter = fakeAdapter('beta', { externalMessageId: null, result: { ok: false, error: 'not_in_channel' } }, {
      deliveryFailureError: (result) => new Error(`post failed: ${result.error}`),
    });
    await relayAgentMessageThroughAdapter(adapter, message(row('b', { relayAllAgentMessages: true })));
    expect(Integration.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(adapter.logOutboundFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'post failed: not_in_channel' }),
      expect.anything(),
    );
  });

  test('a mute holds ordinary chat and cards alike, and records why for a card', async () => {
    const adapter = fakeAdapter('alpha', { externalMessageId: 'm-1', result: {} });
    const muted = row('a', { relayAllAgentMessages: true, relayMutedUntil: new Date(Date.now() + MIN) });

    await relayAgentMessageThroughAdapter(adapter, message(muted));
    await relayAgentMessageThroughAdapter(adapter, message(muted, { card, podMessageId: 'pm-1' }));

    expect(adapter.send).not.toHaveBeenCalled();
    expect(verdicts.record).toHaveBeenCalledTimes(1);
    expect(verdicts.record).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'alpha', verdict: 'hold', reason: 'muted', podId: POD,
    }));
  });

  test('an expired mute relays', async () => {
    const adapter = fakeAdapter('alpha', { externalMessageId: 'm-1', result: {} });
    await relayAgentMessageThroughAdapter(adapter, message(row('a', {
      relayAllAgentMessages: true, relayMutedUntil: new Date(Date.now() - MIN),
    })));
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  test('attention mode sends only what the escalation policy passes; mirror sends all', async () => {
    const adapter = fakeAdapter('alpha', { externalMessageId: 'm-1', result: {} });
    await relayAgentMessageThroughAdapter(adapter, message(row('a', { relayAllAgentMessages: false })));
    expect(adapter.send).not.toHaveBeenCalled();
    await relayAgentMessageThroughAdapter(adapter, message(row('a', { relayAllAgentMessages: false }), {
      content: '[BLOCKED] need a key',
    }));
    expect(adapter.send).toHaveBeenCalledTimes(1);
    // The per-pod gate mode overrides the connector-wide flag.
    await relayAgentMessageThroughAdapter(adapter, message({
      ...row('a', { relayAllAgentMessages: false, gates: { [POD]: { enabled: true, mode: 'mirror' } } }),
    }));
    expect(adapter.send).toHaveBeenCalledTimes(2);
  });

  test('a paused connector holds a card with a reason and sends nothing', async () => {
    const adapter = fakeAdapter('alpha', { externalMessageId: 'm-1', result: {} });
    await relayAgentMessageThroughAdapter(adapter, message(row('a', { adminPause: { reason: 'x' } }), {
      card, podMessageId: 'pm-1',
    }));
    expect(adapter.send).not.toHaveBeenCalled();
    expect(adapter.isRelayableIntegration).not.toHaveBeenCalled();
    expect(verdicts.record).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'hold', reason: 'paused' }));
  });

  test('a row the adapter does not consider relayable sends nothing', async () => {
    const adapter = fakeAdapter('alpha', { externalMessageId: 'm-1', result: {} }, {
      isRelayableIntegration: jest.fn(() => false),
    });
    await relayAgentMessageThroughAdapter(adapter, message(row('a', { relayAllAgentMessages: true })));
    expect(adapter.send).not.toHaveBeenCalled();
  });

  test('a delivered card is remembered as a card and recorded as an interrupt with its deep link', async () => {
    process.env.PUBLIC_APP_URL = 'https://app.example';
    const adapter = fakeAdapter('alpha', { externalMessageId: 'm-9', result: {} });
    await relayAgentMessageThroughAdapter(adapter, message(row('a'), { card, podMessageId: 'pm-1' }));
    delete process.env.PUBLIC_APP_URL;
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
      link: `https://app.example/v2/pods/${POD}?message=pm-1`,
    }));
    const [, update] = Integration.findByIdAndUpdate.mock.calls[0];
    expect(update.$push['config.cards'])
      .toEqual(expect.objectContaining({ podMessageId: 'pm-1', alphaMessageId: 'm-9' }));
    expect(verdicts.record).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'interrupt', reason: 'card' }));
  });

  test('a throw anywhere ends in the adapter log, never in the caller', async () => {
    const adapter = fakeAdapter('alpha', null, { send: jest.fn(async () => { throw new Error('network'); }) });
    await expect(relayAgentMessageThroughAdapter(adapter, message(row('a', { relayAllAgentMessages: true }))))
      .resolves.toBeUndefined();
    expect(adapter.logOutboundFailure)
      .toHaveBeenCalledWith(expect.objectContaining({ message: 'network' }), expect.anything());
  });
});

describe('the adapter registry drives the dispatcher', () => {
  const podId = '64b7f0c2a1b2c3d4e5f60718';

  beforeEach(() => {
    jest.clearAllMocks();
    Pod.findById.mockReturnValue({ select: () => ({ lean: async () => ({ members: ['64b7f0c2a1b2c3d4e5f60719'] }) }) });
    Integration.aggregate.mockResolvedValue([]);
  });

  test('every registered platform has a <provider>.relay handler', () => {
    expect(chatRelayIntegrationTypes()).toEqual(['telegram', 'slack']);
    chatRelayIntegrationTypes().forEach((provider) => {
      expect(typeof eventHandlers[`${provider}.relay`]).toBe('function');
    });
  });

  test.each([false, true])('the selector reads the registry keys (card holds: %s)', async (includeCardHolds) => {
    chatRelayAdapters.discordish = { provider: 'discordish' };
    try {
      await activeHandlersForPod(podId, includeCardHolds);
    } finally {
      delete chatRelayAdapters.discordish;
    }
    const [[pipeline]] = Integration.aggregate.mock.calls;
    expect(pipeline[0].$match.type).toEqual({ $in: ['telegram', 'slack', 'discordish'] });
  });
});
