/**
 * ADR-018 D3 — the native runtime claims before acting, like every driver we
 * ship. Gap found by the fleet's own implementation audit (Sharpen msg
 * 53016): the event queue pre-claims DELIVERY but nothing claimed the
 * MESSAGE, so two concurrent native agents could both act on one trigger.
 *
 * Contract under test:
 *  - message-shaped triggers claim payload.messageId before any run/LLM work
 *  - a lost CAS stands down: no AgentRun row, no LLM call, no typing, and
 *    the result reads as a successful (acked) no-op
 *  - a won claim runs, then releases in the same cleanup that stops typing
 *  - claim infrastructure failure fails OPEN (#887) — the run proceeds
 *  - triggers without a message (heartbeat) never touch the claim service
 */

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

jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn(),
  release: jest.fn(),
}));

jest.mock('../../../services/messageClaimHandoffService', () => ({
  release: jest.fn(),
}));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const MessageClaimService = require('../../../services/messageClaimService');
const MessageClaimHandoffService = require('../../../services/messageClaimHandoffService');
const AgentMessageService = require('../../../services/agentMessageService');
const typing = require('../../../services/agentTypingService');
const { runAgent } = require('../../../services/nativeRuntimeService');

const installation = {
  podId: 'pod-1',
  agentName: 'pod-summarizer',
  instanceId: 'default',
  displayName: 'Pod Summarizer',
  config: {
    runtime: { runtimeType: 'native' },
    systemPrompt: 'summarize',
    model: 'test/model',
    tools: [],
  },
};

describe('nativeRuntimeService claim-before-act (ADR-018 D3)', () => {
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
    MessageClaimHandoffService.release.mockResolvedValue({ released: true, handoff: { queued: true } });
    AgentRun.create.mockImplementation(async (doc) => ({
      _id: 'run-1',
      ...doc,
      save: jest.fn().mockResolvedValue(undefined),
    }));
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        choices: [{ message: { role: 'assistant', content: 'NO_REPLY' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
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

  const mentionTrigger = {
    type: 'chat.mention',
    eventId: 'evt-1',
    payload: { messageId: 'msg-77', content: 'hey @pod-summarizer' },
  };

  test('a won claim runs the turn, then releases in the same cleanup that stops typing', async () => {
    const result = await runAgent(installation, mentionTrigger);
    expect(MessageClaimService.claim).toHaveBeenCalledWith({
      messageId: 'msg-77', podId: 'pod-1', agentName: 'pod-summarizer', instanceId: 'default',
    });
    expect(AgentRun.create).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('succeeded');
    expect(MessageClaimService.release).toHaveBeenCalledWith({
      messageId: 'msg-77', agentName: 'pod-summarizer', instanceId: 'default', outcome: 'completed',
    });
    expect(typing.emitAgentTypingStop).toHaveBeenCalled();
  });

  test('a lost CAS stands down: no run row, no LLM call, no typing, acked no-op', async () => {
    MessageClaimService.claim.mockResolvedValue({ claimed: false, claimedBy: 'task-clerk' });
    const result = await runAgent(installation, mentionTrigger);
    expect(result).toEqual({
      runId: '', status: 'succeeded', totalTurns: 0, totalTokens: 0,
    });
    expect(AgentRun.create).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(typing.emitAgentTypingStart).not.toHaveBeenCalled();
    expect(MessageClaimService.release).not.toHaveBeenCalled();
  });

  test('a human wake that ends NO_REPLY declines into the shared one-seat handoff', async () => {
    AgentMessageService.postMessage.mockResolvedValueOnce({ success: true, skipped: true });
    const result = await runAgent(installation, {
      type: 'message.posted',
      eventId: 'evt-human-wake',
      payload: { messageId: 'msg-human', content: 'human update', senderIsHuman: true },
    });

    expect(result.status).toBe('succeeded');
    expect(MessageClaimHandoffService.release).toHaveBeenCalledWith({
      messageId: 'msg-human',
      agentName: 'pod-summarizer',
      instanceId: 'default',
      outcome: 'declined',
    });
    expect(MessageClaimService.release).not.toHaveBeenCalled();
  });

  test('claim infrastructure failure fails OPEN — the run proceeds unguarded (#887)', async () => {
    MessageClaimService.claim.mockRejectedValue(new Error('pg down'));
    const result = await runAgent(installation, mentionTrigger);
    expect(result.status).toBe('succeeded');
    expect(AgentRun.create).toHaveBeenCalledTimes(1);
    // Nothing was held, so nothing releases.
    expect(MessageClaimService.release).not.toHaveBeenCalled();
  });

  test('heartbeat triggers never touch the claim service', async () => {
    await runAgent(installation, { type: 'heartbeat', eventId: 'evt-2', payload: {} });
    expect(MessageClaimService.claim).not.toHaveBeenCalled();
  });
});
