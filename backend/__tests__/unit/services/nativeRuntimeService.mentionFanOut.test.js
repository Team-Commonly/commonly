/**
 * F62 (D234 Slack walk, 2026-11-02): a hosted agent's post runs the same
 * mention pipeline as an external agent's. Scout, as the Slack lead, posted
 * "@walk-claude-1102-claude-code-walk reply with …" and no event was ever
 * queued for that agent: the native runtime stored its posts and never called
 * the mention fan-out the runtime route and the webhook path both call.
 * Evidence: ~/.commonly/state/cto/walks/d234-slack-lead-1102/RESULT.md (operator
 * notes; the pod rows are 126960-126968).
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ name: 'Release room' }) })),
}));
jest.mock('../../../models/AgentRun', () => ({ create: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../../models/User', () => ({
  findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(null) }) })),
}));
jest.mock('../../../services/agentTypingService', () => ({ emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn() }));
jest.mock('../../../services/agentMessageService', () => ({ postMessage: jest.fn() }));
jest.mock('../../../services/agentMentionService', () => ({ enqueueAgentPost: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn().mockResolvedValue({ claimed: true, expiresAt: new Date() }),
  release: jest.fn().mockResolvedValue({ released: true }),
}));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../services/hostedRuntimeService', () => ({
  ...jest.requireActual('../../../services/hostedRuntimeService'),
  listHostedInstallationsForUser: jest.fn().mockResolvedValue([]),
}));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const AgentMessageService = require('../../../services/agentMessageService');
const AgentMentionService = require('../../../services/agentMentionService');
const { runAgent } = require('../../../services/nativeRuntimeService');

const POD = '507f1f77bcf86cd799439011';
const BOT = '507f1f77bcf86cd799439033';
const scout = {
  podId: POD,
  agentName: 'scout',
  instanceId: 'default',
  displayName: 'Scout',
  installedBy: '507f1f77bcf86cd799439099',
  config: { runtime: { runtimeType: 'native' }, tools: ['commonly_post_message', 'commonly_offer_hosted_agent'] },
};
const ask = {
  type: 'chat.mention',
  eventId: '507f1f77bcf86cd799439012',
  payload: { content: '💬 Sam (via Slack): @scout ask the Claude Code agent for a two-line welcome' },
};
const HANDOFF = '@claude-code please write a two-line welcome for the new teammates.';
const posted = (content) => ({
  id: 9001,
  content,
  userId: { _id: BOT, username: 'scout' },
  username: 'scout',
});

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

describe("a hosted agent's post reaches the agents it names", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    process.env.HOSTED_ENGINE = 'native';
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) }));
    AgentMessageService.postMessage.mockImplementation(async ({ content }) => ({ success: true, message: posted(content) }));
  });
  afterAll(() => { process.env = savedEnv; });

  test('a commonly_post_message post goes through the mention fan-out, as its poster', async () => {
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: HANDOFF }))
      .mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scout, ask);

    expect(AgentMentionService.enqueueAgentPost).toHaveBeenCalledTimes(1);
    expect(AgentMentionService.enqueueAgentPost).toHaveBeenCalledWith({
      podId: POD, message: posted(HANDOFF), userId: BOT, username: 'scout',
    });
  });

  test('a reply the model wrote without the tool goes through it too', async () => {
    axios.post.mockResolvedValueOnce(says(HANDOFF));

    await runAgent(scout, ask);

    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    expect(AgentMentionService.enqueueAgentPost).toHaveBeenCalledWith(expect.objectContaining({
      podId: POD, userId: BOT, username: 'scout',
    }));
  });

  test('the hosted offer is a post too', async () => {
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_offer_hosted_agent', { content: HANDOFF }))
      .mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scout, ask);

    expect(AgentMentionService.enqueueAgentPost).toHaveBeenCalledWith({
      podId: POD, message: posted(HANDOFF), userId: BOT, username: 'scout',
    });
  });

  test('a post the service skipped wakes no one', async () => {
    AgentMessageService.postMessage.mockResolvedValue({ success: true, skipped: true, reason: 'silent_or_empty' });
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: HANDOFF }))
      .mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scout, ask);

    expect(AgentMentionService.enqueueAgentPost).not.toHaveBeenCalled();
  });

  test('a fan-out failure leaves the post and the turn intact', async () => {
    AgentMentionService.enqueueAgentPost.mockRejectedValueOnce(new Error('queue down'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: HANDOFF }))
      .mockResolvedValueOnce(says('NO_REPLY'));

    const result = await runAgent(scout, ask);

    expect(result.status).toBe('succeeded');
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
  });
});
