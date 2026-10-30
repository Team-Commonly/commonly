/**
 * The per-run token budget counts usage summed over every model call in the
 * run, and each call re-sends the context. A hosted agent's ordinary research
 * turn (read the board, two searches, a fetch, post: five calls whose prompts
 * grow from ~3k to ~19k) sums past 60k with no runaway context at all.
 * Measured 10-24 to 10-26: 43 of one outside user's 73 assigned-task wakes
 * failed this way at the old 50k budget, some after the reply had posted.
 *
 * Contract under test: a five-call hosted run shaped like those, summing to
 * ~63k tokens, completes and posts; a run past the budget still stops.
 */


jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ name: 'Research' }) })),
}));
jest.mock('../../../models/AgentRun', () => ({ create: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../../models/User', () => ({
  findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(null) }) })),
  findById: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve({ entitlements: { pro: false }, isBot: false }) }) })),
}));
jest.mock('../../../services/agentTypingService', () => ({ emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn() }));
jest.mock('../../../services/agentMessageService', () => ({ postMessage: jest.fn() }));
jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn().mockResolvedValue({ claimed: true, expiresAt: new Date() }),
  release: jest.fn().mockResolvedValue({ released: true }),
}));
jest.mock('../../../services/messageClaimHandoffService', () => ({ handOff: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../models/pg/Message', () => ({ findByPodId: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../services/webSearchService', () => ({ isSearchConfigured: () => false, searchWeb: jest.fn() }));
const mockBridged = jest.fn();
jest.mock('../../../services/outsiderGrantPodEligibility', () => ({
  podIsBridged: (...args) => mockBridged(...args),
}));
jest.mock('../../../services/turnSandboxService', () => ({ isSandboxConfigured: () => false, TurnSandbox: jest.fn() }));
const mockGetPage = jest.fn();
jest.mock('../../../services/outboundUrlGuard', () => ({
  ...jest.requireActual('../../../services/outboundUrlGuard'),
  getFromPublicAddress: (...args) => mockGetPage(...args),
}));
jest.mock('../../../models/Message', () => {
  const chain = {
    sort: () => chain, limit: () => chain, select: () => chain, populate: () => chain, lean: () => Promise.resolve([]),
  };
  return { find: jest.fn(() => chain) };
});

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const AgentMessageService = require('../../../services/agentMessageService');
const { runAgent, HOSTED_RUN_FAILED_LINE } = require('../../../services/nativeRuntimeService');

const POD = '507f1f77bcf86cd799439011';
const OWNER = '507f1f77bcf86cd799439099';
const STOPPED_URL = 'https://stopped.example/blog';
const CLEAN_URL = 'https://clean.example/changelog';
const LATER_URL = 'https://later.example/releases';
const STOPPED_TEXT = 'A page the filter stops.';
const CLEAN_TEXT = 'Clean changelog entries.';
const LATER_TEXT = 'Later release notes.';
const GUARD_BODY = { error: { message: 'Rejected by guardrail: test-rule matched' } };

const hostedInstall = () => ({
  podId: POD,
  agentName: 'maya-agent',
  instanceId: 'default',
  displayName: 'Maya',
  installedBy: OWNER,
  config: { runtime: { runtimeType: 'hosted' }, hosted: { engine: 'native', provisionedAt: new Date() } },
});
const mention = {
  type: 'chat.mention',
  eventId: '507f1f77bcf86cd799439012',
  payload: {
    content: `@maya-agent read ${STOPPED_URL} and ${CLEAN_URL} and ${LATER_URL}`,
    userId: OWNER,
    messageId: 'msg-1',
  },
};

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolCalls = (...calls) => ({
  status: 200,
  headers: {},
  data: {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  },
});
const reply = (content) => ({
  status: 200,
  headers: {},
  data: { choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
});
const guardStop = { status: 400, headers: {}, data: GUARD_BODY };
const fetchCall = (id, url) => call(id, 'commonly_fetch_url', { url });

// The model's replies, in order. The guard check (no model call) answers by
// text: it stops only the page the filter stops.
let chatReplies;
let checkUnavailable;
let chatBodies;
const guardChecks = () => axios.post.mock.calls.filter(([url]) => url.endsWith('/guardrails/apply_guardrail'));
const offeredIn = (body) => body.tools.map((tool) => tool.function.name);
const posted = () => AgentMessageService.postMessage.mock.calls.map(([args]) => args.content);

describe('the hosted per-run token budget', () => {
  let savedRun;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    chatReplies = [];
    chatBodies = [];
    checkUnavailable = false;
    mockBridged.mockResolvedValue(false);
    AgentMessageService.postMessage.mockResolvedValue({ success: true });
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => {
      savedRun = { _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) };
      return savedRun;
    });
    const pages = { [STOPPED_URL]: STOPPED_TEXT, [CLEAN_URL]: CLEAN_TEXT, [LATER_URL]: LATER_TEXT };
    mockGetPage.mockImplementation(async (url) => ({
      ok: true, status: 200, contentType: 'text/html', text: pages[url], truncated: false, url,
    }));
    axios.post.mockImplementation(async (url, body) => {
      if (url.endsWith('/guardrails/apply_guardrail')) {
        if (checkUnavailable) return { status: 404, data: {} };
        return String(body.text).includes(STOPPED_TEXT) ? { status: 400, data: {} } : { status: 200, data: {} };
      }
      // The runtime re-sends one messages array; keep what each call carried.
      chatBodies.push(JSON.parse(JSON.stringify(body)));
      const next = chatReplies.shift();
      if (!next) throw new Error('unexpected model call');
      return next;
    });
  });

  // The same shape as the failed runs: prompt tokens per call, then usage.
  const withUsage = (response, prompt, completion) => ({
    ...response,
    data: { ...response.data, usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } },
  });

  test('a five-call research run summing past the old 50k budget completes and posts', async () => {
    chatReplies = [
      withUsage(toolCalls(fetchCall('c1', CLEAN_URL)), 3049, 100),
      withUsage(toolCalls(fetchCall('c2', CLEAN_URL)), 7584, 548),
      withUsage(toolCalls(fetchCall('c3', CLEAN_URL)), 11868, 1574),
      withUsage(toolCalls(fetchCall('c4', CLEAN_URL)), 13480, 3254),
      withUsage(reply('Here is the research summary.'), 18963, 3990),
    ];

    const result = await runAgent(hostedInstall(), mention);

    expect(result.totalTokens).toBeGreaterThan(50_000);
    expect(result.status).toBe('succeeded');
    expect(savedRun.errorKind).toBeUndefined();
    expect(posted()).toEqual(['Here is the research summary.']);
  });

  test('a run that has spent the budget stops before the next model call', async () => {
    chatReplies = [
      withUsage(toolCalls(fetchCall('c1', CLEAN_URL)), 150_000, 100),
      withUsage(toolCalls(fetchCall('c2', CLEAN_URL)), 60_000, 100),
      reply('Never asked.'),
    ];

    const result = await runAgent(hostedInstall(), mention);

    expect(result.status).toBe('failed');
    expect(savedRun.errorKind).toBe('token_cap');
    expect(chatBodies).toHaveLength(2);
  });
});
