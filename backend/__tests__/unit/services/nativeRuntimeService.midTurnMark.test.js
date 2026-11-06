// The mark on a mention that landed during a turn is only worth anything if a
// hosted model reads it. It travels in payload.content, through the real
// runAgent and its cue pass, to the user message the model is sent.
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ name: 'Two owners' }) })),
}));
jest.mock('../../../models/AgentRun', () => ({ create: jest.fn() }));
jest.mock('../../../services/agentTypingService', () => ({
  emitAgentTypingStart: jest.fn(),
  emitAgentTypingStop: jest.fn(),
}));
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
}));
jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn().mockResolvedValue({ claimed: true, expiresAt: new Date() }),
  release: jest.fn().mockResolvedValue({ released: true }),
}));
jest.mock('../../../services/messageClaimHandoffService', () => ({
  release: jest.fn().mockResolvedValue({ released: true }),
}));
jest.mock('../../../models/pg/Message', () => ({ findByPodId: jest.fn() }));
jest.mock('../../../models/Message', () => ({ find: jest.fn() }));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const { runAgent } = require('../../../services/nativeRuntimeService');
const { midTurnFrame } = require('../../../services/mentionCoalesce');

const installation = {
  podId: 'pod-1',
  agentName: 'pixel',
  instanceId: 'default',
  displayName: 'pixel',
  config: {
    runtime: { runtimeType: 'native' }, systemPrompt: 'help', model: 'test/model', tools: [],
  },
};
const sentUserMessage = () => axios.post.mock.calls[0][1].messages.find((m) => m.role === 'user').content;

describe('a marked mention on a hosted turn', () => {
  const previous = { baseUrl: process.env.LITELLM_BASE_URL, key: process.env.LITELLM_MASTER_KEY };

  beforeEach(() => {
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    AgentRun.create.mockResolvedValue({
      _id: 'run-1', turns: [], totalTokens: 0, status: 'queued', save: jest.fn().mockResolvedValue(undefined),
    });
    axios.post.mockResolvedValue({
      data: {
        choices: [{ message: { role: 'assistant', content: 'NO_REPLY' }, finish_reason: 'stop' }],
        usage: { total_tokens: 1 },
      },
    });
  });

  afterAll(() => {
    if (previous.baseUrl === undefined) delete process.env.LITELLM_BASE_URL;
    else process.env.LITELLM_BASE_URL = previous.baseUrl;
    if (previous.key === undefined) delete process.env.LITELLM_MASTER_KEY;
    else process.env.LITELLM_MASTER_KEY = previous.key;
  });

  test.each([[true], [false]])('reaches the model intact (same asker: %s)', async (sameAsker) => {
    const mark = midTurnFrame({
      earlier: { messageId: '41', username: 'alice' }, sameAsker, username: 'bob',
    });
    await runAgent(installation, {
      type: 'chat.mention',
      eventId: 'evt-1',
      payload: {
        messageId: '42', userId: 'someone', content: `${mark}\nthe smoke check failed`,
      },
    });
    expect(sentUserMessage()).toContain(mark);
    expect(sentUserMessage()).toContain('the smoke check failed');
  });
});
