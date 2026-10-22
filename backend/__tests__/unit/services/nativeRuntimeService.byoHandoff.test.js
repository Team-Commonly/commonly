/**
 * A hosted agent asked for local repository access must produce the structured
 * handoff card, not prose that looks like a command and not a token-bearing
 * setup message.
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ name: 'Build Pod' }) })),
}));
jest.mock('../../../models/AgentRun', () => ({ create: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../../models/User', () => ({
  findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(null) }) })),
  findById: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve({ username: 'Sam Xu' }) }) })),
}));
jest.mock('../../../services/agentTypingService', () => ({ emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn() }));
jest.mock('../../../services/agentMessageService', () => ({ postMessage: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn().mockResolvedValue({ claimed: true, expiresAt: new Date() }),
  release: jest.fn().mockResolvedValue({ released: true }),
}));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const AgentMessageService = require('../../../services/agentMessageService');
const { runAgent } = require('../../../services/nativeRuntimeService');

const POD = '507f1f77bcf86cd799439011';
const install = {
  podId: POD,
  agentName: 'scout',
  instanceId: 'default',
  displayName: 'Scout',
  installedBy: '507f1f77bcf86cd799439099',
  config: {
    runtime: { runtimeType: 'native' },
    tools: ['commonly_post_message', 'commonly_offer_local_agent'],
  },
};
const ask = {
  type: 'chat.mention',
  eventId: '507f1f77bcf86cd799439012',
  payload: { content: 'Please inspect my local repository and fix the failing test.' },
};
const callsTool = (name, args) => ({
  status: 200,
  headers: {},
  data: {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  },
});
const says = (content) => ({
  status: 200,
  headers: {},
  data: { choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
});

describe('commonly_offer_local_agent', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    process.env.HOSTED_ENGINE = 'native';
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) }));
  });
  afterAll(() => { process.env = savedEnv; });

  test('posts one exact, token-free handoff card and suppresses model prose', async () => {
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_offer_local_agent', { adapter: 'opencode', os: 'mac' }))
      .mockResolvedValueOnce(says('Run the commands in the card above.'));

    const result = await runAgent(install, ask);

    expect(result.status).toBe('succeeded');
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    const posted = AgentMessageService.postMessage.mock.calls[0][0];
    expect(posted.messageType).toBe('card');
    expect(posted.payload.kind).toBe('byo-handoff');
    expect(posted.payload.agentName).toBe('sam-xu-opencode');
    expect(posted.payload.commands.mac).toContain('commonly agent attach opencode');
    expect(posted.payload.commands.mac).not.toMatch(/cm_agent|COMMONLY_AGENT_TOKEN|token/i);
    expect(posted.content).not.toContain('commonly agent attach');
    expect(posted.answeringMessageId).toBeUndefined();
  });
});
