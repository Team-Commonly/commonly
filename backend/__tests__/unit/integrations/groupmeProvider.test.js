jest.mock('../../../models/Integration', () => ({
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../../../models/Summary', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/integrationSummaryService', () => ({ createSummary: jest.fn() }));
jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn(),
}));
jest.mock('../../../services/groupmeService', () => ({ sendMessage: jest.fn() }));

const Integration = require('../../../models/Integration');
const Summary = require('../../../models/Summary');
const IntegrationSummaryService = require('../../../services/integrationSummaryService');
const AgentEventService = require('../../../services/agentEventService');
const groupmeService = require('../../../services/groupmeService');
const createGroupMeProvider = require('../../../integrations/providers/groupmeProvider');

const buildRes = () => ({
  status: jest.fn().mockReturnThis(),
  send: jest.fn(),
  sendStatus: jest.fn(),
  json: jest.fn(),
});

describe('GroupMe provider commands', () => {
  const integration = {
    _id: 'integration-1',
    podId: 'pod-1',
    config: {
      botId: 'bot-1',
      groupId: 'group-1',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('responds to !summary when buffer is empty', async () => {
    const latest = {
      ...integration,
      config: { ...integration.config, messageBuffer: [] },
    };
    Integration.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue(latest),
    });
    groupmeService.sendMessage.mockResolvedValue({ success: true });

    const provider = createGroupMeProvider(integration);
    const req = {
      body: {
        text: '!summary',
        group_id: 'group-1',
        sender_type: 'user',
        name: 'Sam',
        user_id: 'user-1',
      },
    };
    const res = buildRes();

    await provider.getWebhookHandlers().events(req, res);

    expect(groupmeService.sendMessage).toHaveBeenCalledWith(
      'bot-1',
      'No recent GroupMe activity to summarize.',
    );
    expect(IntegrationSummaryService.createSummary).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it('posts summary to pod and acknowledges in GroupMe', async () => {
    const latest = {
      ...integration,
      config: { ...integration.config, messageBuffer: [{ content: 'hello' }] },
    };
    Integration.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue(latest),
    });
    IntegrationSummaryService.createSummary.mockResolvedValue({
      content: 'summary',
      messageCount: 1,
      timeRange: { start: new Date(), end: new Date() },
      source: 'groupme',
      channelName: 'Group 1',
      summaryType: 'groupme-hourly',
    });

    AgentEventService.enqueue.mockResolvedValue({ _id: 'event-1' });
    groupmeService.sendMessage.mockResolvedValue({ success: true });

    const provider = createGroupMeProvider(integration);
    const req = {
      body: {
        text: '!summary',
        group_id: 'group-1',
        sender_type: 'user',
        name: 'Sam',
        user_id: 'user-1',
      },
    };
    const res = buildRes();

    await provider.getWebhookHandlers().events(req, res);

    expect(IntegrationSummaryService.createSummary).toHaveBeenCalled();
    expect(AgentEventService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'commonly-bot',
        podId: integration.podId,
        type: 'integration.summary',
      }),
    );
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
      integration._id,
      expect.objectContaining({
        'config.messageBuffer': [],
      }),
    );
    expect(groupmeService.sendMessage).toHaveBeenCalledWith(
      'bot-1',
      '✅ Queued GroupMe summary for Commonly Bot.',
    );
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it('sends latest pod summary on !pod-summary', async () => {
    const latest = {
      ...integration,
      config: { ...integration.config, messageBuffer: [] },
    };
    Integration.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue(latest),
    });

    const summary = { title: 'Pod Summary', content: 'Hello world' };
    Summary.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(summary),
      }),
    });

    groupmeService.sendMessage.mockResolvedValue({ success: true });

    const provider = createGroupMeProvider(integration);
    const req = {
      body: {
        text: '!pod-summary',
        group_id: 'group-1',
        sender_type: 'user',
        name: 'Sam',
        user_id: 'user-1',
      },
    };
    const res = buildRes();

    await provider.getWebhookHandlers().events(req, res);

    expect(groupmeService.sendMessage).toHaveBeenCalledWith(
      'bot-1',
      'Pod Summary\n\nHello world',
    );
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });
});
