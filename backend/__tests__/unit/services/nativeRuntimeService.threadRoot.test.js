/**
 * TASK-026 — a hosted agent's reply to a mention made inside a thread must
 * carry that thread's root, or it lands at the pod root.
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ name: 'My Workspace' }) })),
}));
jest.mock('../../../models/AgentRun', () => ({ create: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../../models/User', () => ({
  findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(null) }) })),
  findById: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve({ username: 'ada' }) }) })),
}));
jest.mock('../../../services/hostedRuntimeService', () => ({
  ...jest.requireActual('../../../services/hostedRuntimeService'),
  listHostedInstallationsForUser: jest.fn().mockResolvedValue([]),
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

const axios = require('axios').default;
const AgentRun = require('../../../models/AgentRun');
const AgentMessageService = require('../../../services/agentMessageService');
const { threadRootOfTrigger, runAgent } = require('../../../services/nativeRuntimeService');

describe('threadRootOfTrigger (TASK-026)', () => {
  test('a mention inside a thread takes its root (camelCase, as the mention payload writes it)', () => {
    expect(threadRootOfTrigger({ messageId: 9, threadRootId: 4 })).toBe(4);
  });

  test('the snake_case field the message row carries is read too', () => {
    expect(threadRootOfTrigger({ thread_root_id: '7' })).toBe(7);
  });

  test('a top-level mention has no root, so the answer stays at the pod root', () => {
    expect(threadRootOfTrigger({ messageId: 9 })).toBeUndefined();
    expect(threadRootOfTrigger({ messageId: 9, threadRootId: null })).toBeUndefined();
  });

  test('a missing or malformed payload has no root', () => {
    expect(threadRootOfTrigger(null)).toBeUndefined();
    expect(threadRootOfTrigger(undefined)).toBeUndefined();
    expect(threadRootOfTrigger({ threadRootId: 'abc' })).toBeUndefined();
    expect(threadRootOfTrigger({ threadRootId: 0 })).toBeUndefined();
  });
});

// The trigger-to-post handoff: a threaded trigger must reach the post call,
// and a top-level trigger must post with null. Reverting either the tool
// post or the fallback post's threadRootId argument fails one of these.
const POD = '507f1f77bcf86cd799439011';
const OWNER = '507f1f77bcf86cd799439099';
const seat = {
  podId: POD,
  agentName: 'scout',
  instanceId: 'u1234567890',
  displayName: 'Scout',
  installedBy: OWNER,
  config: { runtime: { runtimeType: 'native' }, tools: ['commonly_post_message'] },
};
const threaded = {
  type: 'chat.mention',
  eventId: '507f1f77bcf86cd799439012',
  payload: { messageId: 9, threadRootId: 4, content: 'answer me in the thread' },
};
const topLevel = {
  type: 'chat.mention',
  eventId: '507f1f77bcf86cd799439013',
  payload: { messageId: 10, content: 'answer me at the root' },
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

describe('runAgent carries the trigger thread root to its post calls (TASK-026)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    process.env.HOSTED_ENGINE = 'native';
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) }));
  });

  test('the tool post in a thread passes the thread root', async () => {
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: 'in the thread' }))
      .mockResolvedValueOnce(says('Posted.'));

    await runAgent(seat, threaded);

    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    expect(AgentMessageService.postMessage.mock.calls[0][0].threadRootId).toBe(4);
  });

  test('the tool post at top level passes null, so the answer stays at the root', async () => {
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_post_message', { content: 'at the root' }))
      .mockResolvedValueOnce(says('Posted.'));

    await runAgent(seat, topLevel);

    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    expect(AgentMessageService.postMessage.mock.calls[0][0].threadRootId).toBeNull();
  });

  test('the fallback post in a thread passes the thread root when the model never calls a tool', async () => {
    axios.post.mockResolvedValueOnce(says('Plain reply, no tool.'));

    await runAgent(seat, threaded);

    const fallback = AgentMessageService.postMessage.mock.calls.find(([arg]) => arg.metadata?.fallback);
    expect(fallback).toBeDefined();
    expect(fallback[0].threadRootId).toBe(4);
  });
});

describe('runAgent carries the trigger thread root to the cards and the failed-run notice (TASK-026)', () => {
  const hostedSeat = { ...seat, config: { ...seat.config, tools: ['commonly_post_message', 'commonly_offer_hosted_agent'] } };
  const localSeat = { ...seat, config: { ...seat.config, tools: ['commonly_post_message', 'commonly_offer_local_agent'] } };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    process.env.HOSTED_ENGINE = 'native';
    AgentRun.countDocuments.mockResolvedValue(0);
    AgentRun.create.mockImplementation(async (doc) => ({ _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) }));
  });

  // Each test fails if its single threadRootId argument is reverted to null.
  test('the hosted-offer starts card in a thread passes the thread root', async () => {
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_offer_hosted_agent', { content: 'Scout can run hosted.' }))
      .mockResolvedValueOnce(says('Offered.'));

    await runAgent(hostedSeat, threaded);

    const card = AgentMessageService.postMessage.mock.calls.find(([arg]) => arg.payload?.kind === 'starts');
    expect(card).toBeDefined();
    expect(card[0].threadRootId).toBe(4);
  });

  test('the BYO approval card in a thread passes the thread root', async () => {
    axios.post
      .mockResolvedValueOnce(callsTool('commonly_offer_local_agent', { adapter: 'claude', os: 'mac' }))
      .mockResolvedValueOnce(says('Offered.'));

    await runAgent(localSeat, threaded);

    const card = AgentMessageService.postMessage.mock.calls.find(([arg]) => arg.metadata?.handoff === 'byo');
    expect(card).toBeDefined();
    expect(card[0].threadRootId).toBe(4);
  });

  test('the failed-run notice for a directly addressed thread mention passes the thread root', async () => {
    axios.post.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    await runAgent(seat, threaded);

    const notice = AgentMessageService.postMessage.mock.calls.find(([arg]) => arg.metadata?.runFailed);
    expect(notice).toBeDefined();
    expect(notice[0].threadRootId).toBe(4);
  });
});
