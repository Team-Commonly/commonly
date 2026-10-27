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
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ name: 'Launch Room' }) })),
}));

jest.mock('../../../models/AgentRun', () => ({ create: jest.fn() }));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ isBot: false }) }) })),
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

jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
}));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const ApprovalAction = require('../../../models/ApprovalAction');
const AgentMessageService = require('../../../services/agentMessageService');
const { proposeAction, suggestLocalAgentName } = require('../../../services/approvalActionService');
const { podHasOutsiderWritableGrant } = require('../../../services/nativeOutsiderGrantPolicy');
const { runAgent } = require('../../../services/nativeRuntimeService');

const SCOUT = (tools) => ({
  podId: '507f1f77bcf86cd799439011',
  agentName: 'scout',
  instanceId: 'default',
  displayName: 'Scout',
  config: { runtime: { runtimeType: 'native' }, ...(tools ? { tools } : {}) },
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

  test('stays out in an outsider-granted pod, where only in-pod tools are offered', async () => {
    axios.post.mockResolvedValue(modelSays(''));
    podHasOutsiderWritableGrant.mockResolvedValue(true);

    await runAgent(SCOUT(['commonly_propose_action']), CONNECT_MESSAGE);

    expect(proposeAction).not.toHaveBeenCalled();
    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
  });
});
