/**
 * A hosted turn the guard stops, or one that fails, must not leave the person
 * in silence or cost them a turn (2026-10-17: a research brief went unanswered
 * twice and used two turns, because the guard stopped on a site's footer).
 *
 * Contract under test:
 *  - a guard stop after page reads sets aside the result the guard stops on
 *    its own, keeps the clean ones, and gives the model one more round with no
 *    lookups, so the person gets an answer from one run
 *  - every round after the one that brought the stopped text in is dropped
 *  - when the check cannot be made, every web result from the first web round
 *    on is set aside
 *  - a failed hosted turn someone was waiting on, with nothing posted, gets one
 *    fixed line; a declined turn, a greeting and a turn that already posted
 *    get none
 *  - a failed hosted run that posted nothing is left off the person's meter
 *    and their plan line; the per-user spend ceiling still counts it
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

describe('a hosted turn the guard stops, or that fails', () => {
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

  test('sets aside the page the guard stops alone, keeps the clean one, and answers in one more round', async () => {
    chatReplies = [
      toolCalls(fetchCall('c1', STOPPED_URL), fetchCall('c2', CLEAN_URL)),
      guardStop,
      reply('Here is the changelog. I could not use the blog page.'),
    ];

    const result = await runAgent(hostedInstall(), mention);

    expect(result.status).toBe('succeeded');
    expect(savedRun.webSetAside).toBe(1);
    expect(savedRun.metered).toBeUndefined();
    const extra = JSON.stringify(chatBodies[2].messages);
    expect(extra).not.toContain(STOPPED_TEXT);
    expect(extra).toContain(CLEAN_TEXT);
    expect(extra).toMatch(/This result was set aside/);
    // No lookups in the extra round.
    expect(offeredIn(chatBodies[2])).not.toContain('commonly_fetch_url');
    expect(offeredIn(chatBodies[0])).toContain('commonly_fetch_url');
    expect(posted()).toEqual(['Here is the changelog. I could not use the blog page.']);
  });

  test('drops every round after the one that brought the stopped text in', async () => {
    chatReplies = [
      toolCalls(fetchCall('c1', STOPPED_URL)),
      // Chosen with the stopped page in front of the model.
      toolCalls(fetchCall('c2', LATER_URL)),
      guardStop,
      reply('I could not use the blog page.'),
    ];

    await runAgent(hostedInstall(), mention);

    const extra = chatBodies[3].messages;
    const text = JSON.stringify(extra);
    expect(text).not.toContain(STOPPED_TEXT);
    expect(text).not.toContain(LATER_TEXT);
    expect(extra.flatMap((m) => m.tool_calls || []).map((tc) => tc.id)).toEqual(['c1']);
    expect(extra.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['c1']);
  });

  test('when the check cannot be made, every web result from the first web round on is set aside', async () => {
    checkUnavailable = true;
    chatReplies = [
      toolCalls(fetchCall('c1', STOPPED_URL), fetchCall('c2', CLEAN_URL)),
      guardStop,
      reply('I could not use either page.'),
    ];

    await runAgent(hostedInstall(), mention);

    const extra = JSON.stringify(chatBodies[2].messages);
    expect(extra).not.toContain(STOPPED_TEXT);
    expect(extra).not.toContain(CLEAN_TEXT);
    expect(savedRun.webSetAside).toBe(2);
  });

  test('a stop the web results do not explain ends the run with the fixed line, and no turn used', async () => {
    chatReplies = [toolCalls(fetchCall('c1', CLEAN_URL)), guardStop];

    const result = await runAgent(hostedInstall(), mention);

    expect(result).toEqual(expect.objectContaining({ status: 'failed', errorKind: 'guardrail_blocked' }));
    expect(guardChecks()).not.toHaveLength(0);
    expect(chatBodies).toHaveLength(2);
    expect(savedRun.webSetAside).toBeUndefined();
    expect(savedRun.metered).toBe(false);
    expect(posted()).toEqual([HOSTED_RUN_FAILED_LINE]);
  });

  test('a second stop in the extra round ends the run, with one set-aside and one fixed line', async () => {
    chatReplies = [toolCalls(fetchCall('c1', STOPPED_URL)), guardStop, guardStop];

    const result = await runAgent(hostedInstall(), mention);

    expect(result.status).toBe('failed');
    expect(chatBodies).toHaveLength(3);
    expect(savedRun.webSetAside).toBe(1);
    expect(savedRun.metered).toBe(false);
    expect(posted()).toEqual([HOSTED_RUN_FAILED_LINE]);
  });

  test('a stop with no web read checks nothing and ends with the fixed line', async () => {
    chatReplies = [guardStop];

    await runAgent(hostedInstall(), mention);

    expect(guardChecks()).toHaveLength(0);
    expect(posted()).toEqual([HOSTED_RUN_FAILED_LINE]);
  });

  test('a model error with nothing posted gets the fixed line and uses no turn', async () => {
    chatReplies = [{ status: 502, headers: {}, data: { error: 'upstream unavailable' } }];

    const result = await runAgent(hostedInstall(), mention);

    expect(result).toEqual(expect.objectContaining({ status: 'failed', errorKind: 'llm_error' }));
    expect(savedRun.metered).toBe(false);
    expect(posted()).toEqual([HOSTED_RUN_FAILED_LINE]);
  });

  test('neither the fixed line nor the set-aside notice repeats the guard or the page', async () => {
    chatReplies = [toolCalls(fetchCall('c1', STOPPED_URL)), guardStop, guardStop];

    await runAgent(hostedInstall(), mention);

    const everything = JSON.stringify([chatBodies[2].messages, posted()]);
    expect(everything).not.toContain('test-rule');
    expect(everything).not.toContain(STOPPED_TEXT);
    expect(HOSTED_RUN_FAILED_LINE).not.toMatch(/filter|guard|page/i);
  });

  describe('the fixed line goes only to a turn someone was waiting on', () => {
    test('a declined turn (NO_REPLY) ends succeeded and posts nothing more', async () => {
      AgentMessageService.postMessage.mockResolvedValue({ skipped: true });
      chatReplies = [reply('NO_REPLY')];

      const result = await runAgent(hostedInstall(), mention);

      expect(result.status).toBe('succeeded');
      expect(posted()).toEqual(['NO_REPLY']);
      expect(savedRun.metered).toBeUndefined();
    });

    test('a silent turn (no text, no post) ends succeeded and posts nothing', async () => {
      chatReplies = [reply('')];

      const result = await runAgent(hostedInstall(), mention);

      expect(result.status).toBe('succeeded');
      expect(posted()).toEqual([]);
      expect(savedRun.metered).toBeUndefined();
    });

    test('a failed greeting posts nothing, though it costs no turn', async () => {
      chatReplies = [guardStop];

      await runAgent(hostedInstall(), { type: 'first_contact', eventId: '507f1f77bcf86cd799439013', payload: {} });

      expect(posted()).toEqual([]);
      expect(savedRun.metered).toBe(false);
    });

    test('a turn that posted before it failed counts, and gets no fixed line', async () => {
      chatReplies = [
        toolCalls(call('c1', 'commonly_post_message', { podId: POD, content: 'Here is what I found.' })),
        { status: 502, headers: {}, data: { error: 'upstream unavailable' } },
      ];

      const result = await runAgent(hostedInstall(), mention);

      expect(result.status).toBe('failed');
      expect(posted()).toEqual(['Here is what I found.']);
      expect(savedRun.metered).toBeUndefined();
    });

    test('a pod bridged mid-turn after a page read gets no fixed line', async () => {
      // The bridge is added once the page is in the turn.
      mockBridged.mockImplementation(async () => mockGetPage.mock.calls.length > 0);
      chatReplies = [toolCalls(fetchCall('c1', CLEAN_URL)), guardStop];

      await runAgent(hostedInstall(), mention);

      expect(posted()).toEqual([]);
      expect(savedRun.metered).toBe(false);
    });

    test('a native install that is not hosted is unchanged: no fixed line, no meter flag', async () => {
      chatReplies = [guardStop];

      await runAgent({
        podId: POD,
        agentName: 'analyst',
        instanceId: 'default',
        displayName: 'Analyst',
        installedBy: OWNER,
        config: { runtime: { runtimeType: 'native' }, tools: ['commonly_read_context', 'commonly_post_message'] },
      }, mention);

      expect(posted()).toEqual([]);
      expect(savedRun.metered).toBeUndefined();
    });
  });

  test('the plan line leaves unmetered runs out; the per-user spend ceiling counts every run', async () => {
    chatReplies = [reply('Done.')];

    await runAgent(hostedInstall(), mention);

    const queries = AgentRun.countDocuments.mock.calls.map(([query]) => query);
    const planLine = queries.find((query) => query.podId);
    const ceiling = queries.find((query) => query.userId);
    expect(planLine.metered).toEqual({ $ne: false });
    expect(ceiling).toBeDefined();
    expect(ceiling).not.toHaveProperty('metered');
  });
});
