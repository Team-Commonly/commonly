jest.mock('../../../models/Integration', () => ({ findOne: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/pg/Message', () => ({ create: jest.fn(), findById: jest.fn() }));
jest.mock('../../../services/messageAgentDeliveryService', () => ({ deliverMessageToAgents: jest.fn() }));
jest.mock('../../../config/socket', () => ({ getIO: jest.fn(() => null) }));
jest.mock('../../../services/connectorSecrets', () => ({ get: jest.fn() }));
// The constructor is stubbed (the network); the escape is the real one, because
// the escaping these tests assert is the behaviour we ship.
jest.mock('../../../services/slackApi', () => {
  const actual = jest.requireActual('../../../services/slackApi');
  const mock = jest.fn().mockImplementation(() => ({ postMessage: jest.fn() }));
  mock.escapeSlackMrkdwn = actual.escapeSlackMrkdwn;
  return mock;
});
// The relay's classification is this service's own, tested against a real
// database in connectorDeliveryFailureService.test.js. Here the mock exists to
// witness the WIRING: which channel and which result reach it.
jest.mock('../../../services/connectorDeliveryFailureService', () => ({
  noteBoundChatDeliveryFailure: jest.fn().mockResolvedValue(false),
}));

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const PGMessage = require('../../../models/pg/Message');
const { deliverMessageToAgents } = require('../../../services/messageAgentDeliveryService');
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

  test('escapes the pod name, the author and the body of a relayed message', async () => {
    // One ternary, two escape regimes (vera 73823): the card branch escapes every
    // field it is handed through the renderer, and this fall-through interpolated
    // three of them raw. mrkdwn reads `<url|label>` as a link, so a pod name an
    // agent can choose becomes a link the bot appears to have posted.
    Pod.findById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: '<Evil|pod>' }) }) });
    await relayAgentMessageToSlack({
      podId: 'pod-1', agentUsername: 'kai', displayName: 'Kai', content: '<https://evil.example|click> <!channel>',
      podMessageId: 'message-1', integration,
    });

    const api = SlackApi.mock.results[0].value;
    expect(api.postMessage).toHaveBeenCalledWith(
      'D1',
      '[&lt;Evil|pod&gt;] Kai: &lt;https://evil.example|click&gt; &lt;!channel&gt;',
    );
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
    })).toEqual({ content: '@kai Can you clarify?', routedAgent: 'kai', podId: null });
  });

  // Two fixture shapes, because the routed pod and the active pod are different
  // documents: the first names the pod that may not be reachable any more.
  const podWithMembers = (name) => ({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ name, type: 'team', members: ['user-1'] }),
    }),
  });
  const podsById = (gatedPodName) => (id) => ({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(
        String(id) === 'pod-2'
          ? { name: gatedPodName, type: 'team', members: ['user-1'] }
          : { name: 'Alpha', type: 'team', members: ['user-1'] },
      ),
    }),
  });

  test('sends a thread reply into the quoted pod, not the connector\'s active one', async () => {
    // ADR-025 D11. The map entry names the pod its line came from; before this,
    // the reader kept only the agent and the reply landed in the active pod.
    Pod.findById.mockImplementation(podsById('Launch'));
    PGMessage.create.mockResolvedValue({ id: 'pg-1' });
    PGMessage.findById.mockResolvedValue({ id: 'pg-1', content: 'relayed' });
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ username: 'sam' }) }),
    });
    deliverMessageToAgents.mockResolvedValue(undefined);
    Integration.findOne.mockResolvedValue(null);

    const result = await relaySlackMessageToPod({
      integration: {
        ...integration,
        scope: 'user',
        config: {
          ...integration.config,
          linkedUserId: 'user-1',
          slackUserId: 'U1',
          gates: { 'pod-2': { enabled: true } },
          relayMap: [{ externalMessageId: '171234.0001', agentUsername: 'kai', podId: 'pod-2' }],
        },
      },
      event: { text: 'yes, ship it', user: 'U1', thread_ts: '171234.0001' },
    });

    expect(result).toEqual({ relayed: true, routedAgent: 'kai' });
    expect(PGMessage.create.mock.calls[0][0]).toBe('pod-2');
  });

  test('still posts an unquoted Slack message to the active pod', async () => {
    Pod.findById.mockReturnValue(podWithMembers('Alpha'));
    PGMessage.create.mockResolvedValue({ id: 'pg-1' });
    PGMessage.findById.mockResolvedValue({ id: 'pg-1', content: 'relayed' });
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ username: 'sam' }) }),
    });
    deliverMessageToAgents.mockResolvedValue(undefined);

    await relaySlackMessageToPod({
      integration: {
        ...integration,
        scope: 'user',
        config: {
          ...integration.config, linkedUserId: 'user-1', slackUserId: 'U1', gates: {},
        },
      },
      event: { text: 'hello', user: 'U1' },
    });

    expect(PGMessage.create.mock.calls[0][0]).toBe('pod-1');
  });

  test('refuses a thread reply into a pod whose gate is off, naming it, posting nothing', async () => {
    Pod.findById.mockImplementation(podsById('Launch'));

    const result = await relaySlackMessageToPod({
      integration: {
        ...integration,
        scope: 'user',
        config: {
          ...integration.config,
          linkedUserId: 'user-1',
          slackUserId: 'U1',
          gates: {},
          relayMap: [{ externalMessageId: '171234.0001', agentUsername: 'kai', podId: 'pod-2' }],
        },
      },
      event: { text: 'yes, ship it', user: 'U1', thread_ts: '171234.0001' },
    });

    expect(result).toEqual({ relayed: false });
    expect(PGMessage.create).not.toHaveBeenCalled();
    expect(deliverMessageToAgents).not.toHaveBeenCalled();
    const api = SlackApi.mock.results[0].value;
    expect(api.postMessage).toHaveBeenCalledWith('D1', expect.stringContaining('Launch'));
  });

  test('refuses a thread reply into a pod the linked user has left, posting nothing', async () => {
    // The gate is still on for pod-2; the membership half is what has to refuse.
    // Without this arm the Slack path's membership re-check is unwitnessed —
    // dropping the shared predicate left it green (ledger M8, first run).
    Pod.findById.mockImplementation((id) => ({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(
          String(id) === 'pod-2'
            ? { name: 'Launch', type: 'team', members: ['someone-else'] }
            : { name: 'Alpha', type: 'team', members: ['user-1'] },
        ),
      }),
    }));

    const result = await relaySlackMessageToPod({
      integration: {
        ...integration,
        scope: 'user',
        config: {
          ...integration.config,
          linkedUserId: 'user-1',
          slackUserId: 'U1',
          gates: { 'pod-2': { enabled: true } },
          relayMap: [{ externalMessageId: '171234.0001', agentUsername: 'kai', podId: 'pod-2' }],
        },
      },
      event: { text: 'yes, ship it', user: 'U1', thread_ts: '171234.0001' },
    });

    expect(result).toEqual({ relayed: false });
    expect(PGMessage.create).not.toHaveBeenCalled();
    expect(deliverMessageToAgents).not.toHaveBeenCalled();
    const api = SlackApi.mock.results[0].value;
    expect(api.postMessage).toHaveBeenCalledWith('D1', expect.stringContaining('Launch'));
  });

  test('routes a pre-D11 map entry (no podId) to the active pod', async () => {
    Pod.findById.mockReturnValue(podWithMembers('Alpha'));
    PGMessage.create.mockResolvedValue({ id: 'pg-1' });
    PGMessage.findById.mockResolvedValue({ id: 'pg-1', content: 'relayed' });
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ username: 'sam' }) }),
    });
    deliverMessageToAgents.mockResolvedValue(undefined);

    await relaySlackMessageToPod({
      integration: {
        ...integration,
        scope: 'user',
        config: {
          ...integration.config,
          linkedUserId: 'user-1',
          slackUserId: 'U1',
          gates: {},
          relayMap: [{ externalMessageId: '171234.0001', agentUsername: 'kai' }],
        },
      },
      event: { text: 'yes, ship it', user: 'U1', thread_ts: '171234.0001' },
    });

    expect(PGMessage.create.mock.calls[0][0]).toBe('pod-1');
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

  test('refuses inbound authorship when the linked user created the active pod and left', async () => {
    // TASK-161: same refusal, different cell. The arm above has no `createdBy`;
    // here the linked user IS the pod's creator, which `leavePod` leaves behind
    // — so the permissive predicate admitted exactly this message.
    Pod.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ type: 'team', createdBy: 'user-1', members: [] }),
      }),
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
      'D1',
      'This connector has no active pod. Choose one in Commonly first.',
    );
  });
});
