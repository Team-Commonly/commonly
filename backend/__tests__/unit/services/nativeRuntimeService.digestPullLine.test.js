jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
const mockPodFindById = jest.fn();
jest.mock('../../../models/Pod', () => ({
  findById: (...args) => mockPodFindById(...args),
}));
jest.mock('../../../models/AgentRun', () => ({ create: jest.fn(), countDocuments: jest.fn() }));
const mockRegistryExists = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: { exists: (...args) => mockRegistryExists(...args) },
}));
const mockUserFindOne = jest.fn();
const mockUserFindById = jest.fn();
jest.mock('../../../models/User', () => ({
  findOne: (...args) => mockUserFindOne(...args),
  findById: (...args) => mockUserFindById(...args),
}));
jest.mock('../../../services/agentTypingService', () => ({ emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn() }));
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
  sanitizeAgentContent: jest.fn((content) => content),
}));
jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn().mockResolvedValue({ claimed: true, expiresAt: new Date() }),
  release: jest.fn().mockResolvedValue({ released: true }),
}));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));
const mockPodIsBridged = jest.fn();
jest.mock('../../../services/outsiderGrantPodEligibility', () => ({
  podIsBridged: (...args) => mockPodIsBridged(...args),
}));
const mockHostedBrokerToolsForRun = jest.fn();
const mockDispatchHostedBrokerTool = jest.fn();
jest.mock('../../../services/grantBrokerProjectionService', () => ({
  hostedBrokerToolsForRun: (...args) => mockHostedBrokerToolsForRun(...args),
  dispatchHostedBrokerTool: (...args) => mockDispatchHostedBrokerTool(...args),
}));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const AgentMessageService = require('../../../services/agentMessageService');
const { runAgent } = require('../../../services/nativeRuntimeService');

const chain = (value) => ({
  select: () => ({ lean: () => Promise.resolve(value) }),
  lean: () => Promise.resolve(value),
});

const { digestConversationFrame, DIGEST_PULL_LINE } = require('../../../services/digestFrame');
const { NATIVE_DIGEST_PULL_LINE } = require('../../../services/nativeKernelCue');

/**
 * The digest's pull line, as the model is actually sent it (#3460). A native
 * turn rewrites the kernel's line to name commonly_read_context. An install
 * that declares its tools without that one must not be told to call it: the
 * counts stay, the pointer goes. Driven through runAgent, so what is asserted
 * is the user message on the wire, built from the install's own tool list.
 */
const POD = '507f1f77bcf86cd799439011';
const digest = digestConversationFrame([
  { payload: { messageId: 1, threadRootId: 129000 } },
  { payload: { messageId: 2 } },
]);
const wake = {
  type: 'message.posted',
  eventId: '507f1f77bcf86cd799439012',
  payload: { content: `New activity in the pod.\n\n${digest}` },
};
const installWith = (tools) => ({
  podId: POD,
  agentName: 'helper',
  instanceId: 'default',
  displayName: 'Helper',
  installedBy: '507f1f77bcf86cd799439099',
  config: { runtime: { runtimeType: 'native' }, ...(tools ? { tools } : {}) },
});
const says = (content) => ({
  status: 200,
  headers: {},
  data: { choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
});
const sent = () => {
  const [, request] = axios.post.mock.calls[0];
  return {
    user: request.messages.find((m) => m.role === 'user').content,
    offered: request.tools.map((t) => t.function.name),
  };
};

describe('the digest pull line names only a tool this agent is offered', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    process.env.HOSTED_ENGINE = 'native';
    mockPodFindById.mockReturnValue(chain({ name: 'Build Pod', members: [] }));
    mockUserFindOne.mockReturnValue(chain(null));
    mockUserFindById.mockReturnValue(chain({ username: 'Sam Xu' }));
    mockHostedBrokerToolsForRun.mockResolvedValue({ tools: [], dispatch: new Map() });
    mockDispatchHostedBrokerTool.mockResolvedValue(null);
    mockPodIsBridged.mockResolvedValue(false);
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) }));
    AgentMessageService.postMessage.mockResolvedValue({ success: true });
    axios.post.mockResolvedValueOnce(says('NO_REPLY'));
  });
  afterAll(() => { process.env = savedEnv; });

  it('points at commonly_read_context for an install that is given it', async () => {
    await runAgent(installWith(['commonly_post_message', 'commonly_read_context']), wake);
    const { user, offered } = sent();
    expect(offered).toContain('commonly_read_context');
    expect(user).toContain(NATIVE_DIGEST_PULL_LINE);
    expect(user).not.toContain(DIGEST_PULL_LINE);
  });

  it('points at it for an install with no tool list, which gets the default surface', async () => {
    await runAgent(installWith(null), wake);
    const { user, offered } = sent();
    expect(offered).toContain('commonly_read_context');
    expect(user).toContain(NATIVE_DIGEST_PULL_LINE);
  });

  it('names no context reader for an install that declares its tools without one, and keeps the counts', async () => {
    await runAgent(installWith(['commonly_post_message']), wake);
    const { user, offered } = sent();
    expect(offered).not.toContain('commonly_read_context');
    expect(user).not.toMatch(/commonly_read_context|commonly_get_messages/);
    expect(user).toContain('- thread 129000: 1 unread');
    expect(user).toContain('context only, no reply needed');
  });
});
