/* eslint-disable global-require, import/no-unresolved, import/extensions --
   the requires must follow jest.mock, and this corpus resolves TS through the TS parser */
// F91 (D243): native turns run on the deployment's native model (Claude Haiku
// on dev), and a turn that holds a connector grant runs only on it, with no
// fallback, so connector data never reaches another vendor. Google's Limited
// Use for Calendar (F83) rests on this. Mocks as in the hosted-broker test.
const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({ __esModule: true, default: { post: (...args) => mockAxiosPost(...args) } }));

const mockSeatFind = jest.fn();
const mockSeatFindOne = jest.fn();
// The models are mocked with BOTH shapes on purpose: this file's code reaches
// them two ways — `nativeRuntimeService` uses the CommonJS `require(...)` it
// already used (`User.findOne`), and `grantBrokerProjectionService` uses a
// default import (`default.find`). Their real modules export both (the CJS-compat
// tail at the bottom of each model), so a mock that offers only one would fail on
// a shape the production code never sees.
//
// `find` is still mocked even though the seat lookup no longer calls it: it is
// the query the OLD name-pair resolution used, so a witness can hand it a
// DIFFERENT in-pod row and show which row the broker actually follows.
jest.mock('../../../models/User', () => ({
  __esModule: true,
  default: { find: (...args) => mockSeatFind(...args), findOne: (...args) => mockSeatFindOne(...args) },
  find: (...args) => mockSeatFind(...args),
  findOne: (...args) => mockSeatFindOne(...args),
}));

const mockPodFindById = jest.fn();
const mockPodFind = jest.fn();
jest.mock('../../../models/Pod', () => ({
  __esModule: true,
  default: {
    findById: (...args) => mockPodFindById(...args),
    find: (...args) => mockPodFind(...args),
  },
  findById: (...args) => mockPodFindById(...args),
  find: (...args) => mockPodFind(...args),
}));

const mockRoomGrantFind = jest.fn();
jest.mock('../../../models/RoomGrant', () => ({
  __esModule: true,
  default: { find: (...args) => mockRoomGrantFind(...args), findOne: jest.fn() },
  find: (...args) => mockRoomGrantFind(...args),
  findOne: jest.fn(),
}));

const mockCallTool = jest.fn();
const mockOutsiderGrantPolicy = jest.fn();
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: (...args) => mockOutsiderGrantPolicy(...args),
}));
jest.mock('../../../services/toolBrokerService', () => ({
  ...jest.requireActual('../../../services/toolBrokerService'),
  callTool: (...args) => mockCallTool(...args),
}));

const mockRunSave = jest.fn();
jest.mock('../../../models/AgentRun', () => ({
  create: jest.fn(),
  // The per-user ceiling and the daily cap both count through this model, and
  // the ceiling fails CLOSED on a missing counter (user_ceiling_check_failed),
  // so a mock without it silently turns every run into a failed run.
  countDocuments: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../../services/agentTypingService', () => ({
  emitAgentTypingStart: jest.fn(),
  emitAgentTypingStop: jest.fn(),
}));

jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
}));
// The pod-message read follows PG_HOST (TASK-503) and the unit setup unsets
// it, so name a host for the mocked PG model below to answer.
process.env.PG_HOST = 'pg.test';
jest.mock('../../../models/pg/Message', () => ({
  findByPodId: jest.fn().mockResolvedValue([]),
}));


// Read at module load, like LITELLM_CHAT_MODEL.
process.env.NATIVE_RUNTIME_MODEL = 'claude-haiku-5-5';
process.env.LITELLM_CHAT_MODEL = 'deepseek-v4-flash';
const AgentRun = require('../../../models/AgentRun');
const { postMessage } = require('../../../services/agentMessageService');
const { runAgent, nativeModelFor } = require('../../../services/nativeRuntimeService');

const POD = '507f1f77bcf86cd799439011';
const SEAT = '507f1f77bcf86cd799439013';
const NATIVE = 'claude-haiku-5-5';
const chain = (rows) => ({ select: () => ({ lean: async () => rows }) });

const installation = (model) => ({
  podId: POD,
  agentName: 'scout',
  instanceId: 'default',
  displayName: 'Scout',
  installedBy: '507f1f77bcf86cd799439099',
  config: { runtime: { runtimeType: 'native' }, tools: ['commonly_post_message'], ...(model ? { model } : {}) },
});
const CALENDAR_GRANT = {
  grantId: 'grant-calendar',
  target: { kind: 'seat', id: SEAT },
  audience: [SEAT],
  tools: ['google-calendar.list_events'],
  writeMode: 'read',
};
const reply = (content, finishReason = 'stop') => ({
  status: 200,
  data: {
    choices: [{ finish_reason: finishReason, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
  },
  headers: {},
});
const TRIGGER = { type: 'first_contact', eventId: '507f1f77bcf86cd799439012', payload: { content: 'what is on my calendar?' } };

beforeEach(() => {
  jest.clearAllMocks();
  mockOutsiderGrantPolicy.mockResolvedValue(false);
  process.env.LITELLM_BASE_URL = 'http://litellm.test';
  process.env.LITELLM_MASTER_KEY = 'test-key';
  mockPodFindById.mockReturnValue(chain({ name: 'Launch Room', members: [SEAT] }));
  mockPodFind.mockReturnValue(chain([{ _id: POD, members: [SEAT] }]));
  mockSeatFindOne.mockReturnValue({ select: () => ({ lean: async () => ({ _id: SEAT }) }) });
  mockSeatFind.mockReturnValue(chain([{ _id: SEAT }]));
  mockRoomGrantFind.mockReturnValue(chain([]));
  AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: mockRunSave }));
});

afterAll(() => {
  delete process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_MASTER_KEY;
  delete process.env.NATIVE_RUNTIME_MODEL;
  delete process.env.LITELLM_CHAT_MODEL;
});

describe('which model a native turn runs on', () => {
  test('the old platform default and an unset model both follow the native model', () => {
    const env = { nativeModel: NATIVE, chatModel: 'deepseek-v4-flash' };
    expect(nativeModelFor({ ...env, configured: undefined, connectorRun: false })).toBe(NATIVE);
    expect(nativeModelFor({ ...env, configured: 'deepseek-v4-flash', connectorRun: false })).toBe(NATIVE);
  });

  test('another pinned model is kept, unless the turn holds a connector grant', () => {
    const env = { nativeModel: NATIVE, chatModel: 'deepseek-v4-flash' };
    expect(nativeModelFor({ ...env, configured: 'gpt-5.4', connectorRun: false })).toBe('gpt-5.4');
    expect(nativeModelFor({ ...env, configured: 'gpt-5.4', connectorRun: true })).toBe(NATIVE);
  });

  test('with no native model set, nothing changes', () => {
    const env = { nativeModel: '', chatModel: 'deepseek-v4-flash' };
    expect(nativeModelFor({ ...env, configured: undefined, connectorRun: true })).toBe('deepseek-v4-flash');
    expect(nativeModelFor({ ...env, configured: 'gpt-5.4', connectorRun: true })).toBe('gpt-5.4');
  });

  test('Scout, stored with the old default, answers on the native model', async () => {
    mockAxiosPost.mockResolvedValueOnce(reply('Hi.'));
    await runAgent(installation('deepseek-v4-flash'), TRIGGER);
    const request = mockAxiosPost.mock.calls[0][1];
    expect(request.model).toBe(NATIVE);
    expect(request.disable_fallbacks).toBe(true);
  });

  test('a turn holding a Calendar grant calls only the native model, with no fallback', async () => {
    mockRoomGrantFind.mockReturnValue(chain([CALENDAR_GRANT]));
    mockAxiosPost.mockResolvedValueOnce(reply('Nothing today.'));
    // Pinned to a model that is not the native one: the grant still wins.
    await runAgent(installation('gpt-5.4'), TRIGGER);
    const request = mockAxiosPost.mock.calls[0][1];
    expect(request.tools.map((tool) => tool.function.name).some((name) => /calendar/.test(name))).toBe(true);
    expect(request.model).toBe(NATIVE);
    expect(request.disable_fallbacks).toBe(true);
  });

  test('the same pinned model without a grant keeps its pin', async () => {
    mockAxiosPost.mockResolvedValueOnce(reply('Hi.'));
    await runAgent(installation('gpt-5.4'), TRIGGER);
    expect(mockAxiosPost.mock.calls[0][1].model).toBe('gpt-5.4');
  });
});

describe('a refusal', () => {
  // Haiku 5.5 has no server-side fallback for a refusal; LiteLLM v1.106.2 maps
  // Anthropic's stop_reason "refusal" to finish_reason "content_filter".
  test('posts nothing of a partial answer and records a blocked run', async () => {
    mockAxiosPost.mockResolvedValueOnce(reply('Here is how to', 'content_filter'));
    const result = await runAgent(installation(), TRIGGER);
    expect(postMessage.mock.calls.some(([args]) => /Here is how to/.test(JSON.stringify(args)))).toBe(false);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const saved = await AgentRun.create.mock.results[0].value;
    expect(saved.status).toBe('failed');
    expect(saved.errorKind).toBe('guardrail_blocked');
    expect(saved.errorMessage).toMatch(/declined/);
    expect(result.status).toBe('failed');
  });
});
