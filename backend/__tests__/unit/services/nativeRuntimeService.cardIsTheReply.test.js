/**
 * F290: on Haiku, 13 of 18 connect runs ended with closing text after the card.
 * The card is the reply, so that text must not post as a second message. A
 * later post is left to the prompt: refusing it would drop a person's other
 * answer, and in a thread the card lands at the top level.
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ name: 'My Workspace' }) })),
}));
jest.mock('../../../models/AgentRun', () => ({ create: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../../models/User', () => ({
  findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(null) }) })),
}));
jest.mock('../../../services/agentTypingService', () => ({ emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn() }));
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
  sanitizeAgentContent: jest.fn((text) => text),
}));
jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn().mockResolvedValue({ claimed: true, expiresAt: new Date() }),
  release: jest.fn().mockResolvedValue({ released: true }),
}));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));
const mockProposeAction = jest.fn();
jest.mock('../../../services/approvalActionService', () => ({
  proposeAction: (...args) => mockProposeAction(...args),
  suggestLocalAgentName: jest.fn(),
}));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const AgentMessageService = require('../../../services/agentMessageService');
const { runAgent } = require('../../../services/nativeRuntimeService');

const POD = '507f1f77bcf86cd799439011';
const scoutInstall = {
  podId: POD,
  agentName: 'scout',
  instanceId: 'u1234567890',
  displayName: 'Scout',
  installedBy: '507f1f77bcf86cd799439099',
  config: { runtime: { runtimeType: 'native' }, tools: ['commonly_post_message', 'commonly_propose_action'] },
};
const ask = {
  type: 'chat.mention',
  eventId: '507f1f77bcf86cd799439012',
  payload: { content: 'Claude Code on a Mac' },
};

const callsTool = (name, args) => ({
  status: 200,
  headers: {},
  data: {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  },
});
const says = (content) => ({
  status: 200,
  headers: {},
  data: {
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  },
});

const card = callsTool('commonly_propose_action', {
  actionType: 'connect_local_agent',
  params: { name: 'sams-claude', adapter: 'claude' },
  summary: 'Connect your Claude Code on this Mac to your workspace as sams-claude.',
});

describe('the approval card is the reply', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) }));
    AgentMessageService.postMessage.mockResolvedValue({ success: true });
    mockProposeAction.mockResolvedValue({ ok: true, approvalId: 'a1', messageId: 'm1' });
    axios.post.mockReset();
  });
  afterAll(() => { process.env = savedEnv; });

  test('a card keeps the closing text from posting as a second message', async () => {
    axios.post.mockResolvedValueOnce(card).mockResolvedValueOnce(says('Approve the card above to connect.'));

    await runAgent(scoutInstall, ask);

    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
  });
});
