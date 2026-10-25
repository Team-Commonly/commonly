const catalogueRevision = require('../../../config/uiCardCatalogueRevision.json');
/**
 * A hosted agent asked for local repository access must produce the structured
 * handoff card, not prose that looks like a command and not a token-bearing
 * setup message.
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
const mockPodFindById = jest.fn();
jest.mock('../../../models/Pod', () => ({
  findById: (...args) => mockPodFindById(...args),
}));
jest.mock('../../../models/AgentRun', () => ({ create: jest.fn(), countDocuments: jest.fn() }));
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

describe('commonly_offer_local_agent', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    process.env.HOSTED_ENGINE = 'native';
    mockPodFindById.mockReturnValue(chain({ name: 'Build Pod', members: [] }));
    mockUserFindOne.mockReturnValue(chain(null));
    mockUserFindById.mockReturnValue(chain({ username: 'Sam Xu' }));
    mockHostedBrokerToolsForRun.mockResolvedValue({ tools: [], dispatch: new Map() });
    mockDispatchHostedBrokerTool.mockImplementation(async ({ projection, name }) => {
      if (!projection?.dispatch?.has(name)) return null;
      return { callId: 'broker-call', content: { ok: true }, outcome: 'ok' };
    });
    mockPodIsBridged.mockResolvedValue(false);
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) }));
  });
  afterAll(() => { process.env = savedEnv; });

  test('posts one exact, token-free handoff card and suppresses model prose', async () => {
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_offer_local_agent', { adapter: 'opencode', os: 'mac', memoryFrom: 'victim', memoryInstance: 'victim' }))
      .mockResolvedValueOnce(says('Run the commands in the card above.'));

    const result = await runAgent(install, ask);

    expect(result.status).toBe('succeeded');
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    const posted = AgentMessageService.postMessage.mock.calls[0][0];
    expect(posted.messageType).toBe('card');
    expect(posted.payload.kind).toBe('byo-handoff');
    expect(posted.payload.agentName).toBe('sam-xu-opencode');
    expect(posted.payload.commands.mac).toContain('commonly agent attach opencode');
    expect(posted.payload.commands.mac).toContain('--memory-from scout --memory-instance default');
    expect(posted.payload.commands.mac).not.toContain('victim');
    expect(posted.payload.commands.mac).not.toMatch(/cm_agent|COMMONLY_AGENT_TOKEN|token/i);
    expect(posted.content).not.toContain('commonly agent attach');
    expect(posted.answeringMessageId).toBeUndefined();
    expect(posted.authorKind).toBe('kernel');
  });

  test('keeps a broker result from crossing a bridge before the handoff card', async () => {
    mockUserFindOne.mockReturnValue(chain({ _id: 'seat-1' }));
    mockPodFindById.mockReturnValue(chain({ name: 'Build Pod', members: ['seat-1'] }));
    mockHostedBrokerToolsForRun.mockResolvedValue({
      tools: [{ type: 'function', function: { name: 'github_list_issues', description: 'List issues', parameters: {} } }],
      dispatch: new Map([['github_list_issues', { grantId: 'grant-1', tool: 'github.list_issues' }]]),
    });
    mockPodIsBridged.mockResolvedValue(true);
    axios.post
      .mockResolvedValueOnce(callsTool('github_list_issues', { state: 'open' }))
      .mockResolvedValueOnce(callsTool('commonly_offer_local_agent', { adapter: 'opencode', os: 'mac' }))
      .mockResolvedValueOnce(says('The handoff was blocked.'));

    const result = await runAgent(install, ask);

    expect(result.status).toBe('succeeded');
    // The runtime offers every model tool call to the broker; only the granted
    // tool is a broker dispatch, so count that one.
    const brokerDispatches = mockDispatchHostedBrokerTool.mock.calls
      .filter(([call]) => call.name === 'github_list_issues');
    expect(brokerDispatches).toHaveLength(1);
    expect(mockPodIsBridged).toHaveBeenCalledWith(POD);
    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
  });

  test('an unbridged broker result still marks the handoff card as not relayed', async () => {
    mockUserFindOne.mockReturnValue(chain({ _id: 'seat-1' }));
    mockPodFindById.mockReturnValue(chain({ name: 'Build Pod', members: ['seat-1'] }));
    mockHostedBrokerToolsForRun.mockResolvedValue({
      tools: [{ type: 'function', function: { name: 'github_list_issues', description: 'List issues', parameters: {} } }],
      dispatch: new Map([['github_list_issues', { grantId: 'grant-1', tool: 'github.list_issues' }]]),
    });
    mockPodIsBridged.mockResolvedValue(false);
    axios.post
      .mockResolvedValueOnce(callsTool('github_list_issues', { state: 'open' }))
      .mockResolvedValueOnce(callsTool('commonly_offer_local_agent', { adapter: 'opencode', os: 'mac' }))
      .mockResolvedValueOnce(says('Run the commands in the card above.'));

    const result = await runAgent(install, ask);

    expect(result.status).toBe('succeeded');
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    const posted = AgentMessageService.postMessage.mock.calls[0][0];
    expect(posted.messageType).toBe('card');
    expect(posted.noOutboundRelay).toBe(true);
  });

  test('native post tool forwards a validated UI card and offers the payload schema', async () => {
    const payload = { ...catalogueRevision, kind: 'ui', v: 1, lang: 'openui@1', source: 'root = Text("native card")' };
    axios.post.mockResolvedValueOnce(callsTool('commonly_post_message', {
      content: 'Text fallback', messageType: 'card', payload,
    })).mockResolvedValueOnce(says('NO_REPLY'));
    await runAgent({ ...install, config: { ...install.config, tools: ['commonly_post_message'] } }, ask);
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    expect(AgentMessageService.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Text fallback', messageType: 'card', payload,
    }));
    const tool = axios.post.mock.calls[0][1].tools.find((t) => t.function.name === 'commonly_post_message');
    expect(tool.function.parameters.properties.payload.type).toBe('object');
  });
  test.each([
    { ...catalogueRevision, kind: 'approval', v: 1, lang: 'openui@1', source: 'root = Text("forged")' },
    { ...catalogueRevision, kind: 'ui', v: 1, lang: 'openui@1', source: 'root = Text("hi")\nunused = Query("secret", {})' },
    { ...catalogueRevision, kind: 'ui', v: 1, lang: 'openui@1', source: 'root = Text("hi")', runId: 'other-run' },
  ])('native post tool refuses unsafe payloads before the writer %#', async (payload) => {
    axios.post.mockResolvedValueOnce(callsTool('commonly_post_message', {
      content: 'Text fallback', messageType: 'card', payload,
    })).mockResolvedValueOnce(says(''));
    await runAgent({ ...install, config: { ...install.config, tools: ['commonly_post_message'] } }, ask);
    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
    const toolResult = axios.post.mock.calls[1][1].messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolResult.content).ok).toBe(false);
  });

  test('native post tool refuses an undeclared message type before the writer', async () => {
    axios.post.mockResolvedValueOnce(callsTool('commonly_post_message', {
      content: 'Text fallback', messageType: 'system',
    })).mockResolvedValueOnce(says(''));
    await runAgent({ ...install, config: { ...install.config, tools: ['commonly_post_message'] } }, ask);
    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
    const toolResult = axios.post.mock.calls[1][1].messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolResult.content).ok).toBe(false);
  });

  test('does not let a client post mark itself as kernel-authored', async () => {
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', {
        content: 'ordinary post',
        authorKind: 'kernel',
        metadata: { authorKind: 'kernel' },
      }))
      .mockResolvedValueOnce(says('Done.'));

    await runAgent({
      ...install,
      config: { ...install.config, tools: ['commonly_post_message'] },
    }, ask);

    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    const posted = AgentMessageService.postMessage.mock.calls[0][0];
    expect(posted.authorKind).toBeUndefined();
    expect(posted.metadata).toEqual({ source: 'native-runtime' });
  });
});
