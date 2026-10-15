/**
 * TASK-266: a native turn that declares commonly_run_code can run code in a
 * per-turn sandbox; the sandbox is closed when the turn ends, and its seconds
 * are recorded on the AgentRun for the spend alarm.
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ name: 'Research' }) })),
}));
jest.mock('../../../models/AgentRun', () => ({ create: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../../models/User', () => ({
  findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(null) }) })),
}));
jest.mock('../../../services/agentTypingService', () => ({ emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn() }));
jest.mock('../../../services/agentMessageService', () => ({ postMessage: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn().mockResolvedValue({ claimed: true, expiresAt: new Date() }),
  release: jest.fn().mockResolvedValue({ released: true }),
}));
const mockRun = jest.fn();
const mockClose = jest.fn();
jest.mock('../../../services/turnSandboxService', () => ({
  isSandboxConfigured: () => true,
  TurnSandbox: jest.fn().mockImplementation(() => ({ run: mockRun, close: mockClose })),
}));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const { TurnSandbox } = require('../../../services/turnSandboxService');
const { runAgent } = require('../../../services/nativeRuntimeService');

const install = {
  podId: '507f1f77bcf86cd799439011',
  agentName: 'analyst',
  instanceId: 'default',
  displayName: 'Analyst',
  installedBy: '507f1f77bcf86cd799439099',
  config: { runtime: { runtimeType: 'native' }, tools: ['commonly_run_code', 'commonly_post_message'] },
};
const mention = { type: 'chat.mention', eventId: '507f1f77bcf86cd799439012', payload: { content: '@analyst what is 2**10?' } };

const toolCallReply = {
  status: 200,
  headers: {},
  data: {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'commonly_run_code', arguments: JSON.stringify({ language: 'python', code: 'print(2**10)' }) } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  },
};
const finalReply = {
  status: 200,
  headers: {},
  data: { choices: [{ message: { role: 'assistant', content: '1024' } }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
};

describe('native turn with commonly_run_code', () => {
  let savedRun;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => {
      savedRun = { _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) };
      return savedRun;
    });
    mockRun.mockResolvedValue({ ok: true, stdout: '1024\n', stderr: '' });
    mockClose.mockResolvedValue(7);
  });

  test('runs the code, feeds the output back, closes the sandbox and records its seconds', async () => {
    axios.post.mockResolvedValueOnce(toolCallReply).mockResolvedValueOnce(finalReply);

    const result = await runAgent(install, mention);

    expect(result.status).toBe('succeeded');
    expect(TurnSandbox).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith('python', 'print(2**10)');
    const secondCall = axios.post.mock.calls[1][1];
    const toolMessage = secondCall.messages.find((m) => m.role === 'tool');
    expect(toolMessage.content).toContain('1024');
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(savedRun.sandboxSeconds).toBe(7);
  });

  test('closes the sandbox even when the turn fails after running code', async () => {
    axios.post.mockResolvedValueOnce(toolCallReply).mockRejectedValueOnce(new Error('model down'));

    await runAgent(install, mention);

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(savedRun.sandboxSeconds).toBe(7);
  });

  test('a turn that runs no code opens no sandbox and records no seconds', async () => {
    axios.post.mockResolvedValueOnce(finalReply);
    await runAgent(install, mention);
    expect(TurnSandbox).not.toHaveBeenCalled();
    expect(savedRun.sandboxSeconds).toBeUndefined();
  });
});
