/* eslint-disable global-require, import/no-unresolved, import/extensions --
   the requires must follow jest.mock, and this corpus resolves TS through the TS parser */
// Row B (TASK-132), hosted half: a native run in a granted pod gets the broker.
//
// The broker's own checks (audience, write mode, budget, ToolCall row) are
// covered by `toolBrokerService.test.js` and are deliberately not re-tested
// here — `callTool` is stubbed exactly as `routes/mcpGrants.test.js` stubs it,
// so this file witnesses the HOSTED wiring:
//   - the run assembles the broker once and sends the tools to the model;
//   - the dispatch uses the projection's grant/tool and the run's seat id;
//   - a broker call is recorded by reference (callId + outcome), never by value;
//   - the runtime calls the broker on EVERY call, which is what lets a
//     mid-run revocation refuse the second one (vera 73751).
const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({ __esModule: true, default: { post: (...args) => mockAxiosPost(...args) } }));

const mockSeatFind = jest.fn();
// The models are mocked with BOTH shapes on purpose: this file's code reaches
// them two ways — `nativeRuntimeService` uses the CommonJS `require(...)` it
// already used (`User.find`), and `grantBrokerProjectionService` uses a default
// import (`default.find`). Their real modules export both (the CJS-compat tail
// at the bottom of each model), so a mock that offers only one would fail on a
// shape the production code never sees.
jest.mock('../../../models/User', () => ({
  __esModule: true,
  default: { find: (...args) => mockSeatFind(...args) },
  find: (...args) => mockSeatFind(...args),
}));

const mockPodFindById = jest.fn();
const mockPodFind = jest.fn();jest.mock('../../../models/Pod', () => ({
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

const AgentRun = require('../../../models/AgentRun');
const { runAgent, resolveSeatUserId } = require('../../../services/nativeRuntimeService');

const POD = '507f1f77bcf86cd799439011';
const SEAT = '507f1f77bcf86cd799439013';

// The seat lookup ends in `.select('_id').sort({ _id: 1 }).limit(5).lean()`.
// `seatSortArg` records the sort so the determinism claim is witnessed instead
// of assumed, and `seatRows` keeps the chain in one place.
let seatSortArg = null;
const seatRows = (rows) => {
  const tail = { limit: () => ({ lean: async () => rows }) };
  tail.sort = jest.fn((arg) => {
    seatSortArg = arg;
    return tail;
  });
  return { select: () => tail };
};

const INSTALLATION = {
  podId: POD,
  agentName: 'scout',
  instanceId: 'default',
  displayName: 'Scout',
  installedBy: '507f1f77bcf86cd799439099',
  config: { runtime: { runtimeType: 'native' }, tools: ['commonly_post_message'] },
};

const LIVE_GRANT = {
  grantId: 'grant-seat',
  target: { kind: 'seat', id: SEAT },
  audience: [SEAT],
  tools: ['github.list_issues'],
  writeMode: 'read',
};

// A grant minted for a row that is NOT a member of the pod the run happens in.
// A `seat` target carries no pod condition in the projection, so the only thing
// standing between this grant and execution inside someone else's pod is the
// identity resolution that feeds it (vera's HOLD on #1880).
const OUT_OF_POD_ROW = 'row-a';
const OUT_OF_POD_SEAT_GRANT = {
  grantId: 'grant-elsewhere',
  target: { kind: 'seat', id: OUT_OF_POD_ROW },
  audience: [OUT_OF_POD_ROW],
  tools: ['github.list_issues'],
  writeMode: 'read',
};

const toolCallTurn = (id = 'call_1') => ({
  status: 200,
  data: {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id,
          type: 'function',
          function: { name: 'github_list_issues', arguments: JSON.stringify({ state: 'open' }) },
        }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  },
  headers: {},
});

const finalTurn = {
  status: 200,
  data: {
    choices: [{ message: { role: 'assistant', content: 'Two issues are open.' } }],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
  },
  headers: {},
};

const chain = (rows) => ({ select: () => ({ lean: async () => rows }) });

beforeEach(() => {
  jest.clearAllMocks();
  seatSortArg = null;
  process.env.LITELLM_BASE_URL = 'http://litellm.test';
  process.env.LITELLM_MASTER_KEY = 'test-key';

  mockPodFindById.mockReturnValue(chain({ name: 'Launch Room', members: [SEAT] }));
  mockPodFind.mockReturnValue(chain([{ _id: POD, members: [SEAT] }]));
  mockSeatFind.mockReturnValue(seatRows([{ _id: SEAT }]));
  mockRoomGrantFind.mockReturnValue(chain([LIVE_GRANT]));
  AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: mockRunSave }));
});

afterAll(() => {
  delete process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_MASTER_KEY;
});

describe('a hosted run in a granted pod', () => {
  test('offers the broker tool to the model and runs the call through the broker', async () => {
    mockCallTool.mockResolvedValue({ callId: 'tool_call_1', result: [{ number: 7, title: 'Fix the relay' }] });
    mockAxiosPost.mockResolvedValueOnce(toolCallTurn()).mockResolvedValueOnce(finalTurn);

    const result = await runAgent(INSTALLATION, { type: 'first_contact', eventId: '507f1f77bcf86cd799439012', payload: { content: 'what is open?' } });

    // 1. The model was offered the broker tool, alongside the manifest's own.
    const firstRequest = mockAxiosPost.mock.calls[0][1];
    const offered = firstRequest.tools.map((tool) => tool.function.name);
    expect(offered).toContain('github_list_issues');
    expect(offered).toContain('commonly_post_message');
    expect(offered).not.toContain('commonly_propose_action');

    // 2. The call reached the broker with the projection's grant and tool, and
    //    with the run's own seat identity.
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledWith({
      grantId: 'grant-seat',
      agentUserId: SEAT,
      agentName: 'scout',
      instanceId: 'default',
      tool: 'github.list_issues',
      args: { state: 'open' },
    });

    // 3. The broker's result is what the model was given back.
    const secondRequest = mockAxiosPost.mock.calls[1][1];
    const toolMessage = secondRequest.messages.find((message) => message.role === 'tool');
    expect(JSON.parse(toolMessage.content)).toEqual([{ number: 7, title: 'Fix the relay' }]);

    // 4. The run records the call by reference: callId and outcome, no args and
    //    no result (the ToolCall row the broker writes is that trail).
    const recorded = result.runId && AgentRun.create.mock.results[0].value;
    const savedRun = await recorded;
    const recordedCall = savedRun.turns[0].toolCalls[0];
    expect(recordedCall).toEqual({
      name: 'github_list_issues',
      callId: 'tool_call_1',
      outcome: 'ok',
      elapsedMs: expect.any(Number),
    });
    expect(recordedCall.args).toBeUndefined();
    expect(recordedCall.result).toBeUndefined();
  });

  test('a revocation mid-run refuses the second call, because the broker is re-asked every time', async () => {
    mockCallTool
      .mockResolvedValueOnce({ callId: 'tool_call_1', result: { issues: [] } })
      .mockRejectedValueOnce(Object.assign(new Error('grant is revoked'), {
        code: 'grant_revoked',
        details: { recorded: true, callId: 'tool_call_refused' },
      }));
    mockAxiosPost
      .mockResolvedValueOnce(toolCallTurn('call_1'))
      .mockResolvedValueOnce(toolCallTurn('call_2'))
      .mockResolvedValueOnce(finalTurn);

    await runAgent(INSTALLATION, { type: 'first_contact', eventId: '507f1f77bcf86cd799439012', payload: { content: 'keep checking' } });

    const savedRun = await AgentRun.create.mock.results[0].value;
    // Each turn carries its own tool calls: call_1 in turn 1, call_2 in turn 2.
    const [first, second] = savedRun.turns.flatMap((turn) => turn.toolCalls);
    expect(first.outcome).toBe('ok');
    // The refusal is a broker call with a callId, not a silently dropped tool:
    // the model is told, and the run says which row carries the refusal.
    expect(second).toEqual({
      name: 'github_list_issues',
      callId: 'tool_call_refused',
      outcome: 'refused',
      elapsedMs: expect.any(Number),
    });
    const refusalMessage = mockAxiosPost.mock.calls[2][1].messages
      .filter((message) => message.role === 'tool')
      .pop();
    expect(JSON.parse(refusalMessage.content).error).toBe('grant_revoked');
  });

  test('a run with no live grant is offered no broker tool at all', async () => {
    mockRoomGrantFind.mockReturnValue(chain([]));
    mockAxiosPost.mockResolvedValueOnce(finalTurn);

    await runAgent(INSTALLATION, { type: 'first_contact', eventId: '507f1f77bcf86cd799439012', payload: { content: 'hello' } });

    const offered = mockAxiosPost.mock.calls[0][1].tools.map((tool) => tool.function.name);
    expect(offered.some((name) => name.startsWith('github'))).toBe(false);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  test('a seat that cannot be resolved gets no broker rather than a guess', async () => {
    mockSeatFind.mockReturnValue(seatRows([]));
    mockAxiosPost.mockResolvedValueOnce(finalTurn);

    await runAgent(INSTALLATION, { type: 'first_contact', eventId: '507f1f77bcf86cd799439012', payload: { content: 'hello' } });

    expect(mockCallTool).not.toHaveBeenCalled();
    expect(mockAxiosPost.mock.calls[0][1].tools.some((tool) => tool.function.name.startsWith('github'))).toBe(false);
  });

  test('a seat-target grant for a row that is not in this pod is not executed here (vera 73879)', async () => {
    // The whole finding in one test. Rows for this agent exist, none of them is a
    // member of the pod the run happens in, and a grant is live for one of those
    // out-of-pod rows. Resolving the identity by fallback (the row that happened
    // to come back first) puts that grant INSIDE this pod's run: the projection's
    // seat arm has no pod condition, so the fallback is the only gate there is.
    mockSeatFind.mockReturnValue(seatRows([{ _id: OUT_OF_POD_ROW }, { _id: 'row-b' }]));
    mockRoomGrantFind.mockReturnValue(chain([OUT_OF_POD_SEAT_GRANT]));
    mockAxiosPost.mockResolvedValueOnce(finalTurn);

    await runAgent(INSTALLATION, { type: 'first_contact', eventId: '507f1f77bcf86cd799439012', payload: { content: 'hello' } });

    expect(mockCallTool).not.toHaveBeenCalled();
    expect(mockAxiosPost.mock.calls[0][1].tools.some((tool) => tool.function.name.startsWith('github'))).toBe(false);
  });
});

describe('resolveSeatUserId', () => {
  test('prefers the row that is a member of the pod the run happens in', async () => {
    mockSeatFind.mockReturnValue(seatRows([{ _id: 'someone-else' }, { _id: SEAT }]));
    expect(await resolveSeatUserId(POD, 'scout', 'default')).toBe(SEAT);
  });

  test('asks for a deterministic order, so which row is picked cannot drift between runs', async () => {
    mockSeatFind.mockReturnValue(seatRows([{ _id: SEAT }]));
    await resolveSeatUserId(POD, 'scout', 'default');
    expect(seatSortArg).toEqual({ _id: 1 });
  });

  test('rows exist but none is in this pod: empty, never another row\u2019s identity (vera 73879)', async () => {
    // The case the preference cannot satisfy — the only one in which the old
    // fallback decided anything, and the one the earlier two tests missed.
    mockSeatFind.mockReturnValue(seatRows([{ _id: 'row-a' }, { _id: 'row-b' }]));
    expect(await resolveSeatUserId(POD, 'scout', 'default')).toBe('');
  });

  test('a lookup failure is empty, never a fabricated identity', async () => {
    mockPodFindById.mockImplementation(() => {
      throw new Error('mongo is down');
    });
    expect(await resolveSeatUserId(POD, 'scout', 'default')).toBe('');
  });
});
