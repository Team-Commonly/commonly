jest.mock('../../../models/Integration', () => ({ findOne: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../services/connectorSecrets', () => ({ get: jest.fn() }));
jest.mock('../../../services/slackApi', () => jest.fn().mockImplementation(() => ({ postMessage: jest.fn() })));
// The relay's classification is this service's own, tested against a real
// database in connectorDeliveryFailureService.test.js. Here the mock exists to
// witness the WIRING: which channel and which result reach it.
jest.mock('../../../services/connectorDeliveryFailureService', () => ({
  noteBoundChatDeliveryFailure: jest.fn().mockResolvedValue(false),
}));

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const connectorSecrets = require('../../../services/connectorSecrets');
const SlackApi = require('../../../services/slackApi');
const deliveryFailures = require('../../../services/connectorDeliveryFailureService');
const {
  relayAgentMessageToSlack,
  relaySlackMessageToPod,
  routeSlackReplyContent,
  isRelayableIntegration,
  isInboundRelayableIntegration,
} = require('../../../services/slackBridgeService');

const integration = {
  _id: 'integration-1',
  podId: 'pod-1',
  type: 'slack',
  isActive: true,
  config: {
    teamId: 'T1', chatId: 'D1', chatType: 'im', botTokenRef: 'secret-ref', liveRelay: true,
    relayAllAgentMessages: true,
  },
};

describe('Slack installable bridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Pod.findById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Launch' }) }) });
    connectorSecrets.get.mockResolvedValue('xoxb-secret');
    SlackApi.mockImplementation(() => ({ postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '171234.0001' }) }));
    Integration.findByIdAndUpdate.mockResolvedValue(undefined);
  });

  test('uses the selected Slack row, secret reference, and generic D11 map', async () => {
    await relayAgentMessageToSlack({
      podId: 'pod-1', agentUsername: 'kai', displayName: 'Kai', content: 'Hello from the pod',
      podMessageId: 'message-1', integration,
    });

    expect(connectorSecrets.get).toHaveBeenCalledWith('secret-ref');
    expect(SlackApi).toHaveBeenCalledWith('xoxb-secret');
    const api = SlackApi.mock.results[0].value;
    expect(api.postMessage).toHaveBeenCalledWith('D1', '[Launch] Kai: Hello from the pod');
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith('integration-1', expect.objectContaining({
      $push: expect.objectContaining({
        'config.relayMap': expect.objectContaining({
          $each: [expect.objectContaining({ externalMessageId: '171234.0001', podId: 'pod-1' })],
        }),
      }),
    }));
  });

  test('a permanent Slack failure is classified against the channel the relay targeted', async () => {
    // `not_in_channel` is Slack's version of Telegram's 403: the bot was removed
    // and every future relay to that channel fails the same way. The relay
    // swallows its own errors (it warns rather than throwing), so the observable
    // effects are the classification and the relay map that must not be written.
    const api = { postMessage: jest.fn().mockResolvedValue({ ok: false, error: 'not_in_channel' }) };
    SlackApi.mockImplementation(() => api);
    const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await relayAgentMessageToSlack({
      podId: 'pod-1', agentUsername: 'kai', displayName: 'Kai', content: 'Hello from the pod',
      podMessageId: 'message-1', integration,
    });

    expect(deliveryFailures.noteBoundChatDeliveryFailure).toHaveBeenCalledWith(
      integration, 'D1', { ok: false, error: 'not_in_channel' },
    );
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(warned.mock.calls[0][0]).toContain('not_in_channel');
  });

  test('a missing ts on a successful send is not treated as a delivery failure', async () => {
    // `!result.ts` warns in the same branch as `!result.ok`, but it says nothing
    // about whether the channel is reachable — only `ok: false` may flip.
    const api = { postMessage: jest.fn().mockResolvedValue({ ok: true }) };
    SlackApi.mockImplementation(() => api);
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await relayAgentMessageToSlack({
      podId: 'pod-1', agentUsername: 'kai', displayName: 'Kai', content: 'Hello from the pod',
      podMessageId: 'message-1', integration,
    });

    expect(deliveryFailures.noteBoundChatDeliveryFailure).toHaveBeenCalledWith(
      integration, 'D1', { ok: true },
    );
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('routes a Slack thread reply to the agent whose relayed message was quoted', () => {
    expect(routeSlackReplyContent({
      content: 'Can you clarify?',
      threadTs: '171234.0001',
      relayMap: [{ externalMessageId: '171234.0001', agentUsername: 'kai' }],
    })).toEqual({ content: '@kai Can you clarify?', routedAgent: 'kai' });
  });

  test('does not relay through a visible recovery row whose secret is unavailable', async () => {
    await relayAgentMessageToSlack({
      podId: 'pod-1', agentUsername: 'kai', displayName: 'Kai', content: 'Must stay in Commonly',
      integration: { ...integration, status: 'error' },
    });

    expect(connectorSecrets.get).not.toHaveBeenCalled();
    expect(SlackApi).not.toHaveBeenCalled();
  });

  test('uses an enabled user gate instead of the selected pod only', () => {
    expect(isRelayableIntegration({
      ...integration,
      scope: 'user',
      config: { ...integration.config, gates: { 'second-pod': { enabled: true } } },
    }, 'second-pod')).toBe(true);
  });

  test('keeps inbound on the active pod when its outbound gate is disabled', () => {
    expect(isInboundRelayableIntegration({
      ...integration,
      scope: 'user',
      config: { ...integration.config, gates: { 'pod-1': { enabled: false } } },
    }, 'pod-1')).toBe(true);
  });

  test('answers once in Slack when a user connector has no active pod', async () => {
    const result = await relaySlackMessageToPod({
      integration: {
        ...integration,
        scope: 'user',
        podId: undefined,
        config: { ...integration.config, gates: { 'pod-1': { enabled: true } } },
      },
      event: { text: 'hello', user: 'U1' },
    });

    expect(result).toEqual({ relayed: false });
    expect(connectorSecrets.get).toHaveBeenCalledWith('secret-ref');
    const api = SlackApi.mock.results[0].value;
    expect(api.postMessage).toHaveBeenCalledWith(
      'D1', 'This connector has no active pod. Choose one in Commonly first.',
    );
  });

  test('refuses inbound authorship when the linked user left the active pod', async () => {
    Pod.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ type: 'team', members: [] }) }),
    });

    await expect(relaySlackMessageToPod({
      integration: {
        ...integration,
        scope: 'user',
        config: { ...integration.config, linkedUserId: 'user-1', slackUserId: 'U1' },
      },
      event: { text: 'hello', user: 'U1' },
    })).resolves.toEqual({ relayed: false });

    expect(User.findById).not.toHaveBeenCalled();
    expect(connectorSecrets.get).toHaveBeenCalledWith('secret-ref');
    const api = SlackApi.mock.results[0].value;
    expect(api.postMessage).toHaveBeenCalledWith(
      'D1', 'This connector has no active pod. Choose one in Commonly first.',
    );
  });
});
