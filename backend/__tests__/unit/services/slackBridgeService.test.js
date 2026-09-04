jest.mock('../../../models/Integration', () => ({ findOne: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../services/connectorSecrets', () => ({ get: jest.fn() }));
jest.mock('../../../services/slackApi', () => jest.fn().mockImplementation(() => ({ postMessage: jest.fn() })));

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const connectorSecrets = require('../../../services/connectorSecrets');
const SlackApi = require('../../../services/slackApi');
const { relayAgentMessageToSlack, routeSlackReplyContent } = require('../../../services/slackBridgeService');

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

  test('routes a Slack thread reply to the agent whose relayed message was quoted', () => {
    expect(routeSlackReplyContent({
      content: 'Can you clarify?',
      threadTs: '171234.0001',
      relayMap: [{ externalMessageId: '171234.0001', agentUsername: 'kai' }],
    })).toEqual({ content: '@kai Can you clarify?', routedAgent: 'kai' });
  });
});
