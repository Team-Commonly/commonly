/**
 * TASK-417 — the connect-intent floor, driven through runAgent. The unit file
 * pins the rule and the helper; this one pins the turn: the floor fires only
 * when the model replied with nothing and the install offers propose_action.
 */
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    lean: jest.fn().mockResolvedValue({ name: 'Launch Room' }),
    select: () => ({ lean: async () => ({ members: ['seat-1'] }) }),
  })),
}));

jest.mock('../../../models/AgentRun', () => ({ create: jest.fn() }));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ isBot: false }) }) })),
  findOne: jest.fn(() => ({ select: () => ({ lean: async () => ({ _id: 'seat-1' }) }) })),
}));

jest.mock('../../../services/grantBrokerProjectionService', () => ({
  hostedBrokerToolsForRun: jest.fn(),
  dispatchHostedBrokerTool: jest.fn(),
}));

jest.mock('../../../models/ApprovalAction', () => ({ exists: jest.fn() }));

jest.mock('../../../services/approvalActionService', () => ({
  proposeAction: jest.fn(),
  suggestLocalAgentName: jest.fn(),
}));

jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn(),
}));

jest.mock('../../../services/agentTypingService', () => ({
  emitAgentTypingStart: jest.fn(),
  emitAgentTypingStop: jest.fn(),
}));

const mockBridged = jest.fn();
jest.mock('../../../services/outsiderGrantPodEligibility', () => ({
  podIsBridged: (...args) => mockBridged(...args),
}));

const mockSearchWeb = jest.fn();
jest.mock('../../../services/webSearchService', () => ({
  isSearchConfigured: () => true,
  searchWeb: (...args) => mockSearchWeb(...args),
}));

jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn().mockResolvedValue({ claimed: true }),
  release: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
}));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const ApprovalAction = require('../../../models/ApprovalAction');
const AgentMessageService = require('../../../services/agentMessageService');
const MessageClaimService = require('../../../services/messageClaimService');
const { proposeAction, suggestLocalAgentName } = require('../../../services/approvalActionService');
const { podHasOutsiderWritableGrant } = require('../../../services/nativeOutsiderGrantPolicy');
const brokerProjection = require('../../../services/grantBrokerProjectionService');
const { runAgent } = require('../../../services/nativeRuntimeService');

const SCOUT = (tools) => ({
  podId: '507f1f77bcf86cd799439011',
  agentName: 'scout',
  instanceId: 'default',
  displayName: 'Scout',
  config: { runtime: { runtimeType: 'native' }, ...(tools ? { tools } : {}) },
});

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolCalls = (...calls) => ({
  status: 200,
  headers: {},
  data: {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  },
});

const CONNECT_MESSAGE = {
  type: 'message.posted',
  eventId: '507f1f77bcf86cd799439012',
  payload: { messageId: 'm1', userId: 'u1', content: 'connect my Claude Code to this pod' },
};

// The model's reply: a text answer, or no content and no tool call at all.
const modelSays = (content) => ({
  status: 200,
  data: {
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  },
  headers: {},
});

describe('connect-intent floor through runAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    AgentRun.create.mockImplementation(async (doc) => ({
      _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined),
    }));
    ApprovalAction.exists.mockResolvedValue(null);
    suggestLocalAgentName.mockResolvedValue('sam-claude');
    proposeAction.mockResolvedValue({ ok: true });
    podHasOutsiderWritableGrant.mockResolvedValue(false);
    brokerProjection.hostedBrokerToolsForRun.mockResolvedValue({ tools: [], dispatch: new Map() });
    brokerProjection.dispatchHostedBrokerTool.mockResolvedValue({ callId: 'b1', outcome: 'ok' });
  });

  test('proposes the card when the model replies with nothing', async () => {
    axios.post.mockResolvedValue(modelSays(''));

    await runAgent(SCOUT(['commonly_propose_action']), CONNECT_MESSAGE);

    expect(proposeAction).toHaveBeenCalledTimes(1);
    expect(proposeAction.mock.calls[0][0]).toEqual(expect.objectContaining({
      actionType: 'connect_local_agent',
      params: { name: 'sam-claude', adapter: 'claude' },
    }));
  });

  test('stays out when the model already replied in text', async () => {
    axios.post.mockResolvedValue(modelSays('Open the connect page to link it.'));

    await runAgent(SCOUT(['commonly_propose_action']), CONNECT_MESSAGE);

    expect(proposeAction).not.toHaveBeenCalled();
  });

  test('stays out when the install does not declare propose_action', async () => {
    axios.post.mockResolvedValue(modelSays(''));

    await runAgent(SCOUT(['commonly_post_message']), CONNECT_MESSAGE);

    expect(proposeAction).not.toHaveBeenCalled();
  });

  test('a guardrail-blocked turn gets no connect card', async () => {
    mockSearchWeb.mockResolvedValue({ provider: 'exa', results: [{ title: 'x', url: 'https://example.com', text: 'x' }] });
    mockBridged.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    axios.post
      .mockResolvedValueOnce(toolCalls(call('s1', 'commonly_web_search', { query: 'connect' })))
      .mockResolvedValueOnce(modelSays('Open the connect page to link it.'));

    await runAgent(SCOUT(['commonly_propose_action', 'commonly_web_search']), CONNECT_MESSAGE);

    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
    expect(proposeAction).not.toHaveBeenCalled();
  });

  test('a broker-tainted turn in a bridged pod gets no connect card', async () => {
    // A granted broker tool ran this turn and the pod is bridged. dispatchTool
    // refuses commonly_propose_action here, so the floor must not post it.
    mockBridged.mockResolvedValue(true);
    axios.post
      .mockResolvedValueOnce(toolCalls(call('b1', 'commonly_brokered_lookup', {})))
      .mockResolvedValueOnce(modelSays(''));

    await runAgent(SCOUT(['commonly_propose_action', 'commonly_web_search']), CONNECT_MESSAGE);

    expect(brokerProjection.dispatchHostedBrokerTool).toHaveBeenCalled();
    expect(proposeAction).not.toHaveBeenCalled();
    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
  });

  test('a human connect turn that posts the card completes its claim', async () => {
    const humanConnect = {
      ...CONNECT_MESSAGE,
      payload: { ...CONNECT_MESSAGE.payload, senderIsHuman: true },
    };
    axios.post.mockResolvedValue(modelSays(''));

    const result = await runAgent(SCOUT(['commonly_propose_action']), humanConnect);

    expect(result.status).toBe('succeeded');
    expect(proposeAction).toHaveBeenCalledTimes(1);
    expect(MessageClaimService.release).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'm1',
      outcome: 'completed',
    }));
  });

  test('stays out in an outsider-granted pod, where only in-pod tools are offered', async () => {
    axios.post.mockResolvedValue(modelSays(''));
    podHasOutsiderWritableGrant.mockResolvedValue(true);

    await runAgent(SCOUT(['commonly_propose_action']), CONNECT_MESSAGE);

    expect(proposeAction).not.toHaveBeenCalled();
    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
  });
});
