jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
  },
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    lean: jest.fn().mockResolvedValue({ name: 'Launch Room' }),
  })),
}));

jest.mock('../../../models/AgentRun', () => ({
  create: jest.fn(),
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
const AgentMessageService = require('../../../services/agentMessageService');
const { runAgent } = require('../../../services/nativeRuntimeService');

describe('nativeRuntimeService first_contact', () => {
  const previousEnv = {
    baseUrl: process.env.LITELLM_BASE_URL,
    masterKey: process.env.LITELLM_MASTER_KEY,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';

    AgentRun.create.mockImplementation(async (doc) => ({
      _id: 'run-1',
      ...doc,
      save: jest.fn().mockResolvedValue(undefined),
    }));
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        choices: [{ message: { role: 'assistant', content: 'Hi! What would you like help with?' } }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
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

  test('passes the inline first-contact cue to the model and records the trigger', async () => {
    const cue = 'Post a SHORT greeting that ends with exactly ONE answerable question.';

    const result = await runAgent(
      {
        podId: '507f1f77bcf86cd799439011',
        agentName: 'native-helper',
        instanceId: 'default',
        displayName: 'Native Helper',
        config: { runtime: { runtimeType: 'native' } },
      },
      {
        type: 'first_contact',
        eventId: '507f1f77bcf86cd799439012',
        payload: { content: cue },
      },
    );

    expect(AgentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'first_contact',
    }));
    expect(axios.post).toHaveBeenCalledWith(
      'http://litellm.test/chat/completions',
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: 'user', content: cue },
        ]),
      }),
      expect.any(Object),
    );
    expect(AgentMessageService.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Hi! What would you like help with?',
    }));
    expect(result).toEqual(expect.objectContaining({
      status: 'succeeded',
      finalMessage: 'Hi! What would you like help with?',
    }));
  });
});
