/**
 * Scout's fixed offer (Growth, 2026-11-06). On "Start a pod for a project" and
 * any "I can't", the words, the task and the Run it here button are composed
 * here, because the prompt rule that asked the model for them did not hold.
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
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
  sanitizeAgentContent: jest.fn((text) => (String(text).startsWith('NO_REPLY') ? '' : text)),
}));
const mockEmitTaskUpdated = jest.fn();
jest.mock('../../../services/taskEventService', () => ({ emitTaskUpdated: (...args) => mockEmitTaskUpdated(...args) }));
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

const mockTask = { exists: jest.fn(), countDocuments: jest.fn(), create: jest.fn() };
jest.mock('../../../models/Task', () => mockTask);

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const AgentMessageService = require('../../../services/agentMessageService');
const { runAgent } = require('../../../services/nativeRuntimeService');
const { SCOUT_OFFER_COPY } = require('../../../config/native-agents/scout');

const POD = '507f1f77bcf86cd799439011';
const OWNER = '507f1f77bcf86cd799439099';
const scoutInstall = {
  podId: POD,
  agentName: 'scout',
  instanceId: 'u1234567890',
  displayName: 'Scout',
  installedBy: OWNER,
  config: { runtime: { runtimeType: 'native' }, tools: ['commonly_post_message', 'commonly_offer_own_agent'] },
};
const ask = {
  type: 'chat.mention',
  eventId: '507f1f77bcf86cd799439012',
  payload: { content: 'Start a pod for a project' },
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

const { en, 'zh-CN': zh } = SCOUT_OFFER_COPY;
const offer = (args) => { axios.post.mockResolvedValueOnce(callsTool('commonly_offer_own_agent', args)); };
const posted = () => AgentMessageService.postMessage.mock.calls.map(([call]) => call);

describe('commonly_offer_own_agent', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    process.env.HOSTED_ENGINE = 'native';
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) }));
    AgentMessageService.postMessage.mockResolvedValue({ success: true });
    mockListHosted.mockResolvedValue([]);
    mockTask.exists.mockResolvedValue(null);
    mockTask.countDocuments.mockResolvedValue(3);
    mockTask.create.mockImplementation(async (doc) => doc);
    axios.post.mockReset();
  });
  afterAll(() => { process.env = savedEnv; });

  test('adds the task once and posts the whole line, with the Run it here button', async () => {
    offer({ locale: 'en', addFirstTask: true });
    axios.post.mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scoutInstall, ask);

    expect(mockTask.create).toHaveBeenCalledTimes(1);
    expect(mockEmitTaskUpdated).toHaveBeenCalledWith(POD, expect.objectContaining({ title: en.firstTask }), 'created');
    expect(mockTask.create.mock.calls[0][0]).toMatchObject({ podId: POD, title: en.firstTask, status: 'pending', assignee: null });
    expect(posted()).toHaveLength(1);
    expect(posted()[0].content).toBe(`${en.taskOnBoard(en.firstTask)} ${en.withHosted}`);
    expect(posted()[0].payload).toEqual({
      kind: 'starts',
      starts: [{ id: 'run-hosted', label: 'Run it here', href: `/v2/agents/byo?pod=${POD}&mode=hosted` }],
    });
  });

  test('a second click adds no second row and says it is on the board', async () => {
    mockTask.exists.mockResolvedValue({ _id: 't1' });
    offer({ locale: 'en', addFirstTask: true });
    axios.post.mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scoutInstall, ask);

    expect(mockTask.exists).toHaveBeenCalledWith({ podId: POD, title: { $in: [en.firstTask, zh.firstTask] } });
    expect(mockTask.create).not.toHaveBeenCalled();
    expect(mockEmitTaskUpdated).not.toHaveBeenCalled();
    expect(posted()[0].content).toContain(en.taskOnBoard(en.firstTask));
  });

  test('a task that fails to save is not claimed, and the offer still goes out', async () => {
    mockTask.create.mockRejectedValue(new Error('db down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    offer({ locale: 'en', addFirstTask: true });
    axios.post.mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scoutInstall, ask);
    warn.mockRestore();

    expect(posted()[0].content).toBe(`${en.taskFailed} ${en.withHosted}`);
  });

  test.each([
    ['holds their hosted agents already', () => mockListHosted.mockResolvedValue([{ agentName: 'a' }, { agentName: 'b' }, { agentName: 'c' }])],
    ['cannot be counted', () => mockListHosted.mockRejectedValue(new Error('db down'))],
    ['is on an instance that cannot host', () => { delete process.env.HOSTED_ENGINE; }],
  ])('leaves out the button and its words when the person %s', async (_name, arrange) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    arrange();
    offer({ locale: 'en' });
    axios.post.mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scoutInstall, ask);
    warn.mockRestore();

    expect(posted()[0].content).toBe(en.withoutHosted);
    expect(posted()[0].payload).toBeUndefined();
  });

  test('an "I can\'t" adds no task and keeps the lead in front', async () => {
    offer({ locale: 'en', lead: 'I can\'t run commands on your computer.' });
    axios.post.mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scoutInstall, ask);

    expect(mockTask.create).not.toHaveBeenCalled();
    expect(posted()[0].content).toBe(`I can't run commands on your computer. ${en.withHosted}`);
  });

  test('a long lead is cut to one short line', async () => {
    offer({ locale: 'en', lead: `I can't ${'x'.repeat(400)}\nsecond line` });
    axios.post.mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scoutInstall, ask);

    expect(posted()[0].content).toBe(`I can't ${'x'.repeat(152)} ${en.withHosted}`);
  });

  test('a lead that is a sentinel cannot silence the offer', async () => {
    offer({ locale: 'en', lead: 'NO_REPLY' });
    axios.post.mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scoutInstall, ask);

    expect(posted()[0].content).toBe(en.withHosted);
  });

  test('a refused post is not counted as an answer, so the model\'s text still reaches the person', async () => {
    AgentMessageService.postMessage
      .mockResolvedValueOnce({ success: false, refused: true, reason: 'not_allowed' })
      .mockResolvedValue({ success: true });
    offer({ locale: 'en', addFirstTask: true });
    axios.post.mockResolvedValueOnce(says('I can\'t post that right now.'));

    await runAgent(scoutInstall, ask);

    expect(posted().map((call) => call.content)).toContain('I can\'t post that right now.');
  });

  test('reads in zh-CN, with the task title in Chinese', async () => {
    offer({ locale: 'zh-CN', addFirstTask: true });
    axios.post.mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scoutInstall, ask);

    expect(mockTask.create.mock.calls[0][0].title).toBe(zh.firstTask);
    expect(posted()[0].content).toBe(`${zh.taskOnBoard(zh.firstTask)} ${zh.withHosted}`);
  });

  test('anything else reads in English', async () => {
    offer({ locale: 'fr' });
    axios.post.mockResolvedValueOnce(says('NO_REPLY'));

    await runAgent(scoutInstall, ask);

    expect(posted()[0].content).toBe(en.withHosted);
  });

  test('does not post the model\'s closing text as a second message', async () => {
    offer({ locale: 'en' });
    axios.post.mockResolvedValueOnce(says('Offer sent.'));

    await runAgent(scoutInstall, ask);

    expect(posted()).toHaveLength(1);
  });
});
