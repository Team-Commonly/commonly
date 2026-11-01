/**
 * F46: Scout's turn carries the start command for the asker's own agent when
 * that agent has never connected. The cue is inline in the user message the
 * model reads, for Scout only, and only when a person's message woke it.
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ name: 'My Workspace' }) })),
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

jest.mock('../../../services/askerStartCommandCue', () => ({
  askerStartCommandCue: jest.fn(),
}));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const { askerStartCommandCue } = require('../../../services/askerStartCommandCue');
const { runAgent } = require('../../../services/nativeRuntimeService');

const installation = (agentName) => ({
  podId: 'pod-1',
  agentName,
  instanceId: 'default',
  displayName: agentName,
  config: {
    runtime: { runtimeType: 'native' }, systemPrompt: 'help', model: 'test/model', tools: [],
  },
});

const trigger = (type = 'chat.mention') => ({
  type,
  eventId: 'evt-1',
  payload: { messageId: 'm4', userId: 'human-1', content: 'how do I use this?' },
});

const sentUserMessage = () => axios.post.mock.calls[0][1].messages.find((m) => m.role === 'user').content;

const CUE = '[Their own agent has never connected] start it: commonly agent run kfir-agent';

describe('native runtime: Scout carries the start command for a never-connected agent', () => {
  const previousEnv = { baseUrl: process.env.LITELLM_BASE_URL, masterKey: process.env.LITELLM_MASTER_KEY };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    AgentRun.create.mockImplementation(async (doc) => ({
      _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined),
    }));
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        choices: [{ message: { role: 'assistant', content: 'NO_REPLY' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
      headers: {},
    });
    askerStartCommandCue.mockResolvedValue(CUE);
  });

  afterAll(() => {
    if (previousEnv.baseUrl === undefined) delete process.env.LITELLM_BASE_URL;
    else process.env.LITELLM_BASE_URL = previousEnv.baseUrl;
    if (previousEnv.masterKey === undefined) delete process.env.LITELLM_MASTER_KEY;
    else process.env.LITELLM_MASTER_KEY = previousEnv.masterKey;
  });

  test.each(['chat.mention', 'message.posted', 'dm.message'])('a %s from a person puts the cue ahead of their message', async (type) => {
    await runAgent(installation('scout'), trigger(type));

    expect(askerStartCommandCue).toHaveBeenCalledWith('pod-1', 'human-1');
    const sent = sentUserMessage();
    expect(sent.indexOf(CUE)).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf(CUE)).toBeLessThan(sent.indexOf('how do I use this?'));
  });

  test('another agent gets no cue and makes no lookup', async () => {
    await runAgent(installation('pixel'), trigger());

    expect(askerStartCommandCue).not.toHaveBeenCalled();
    expect(sentUserMessage()).not.toContain('never connected');
  });

  test('a turn no person wrote makes no lookup', async () => {
    await runAgent(installation('scout'), { type: 'heartbeat', eventId: 'evt-2', payload: {} });

    expect(askerStartCommandCue).not.toHaveBeenCalled();
  });

  test('a failed lookup leaves the turn as it was', async () => {
    askerStartCommandCue.mockRejectedValue(new Error('mongo blip'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await runAgent(installation('scout'), trigger());

    expect(sentUserMessage()).toContain('how do I use this?');
    expect(sentUserMessage()).not.toContain('never connected');
    warn.mockRestore();
  });
});
