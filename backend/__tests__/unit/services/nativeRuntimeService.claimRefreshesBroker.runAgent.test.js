/**
 * TASK-340, the turn half. A task-bound grant reaches an agent only while it
 * holds the task's claim, and the broker's tools are assembled once per run. So
 * a claim made mid-turn re-reads the projection: the granted tool is offered
 * from the next round, without waiting for another wake. A refused claim does
 * not re-read it. The claim itself is pinned by service/native-claim-task.
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    lean: jest.fn().mockResolvedValue({ name: 'Walk Room' }),
    select: () => ({ lean: async () => ({ members: ['seat-1'] }) }),
  })),
}));
jest.mock('../../../models/AgentRun', () => ({ create: jest.fn() }));
jest.mock('../../../models/User', () => ({
  findById: jest.fn((id) => ({ select: () => ({ lean: async () => (String(id) === 'seat-1'
    ? { _id: 'seat-1', username: 'walk-seat', isBot: true, botMetadata: { agentName: 'scout', instanceId: 'default' } }
    : { isBot: false }) }) })),
  findOne: jest.fn(() => ({ select: () => ({ lean: async () => ({ _id: 'seat-1' }) }) })),
}));
jest.mock('../../../services/grantBrokerProjectionService', () => ({
  hostedBrokerToolsForRun: jest.fn(),
  dispatchHostedBrokerTool: jest.fn(),
}));
const mockClaimTaskAs = jest.fn();
jest.mock('../../../routes/tasksApi', () => ({
  claimTaskAs: (...args) => mockClaimTaskAs(...args),
  claimantOf: async (req) => ({ userId: String(req.userId), claimedBy: 'default' }),
}));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({ podHasOutsiderWritableGrant: jest.fn(async () => false) }));
jest.mock('../../../services/agentTypingService', () => ({ emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn() }));
jest.mock('../../../services/outsiderGrantPodEligibility', () => ({ podIsBridged: jest.fn(async () => false) }));
jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn().mockResolvedValue({ claimed: true }),
  release: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../services/agentMessageService', () => ({ postMessage: jest.fn().mockResolvedValue({ success: true }) }));

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const brokerProjection = require('../../../services/grantBrokerProjectionService');
const { runAgent } = require('../../../services/nativeRuntimeService');

const SEAT = {
  podId: '507f1f77bcf86cd799439011',
  agentName: 'scout',
  instanceId: 'default',
  displayName: 'Walk seat',
  config: { runtime: { runtimeType: 'native' }, tools: ['commonly_claim_task', 'commonly_post_message'] },
};
const MENTION = {
  type: 'chat.mention',
  eventId: '507f1f77bcf86cd799439012',
  payload: { messageId: 'm1', userId: 'u1', content: '@walk-seat claim TASK-001 and check Sentry' },
};
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolCalls = (...calls) => ({
  status: 200, headers: {},
  data: { choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
});
const modelSays = (content) => ({
  status: 200, headers: {},
  data: { choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
});
const GRANTED = { type: 'function', function: { name: 'sentry_find_organizations', description: 'granted', parameters: { type: 'object', properties: {} } } };
const offeredIn = (round) => axios.post.mock.calls[round][1].tools.map((tool) => tool.function.name);

describe('a claim mid-turn re-reads the grant projection (TASK-340)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) }));
    brokerProjection.hostedBrokerToolsForRun
      .mockResolvedValueOnce({ tools: [], dispatch: new Map() })
      .mockResolvedValue({ tools: [GRANTED], dispatch: new Map([['sentry_find_organizations', {}]]) });
    axios.post
      .mockResolvedValueOnce(toolCalls(call('c1', 'commonly_claim_task', { taskId: 'TASK-001' })))
      .mockResolvedValueOnce(modelSays('Claimed TASK-001.'));
  });

  test('a successful claim offers the newly usable grant from the next round', async () => {
    mockClaimTaskAs.mockResolvedValue({ status: 200, task: { taskId: 'TASK-001', status: 'claimed' } });
    await runAgent(SEAT, MENTION);
    expect(mockClaimTaskAs).toHaveBeenCalledWith(SEAT.podId, 'TASK-001', expect.objectContaining({ userId: 'seat-1' }));
    expect(brokerProjection.hostedBrokerToolsForRun).toHaveBeenCalledTimes(2);
    expect(offeredIn(0)).not.toContain('sentry_find_organizations');
    expect(offeredIn(1)).toContain('sentry_find_organizations');
  });

  test('a tool the claim unlocks does not run in the same response', async () => {
    // One model response: claim, then the granted tool it was not yet offered.
    axios.post.mockReset();
    axios.post
      .mockResolvedValueOnce(toolCalls(
        call('c1', 'commonly_claim_task', { taskId: 'TASK-001' }),
        call('c2', 'sentry_find_organizations', {}),
      ))
      .mockResolvedValueOnce(modelSays('Claimed TASK-001.'));
    mockClaimTaskAs.mockResolvedValue({ status: 200, task: { taskId: 'TASK-001', status: 'claimed' } });
    await runAgent(SEAT, MENTION);
    expect(brokerProjection.hostedBrokerToolsForRun).toHaveBeenCalledTimes(2);
    expect(brokerProjection.dispatchHostedBrokerTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'sentry_find_organizations' }),
    );
    const refused = axios.post.mock.calls[1][1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c2');
    expect(JSON.parse(refused.content)).toMatchObject({ ok: false, error: expect.stringMatching(/not available to you in this turn/) });
  });

  test('a call in the claiming response resolves through the projection it was offered from', async () => {
    // Two grants expose one tool name. Before the claim it maps to grant A; the
    // claim makes grant B usable, and B sorts first. The name was offered from
    // A, so the same response's call must still go to A, not B's connection.
    brokerProjection.hostedBrokerToolsForRun.mockReset();
    brokerProjection.hostedBrokerToolsForRun
      .mockResolvedValueOnce({ tools: [GRANTED], dispatch: new Map([['sentry_find_organizations', { grantId: 'grant-a' }]]) })
      .mockResolvedValue({ tools: [GRANTED], dispatch: new Map([['sentry_find_organizations', { grantId: 'grant-b' }]]) });
    axios.post.mockReset();
    axios.post
      .mockResolvedValueOnce(toolCalls(
        call('c1', 'commonly_claim_task', { taskId: 'TASK-001' }),
        call('c2', 'sentry_find_organizations', {}),
      ))
      .mockResolvedValueOnce(toolCalls(call('c3', 'sentry_find_organizations', {})))
      .mockResolvedValueOnce(modelSays('Done.'));
    // As the real one does: null for a name outside the projection it was given.
    brokerProjection.dispatchHostedBrokerTool.mockImplementation(async ({ projection, name }) => (
      projection.dispatch.has(name) ? { callId: 'b', outcome: 'ok' } : null));
    mockClaimTaskAs.mockResolvedValue({ status: 200, task: { taskId: 'TASK-001', status: 'claimed' } });
    await runAgent(SEAT, MENTION);
    const grantsUsed = brokerProjection.dispatchHostedBrokerTool.mock.calls
      .map(([input]) => input.projection.dispatch.get(input.name)?.grantId)
      .filter(Boolean);
    expect(mockClaimTaskAs).toHaveBeenCalledTimes(1);
    // c2 in the claiming response stays on A; c3, a round later, uses the re-read projection.
    expect(grantsUsed).toEqual(['grant-a', 'grant-b']);
  });

  test('a refused claim leaves the projection as it was', async () => {
    mockClaimTaskAs.mockResolvedValue({ status: 409, body: { error: 'Task already claimed', claimedBy: 'someone' } });
    await runAgent(SEAT, MENTION);
    expect(brokerProjection.hostedBrokerToolsForRun).toHaveBeenCalledTimes(1);
    expect(offeredIn(1)).not.toContain('sentry_find_organizations');
  });
});
