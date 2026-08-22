/**
 * ADR-022 D5 invariant — the per-user daily ceiling.
 *
 * "A per-user daily ceiling — keyed on installedBy, summed across all hosted
 * installs — is a PREREQUISITE for offering the second hosted seat." This is
 * that ceiling. Contract, distinct from the per-install cap on purpose:
 *
 *  - runs stamp userId from installation.installedBy at creation (forward-
 *    only denormalization; the field never existed, no backfill possible)
 *  - at ceiling → decline BEFORE any claim, run row, or LLM call, and the
 *    result says so truthfully (status 'failed', errorKind 'user_ceiling') —
 *    never the per-install cap's false-success shape the plan called out
 *  - count failure fails CLOSED — a spend ceiling's safe direction is the
 *    opposite of a runaway-guard's (#887 fail-open stays correct for the
 *    per-install cap; it is deliberately wrong here)
 *  - an install with no installedBy proceeds with a warning — unattributable
 *    is not over-ceiling, and bricking legacy seats is not a spend control
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    lean: jest.fn().mockResolvedValue({ name: 'My Workspace' }),
  })),
}));

jest.mock('../../../models/AgentRun', () => ({
  create: jest.fn(),
  countDocuments: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  updateOne: jest.fn(),
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

const installation = (overrides = {}) => ({
  podId: 'pod-1',
  agentName: 'recorder',
  instanceId: 'u1234567890',
  displayName: 'Recorder',
  installedBy: 'user-42',
  config: {
    runtime: { runtimeType: 'native' },
    systemPrompt: 'keep the record',
    model: 'deepseek-v4-flash',
    tools: [],
  },
  ...overrides,
});

const mentionTrigger = {
  type: 'chat.mention',
  eventId: 'evt-1',
  payload: { messageId: 'msg-1', content: 'hi @recorder' },
};

describe('nativeRuntimeService per-user daily ceiling (ADR-022 D5)', () => {
  const previousEnv = {
    baseUrl: process.env.LITELLM_BASE_URL,
    masterKey: process.env.LITELLM_MASTER_KEY,
    ceiling: process.env.AGENT_USER_DAILY_RUN_CEILING,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    delete process.env.AGENT_USER_DAILY_RUN_CEILING;
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => ({
      ...doc,
      _id: 'run-1',
      save: jest.fn().mockResolvedValue(undefined),
    }));
    AgentRun.findByIdAndUpdate.mockResolvedValue({});
    AgentRun.updateOne.mockResolvedValue({});
    MessageClaimService.claim.mockResolvedValue({ claimed: true, expiresAt: new Date() });
    MessageClaimService.release.mockResolvedValue({ released: true });
    // One clean model turn with no tool calls, so under-ceiling runs finish.
    axios.post.mockResolvedValue({
      data: {
        choices: [{ message: { content: 'noted.' } }],
        usage: { total_tokens: 10 },
      },
    });
  });

  afterAll(() => {
    process.env.LITELLM_BASE_URL = previousEnv.baseUrl;
    process.env.LITELLM_MASTER_KEY = previousEnv.masterKey;
    if (previousEnv.ceiling === undefined) delete process.env.AGENT_USER_DAILY_RUN_CEILING;
    else process.env.AGENT_USER_DAILY_RUN_CEILING = previousEnv.ceiling;
  });

  it('stamps userId from installedBy on the created run row', async () => {
    await runAgent(installation(), mentionTrigger);
    expect(AgentRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-42' }),
    );
  });

  it('declines truthfully at the ceiling, before any model call', async () => {
    process.env.AGENT_USER_DAILY_RUN_CEILING = '5';
    // The user-keyed count — across ALL their installs, not this one's —
    // comes back at the ceiling.
    AgentRun.countDocuments.mockImplementation((q) => (
      Promise.resolve(q && q.userId === 'user-42' ? 5 : 0)
    ));

    const result = await runAgent(installation(), mentionTrigger);

    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('user_ceiling');
    expect(axios.post).not.toHaveBeenCalled();
    expect(AgentRun.create).not.toHaveBeenCalled();
  });

  it('counts by userId with the day window — not by installation', async () => {
    process.env.AGENT_USER_DAILY_RUN_CEILING = '5';
    await runAgent(installation(), mentionTrigger);
    const userQuery = AgentRun.countDocuments.mock.calls
      .map(([q]) => q).find((q) => q && q.userId);
    expect(userQuery).toBeDefined();
    expect(userQuery.userId).toBe('user-42');
    expect(userQuery.startedAt.$gte).toBeInstanceOf(Date);
    // The whole point: no per-install keys on the user query.
    expect(userQuery.agentName).toBeUndefined();
    expect(userQuery.instanceId).toBeUndefined();
    expect(userQuery.podId).toBeUndefined();
  });

  it('fails CLOSED when the count fails — a spend ceiling, not a runaway guard', async () => {
    process.env.AGENT_USER_DAILY_RUN_CEILING = '5';
    AgentRun.countDocuments.mockRejectedValue(new Error('mongo down'));

    const result = await runAgent(installation(), mentionTrigger);

    expect(result.status).toBe('failed');
    expect(result.errorKind).toBe('user_ceiling_check_failed');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('an install with no installedBy proceeds with a warning — unattributable is not over-ceiling', async () => {
    process.env.AGENT_USER_DAILY_RUN_CEILING = '5';
    const result = await runAgent(installation({ installedBy: undefined }), mentionTrigger);
    expect(result.status).not.toBe('failed');
    expect(axios.post).toHaveBeenCalled();
  });

  it('under the ceiling, the run proceeds to the model', async () => {
    process.env.AGENT_USER_DAILY_RUN_CEILING = '5';
    AgentRun.countDocuments.mockImplementation((q) => (
      Promise.resolve(q && q.userId === 'user-42' ? 4 : 0)
    ));
    const result = await runAgent(installation(), mentionTrigger);
    expect(result.status).not.toBe('failed');
    expect(axios.post).toHaveBeenCalled();
  });

  it('a non-positive ceiling disables the check entirely — the escape hatch', async () => {
    process.env.AGENT_USER_DAILY_RUN_CEILING = '0';
    await runAgent(installation(), mentionTrigger);
    const userQuery = AgentRun.countDocuments.mock.calls
      .map(([q]) => q).find((q) => q && q.userId);
    expect(userQuery).toBeUndefined();
    expect(axios.post).toHaveBeenCalled();
  });
});
