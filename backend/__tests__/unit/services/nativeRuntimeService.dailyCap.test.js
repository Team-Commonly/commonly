/**
 * D4 cost ceiling — config.dailyRunCap in the native runtime.
 *
 * The Guide runs a paid model in every new user's workspace; the cap makes
 * its cost bounded by construction. Contract:
 *  - at cap → decline before ANY claim, run row, or LLM call
 *  - under cap → runs normally
 *  - count failure fails OPEN (#887's shape — infrastructure faults must
 *    not silence an agent)
 *  - no cap configured → the counter is never consulted
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
  },
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    lean: jest.fn().mockResolvedValue({ name: 'My Workspace' }),
  })),
}));

jest.mock('../../../models/AgentRun', () => ({
  create: jest.fn(),
  countDocuments: jest.fn(),
}));

jest.mock('../../../services/agentTypingService', () => ({
  emitAgentTypingStart: jest.fn(),
  emitAgentTypingStop: jest.fn(),
}));

jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn(),
  release: jest.fn(),
}));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const MessageClaimService = require('../../../services/messageClaimService');
const { runAgent } = require('../../../services/nativeRuntimeService');

const installation = (config = {}) => ({
  podId: 'pod-1',
  agentName: 'guide',
  instanceId: 'default',
  displayName: 'Guide',
  config: {
    runtime: { runtimeType: 'native' },
    systemPrompt: 'guide them',
    model: 'deepseek-v4-flash',
    tools: [],
    dailyRunCap: 3,
    ...config,
  },
});

const mentionTrigger = {
  type: 'chat.mention',
  eventId: 'evt-1',
  payload: { messageId: 'msg-1', content: 'hi @guide' },
};

describe('nativeRuntimeService daily run cap (D4)', () => {
  const previousEnv = {
    baseUrl: process.env.LITELLM_BASE_URL,
    masterKey: process.env.LITELLM_MASTER_KEY,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    MessageClaimService.claim.mockResolvedValue({ claimed: true, expiresAt: new Date() });
    MessageClaimService.release.mockResolvedValue({ released: true });
    AgentRun.create.mockImplementation(async (doc) => ({
      _id: 'run-1',
      ...doc,
      save: jest.fn().mockResolvedValue(undefined),
    }));
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        choices: [{ message: { role: 'assistant', content: 'NO_REPLY' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
      headers: {},
    });
  });

  afterAll(() => {
    if (previousEnv.baseUrl === undefined) delete process.env.LITELLM_BASE_URL;
    else process.env.LITELLM_BASE_URL = previousEnv.baseUrl;
    if (previousEnv.masterKey === undefined) delete process.env.LITELLM_MASTER_KEY;
    else process.env.LITELLM_MASTER_KEY = previousEnv.masterKey;
  });

  test('at cap: declines before any claim, run row, or LLM call', async () => {
    AgentRun.countDocuments.mockResolvedValue(3);
    const result = await runAgent(installation(), mentionTrigger);
    expect(result).toEqual({
      runId: '', status: 'succeeded', totalTurns: 0, totalTokens: 0,
    });
    expect(MessageClaimService.claim).not.toHaveBeenCalled();
    expect(AgentRun.create).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('under cap: runs normally', async () => {
    AgentRun.countDocuments.mockResolvedValue(2);
    const result = await runAgent(installation(), mentionTrigger);
    expect(result.status).toBe('succeeded');
    expect(AgentRun.create).toHaveBeenCalledTimes(1);
  });

  test('count failure fails OPEN — the run proceeds', async () => {
    AgentRun.countDocuments.mockRejectedValue(new Error('mongo down'));
    const result = await runAgent(installation(), mentionTrigger);
    expect(result.status).toBe('succeeded');
    expect(AgentRun.create).toHaveBeenCalledTimes(1);
  });

  test('no cap configured: the counter is never consulted', async () => {
    await runAgent(installation({ dailyRunCap: undefined }), mentionTrigger);
    expect(AgentRun.countDocuments).not.toHaveBeenCalled();
  });
});
