/**
 * What a native turn's final text does when nobody asked for it.
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ name: 'My Workspace' }) })),
}));
jest.mock('../../../models/AgentRun', () => ({ create: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../../models/User', () => ({
  findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(null) }) })),
  findById: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(null) }) })),
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
const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const User = require('../../../models/User');
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
const heartbeat = { type: 'heartbeat', eventId: '507f1f77bcf86cd799439012', payload: {} };
const resolved = {
  type: 'approval.resolved',
  eventId: '507f1f77bcf86cd799439013',
  payload: { content: '[Parked tool call resolved]\nlinear.create_issue: ran.' },
};
const ask = {
  type: 'chat.mention',
  eventId: '507f1f77bcf86cd799439014',
  payload: { content: 'is this done?', messageId: 'msg-1', userId: '507f1f77bcf86cd799439015' },
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

const REASONING = 'This is a periodic heartbeat. Nothing here is addressed to me, so I will stay quiet.';

/**
 * F304: over 30 days 96 native heartbeats ended in text and called no post tool.
 * 17 closed on NO_REPLY, and a keyword read puts the other 79 as narration. The
 * sentinel was stripped as leakage, so a reader saw the reasoning for staying
 * silent.
 */
describe('a turn nobody is waiting on', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) }));
    AgentMessageService.postMessage.mockResolvedValue({ success: true });
    axios.post.mockReset();
  });
  afterAll(() => { process.env = savedEnv; });

  it.each([
    ['reasoning that closes on the sentinel', `${REASONING}\n\nNO_REPLY`],
    ['reasoning with no sentinel', REASONING],
    ['a real-looking update in final text', 'Two issues opened today.'],
  ])('a heartbeat posts nothing from %s', async (_case, text) => {
    axios.post.mockResolvedValueOnce(says(text));
    const result = await runAgent(scoutInstall, heartbeat);
    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
    expect(result.status).toBe('succeeded');
  });

  it('a heartbeat still posts through the tool', async () => {
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { podId: POD, content: 'Two issues opened today.' }))
      .mockResolvedValueOnce(says('NO_REPLY'));
    await runAgent(scoutInstall, heartbeat);
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    expect(AgentMessageService.postMessage.mock.calls[0][0].content).toBe('Two issues opened today.');
  });

  it('another wake with no person asking is silent when its text closes on the sentinel', async () => {
    axios.post.mockResolvedValueOnce(says(`${REASONING}\n\nNO_REPLY`));
    await runAgent(scoutInstall, resolved);
    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
  });

  it('that wake still posts text with a next step', async () => {
    axios.post.mockResolvedValueOnce(says('The issue is filed. Next I can link it to the task.'));
    await runAgent(scoutInstall, resolved);
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
  });

  it('a person who asked keeps the answer, whatever it closes on', async () => {
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ isBot: false }) }) });
    axios.post.mockResolvedValueOnce(says('Yes, it merged.\n\nNO_REPLY'));
    await runAgent(scoutInstall, ask);
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
  });

  it('a mention sentinel inside the last line is left to the message service', async () => {
    axios.post.mockResolvedValueOnce(says('I answer with `NO_REPLY` when nothing needs saying.'));
    await runAgent(scoutInstall, resolved);
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
  });
});
