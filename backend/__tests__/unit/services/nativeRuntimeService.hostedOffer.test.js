/**
 * Scout's hosted offer (QA 2026-10-16): asked "can Commonly host it?", Scout
 * answered with text directions and no link, while the Bring-your-own path got
 * a card. commonly_offer_hosted_agent posts the model's reply with one
 * server-composed button to Run it here, aimed at this pod.
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ name: 'My Workspace' }) })),
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
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));
const mockListHosted = jest.fn();
jest.mock('../../../services/hostedRuntimeService', () => ({
  ...jest.requireActual('../../../services/hostedRuntimeService'),
  listHostedInstallationsForUser: (...args) => mockListHosted(...args),
}));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const AgentMessageService = require('../../../services/agentMessageService');
const { runAgent } = require('../../../services/nativeRuntimeService');

const POD = '507f1f77bcf86cd799439011';
const OWNER = '507f1f77bcf86cd799439099';
const scoutInstall = {
  podId: POD,
  agentName: 'scout',
  instanceId: 'u1234567890',
  displayName: 'Scout',
  installedBy: OWNER,
  config: { runtime: { runtimeType: 'native' }, tools: ['commonly_post_message', 'commonly_offer_hosted_agent'] },
};
const ask = {
  type: 'chat.mention',
  eventId: '507f1f77bcf86cd799439012',
  payload: { content: 'I\'d rather not install anything. Can Commonly host it for me?' },
};
const REPLY = 'Yes. Commonly can run it for you, nothing to install.';

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

describe('commonly_offer_hosted_agent', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    process.env.HOSTED_ENGINE = 'native';
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) }));
    mockListHosted.mockResolvedValue([]);
  });
  afterAll(() => { process.env = savedEnv; });

  test('posts the reply once, with one Run it here button aimed at this pod with hosting chosen', async () => {
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_offer_hosted_agent', { content: REPLY }))
      .mockResolvedValueOnce(says('Posted the button above.'));

    const result = await runAgent(scoutInstall, ask);

    expect(result.status).toBe('succeeded');
    expect(mockListHosted).toHaveBeenCalledWith(OWNER);
    // The narration after the tool is not posted beside it.
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    const posted = AgentMessageService.postMessage.mock.calls[0][0];
    expect(posted.content).toBe(REPLY);
    expect(posted.podId).toBe(POD);
    expect(posted.payload).toEqual({
      kind: 'starts',
      starts: [{ id: 'run-hosted', label: 'Run it here', href: `/v2/agents/byo?pod=${POD}&mode=hosted` }],
    });
    // The thread renders a start's href only as an in-app /v2/ path.
    expect(posted.payload.starts[0].href).toMatch(/^\/v2\/[^/\\]/);
  });

  test('posts nothing when the person already holds the beta\'s hosted agent, and names it', async () => {
    mockListHosted.mockResolvedValue([{ agentName: 'lee-agent', instanceId: 'default', podId: POD }]);
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_offer_hosted_agent', { content: REPLY }))
      .mockResolvedValueOnce(says('You already have lee-agent. Mention it here.'));

    await runAgent(scoutInstall, ask);

    const toolMessage = axios.post.mock.calls[1][1].messages.find((m) => m.role === 'tool');
    expect(toolMessage.content).toMatch(/already have 1 hosted agent/);
    expect(toolMessage.content).toContain('lee-agent');
    // Only the model's own follow-up reached the pod, with no button.
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    expect(AgentMessageService.postMessage.mock.calls[0][0].payload).toBeUndefined();
  });

  test('is not offered where the instance cannot host, so no dead button is posted', async () => {
    delete process.env.HOSTED_ENGINE;
    delete process.env.HOSTED_RUNTIME_URL;
    delete process.env.HOSTED_RUNTIME_ADMIN_TOKEN;
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_offer_hosted_agent', { content: REPLY }))
      .mockResolvedValueOnce(says('Hosting is not available here.'));

    await runAgent(scoutInstall, ask);

    const offered = axios.post.mock.calls[0][1].tools.map((tool) => tool.function.name);
    expect(offered).not.toContain('commonly_offer_hosted_agent');
    const toolMessage = axios.post.mock.calls[1][1].messages.find((m) => m.role === 'tool');
    expect(toolMessage.content).toMatch(/not available to you in this turn/);
    expect(AgentMessageService.postMessage.mock.calls.every(([arg]) => arg.payload === undefined)).toBe(true);
  });
});
