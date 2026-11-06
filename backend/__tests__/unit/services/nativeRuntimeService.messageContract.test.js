jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
const mockPodFindById = jest.fn();
jest.mock('../../../models/Pod', () => ({
  findById: (...args) => mockPodFindById(...args),
}));
jest.mock('../../../models/AgentRun', () => ({ create: jest.fn(), countDocuments: jest.fn() }));
const mockRegistryExists = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: { exists: (...args) => mockRegistryExists(...args) },
}));
const mockUserFindOne = jest.fn();
const mockUserFindById = jest.fn();
jest.mock('../../../models/User', () => ({
  findOne: (...args) => mockUserFindOne(...args),
  findById: (...args) => mockUserFindById(...args),
}));
jest.mock('../../../services/agentTypingService', () => ({ emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn() }));
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
  sanitizeAgentContent: jest.fn((content) => content),
}));
jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn().mockResolvedValue({ claimed: true, expiresAt: new Date() }),
  release: jest.fn().mockResolvedValue({ released: true }),
}));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));
const mockPodIsBridged = jest.fn();
jest.mock('../../../services/outsiderGrantPodEligibility', () => ({
  podIsBridged: (...args) => mockPodIsBridged(...args),
}));
const mockHostedBrokerToolsForRun = jest.fn();
const mockDispatchHostedBrokerTool = jest.fn();
jest.mock('../../../services/grantBrokerProjectionService', () => ({
  hostedBrokerToolsForRun: (...args) => mockHostedBrokerToolsForRun(...args),
  dispatchHostedBrokerTool: (...args) => mockDispatchHostedBrokerTool(...args),
}));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const AgentMessageService = require('../../../services/agentMessageService');
const { runAgent } = require('../../../services/nativeRuntimeService');

const chain = (value) => ({
  select: () => ({ lean: () => Promise.resolve(value) }),
  lean: () => Promise.resolve(value),
});

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

const { hostedNativeSystemPrompt } = require('../../../services/hostedEngine');

// D245: hosted native posts adopt the message contract. The model sets the
// summary and kind on its own post; the runtime sets kind on the posts it
// composes; nothing is refused for them (warn-only).
describe('native posts carry the message contract (D245)', () => {
  const savedEnv = { ...process.env };
  const postOnly = { ...install, config: { ...install.config, tools: ['commonly_post_message'] } };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    process.env.HOSTED_ENGINE = 'native';
    mockPodFindById.mockReturnValue(chain({ name: 'Build Pod', members: [] }));
    mockUserFindOne.mockReturnValue(chain(null));
    mockUserFindById.mockReturnValue(chain({ username: 'Sam Xu' }));
    mockHostedBrokerToolsForRun.mockResolvedValue({ tools: [], dispatch: new Map() });
    mockDispatchHostedBrokerTool.mockResolvedValue(null);
    mockPodIsBridged.mockResolvedValue(false);
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) }));
    AgentMessageService.postMessage.mockResolvedValue({ success: true });
  });
  afterAll(() => { process.env = savedEnv; });

  test('the post tool offers summary and the six kinds, and neither is required', async () => {
    axios.post.mockResolvedValueOnce(says('NO_REPLY'));
    await runAgent(postOnly, ask);
    const tool = axios.post.mock.calls[0][1].tools.find((t) => t.function.name === 'commonly_post_message');
    const { properties, required } = tool.function.parameters;
    expect(properties.summary.type).toBe('string');
    expect(properties.kind.enum).toEqual(['answer', 'result', 'progress', 'ask', 'fyi', 'error']);
    expect(required).toEqual(['content']);
  });

  test('forwards the summary and kind the model sets', async () => {
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', {
        content: 'The test was failing on a stale fixture; I updated it.', summary: 'Fixed the failing test', kind: 'result',
      }))
      .mockResolvedValueOnce(says('NO_REPLY'));
    await runAgent(postOnly, ask);
    expect(AgentMessageService.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      summary: 'Fixed the failing test', kind: 'result',
    }));
  });

  test('a post without them passes neither key', async () => {
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: 'Hello.' }))
      .mockResolvedValueOnce(says('NO_REPLY'));
    await runAgent(postOnly, ask);
    const posted = AgentMessageService.postMessage.mock.calls[0][0];
    expect(posted).not.toHaveProperty('summary');
    expect(posted).not.toHaveProperty('kind');
  });

  test('a repaired value still posts, and the warning reaches the model in the tool result', async () => {
    const warnings = [{ code: 'kind_unknown', message: 'kind must be one of answer, result, progress, ask, fyi, error; it was not stored.' }];
    AgentMessageService.postMessage.mockResolvedValueOnce({ success: true, warnings });
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: 'Thinking about it.', kind: 'musing' }))
      .mockResolvedValueOnce(says('NO_REPLY'));
    const result = await runAgent(postOnly, ask);
    expect(result.status).toBe('succeeded');
    // Still counted as posted through the tool: no fallback second post.
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    const toolResult = JSON.parse(axios.post.mock.calls[1][1].messages.find((m) => m.role === 'tool').content);
    expect(toolResult).toMatchObject({ ok: true, posted: true });
    expect(toolResult.result.warnings).toEqual(warnings);
  });
});

describe('the hosted prompt says how a failure should read (F111, D247)', () => {
  test('in plain words, leaving out runtime terms unless they were asked about', () => {
    const prompt = hostedNativeSystemPrompt('Scout');
    expect(prompt).toContain('say in plain words what didn\'t work and what they can do next');
    expect(prompt).toContain('without event types, checkpoints, deliveries, retries, status codes or other runtime terms unless they asked about them');
  });
});

describe('the hosted posting instructions cue the contract inline (D245)', () => {
  test('names the six kinds and the one-line summary next to the post instruction', () => {
    const prompt = hostedNativeSystemPrompt('Scout');
    const postLine = prompt.split('\n').find((line) => line.includes('calling commonly_post_message once'));
    ['answer', 'result', 'progress', 'ask', 'fyi', 'error'].forEach((kind) => expect(postLine).toContain(kind));
    expect(postLine).toMatch(/summary/);
    expect(postLine).toContain('120');
    // The cue modifies the one post: it follows the post instruction directly,
    // ahead of the guidance on when not to post.
    expect(postLine).toMatch(/addressed to the pod\. Give that post a kind/);
    expect(postLine.indexOf('Give that post a kind')).toBeLessThan(postLine.indexOf('do not post'));
  });
});
