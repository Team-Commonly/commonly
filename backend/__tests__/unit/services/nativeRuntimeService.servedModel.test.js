/**
 * TASK-028: a native turn records the model group that answered it beside the
 * one it requested. LiteLLM names the answering group in x-litellm-model-group
 * and counts fallback hops in x-litellm-attempted-fallbacks (v1.106.2); the
 * body's `model` is the second source.
 *
 * Real HTTP: axios is not mocked. A local server stands in for the LiteLLM
 * proxy and answers with the headers the proxy sends, so the header names and
 * their parsing are exercised as they arrive over the wire.
 */
const http = require('http');

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({
    lean: jest.fn().mockResolvedValue({ name: 'Served pod' }),
  })),
}));

jest.mock('../../../models/AgentRun', () => ({
  create: jest.fn(),
  countDocuments: jest.fn(),
}));

jest.mock('../../../services/agentTypingService', () => ({
  emitAgentTypingStart: jest.fn(),
  emitAgentTypingStop: jest.fn(),
}));

jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('../../../services/messageClaimService', () => ({
  claim: jest.fn(),
  release: jest.fn(),
}));

const AgentRun = require('../../../models/AgentRun');
const MessageClaimService = require('../../../services/messageClaimService');
const { runAgent } = require('../../../services/nativeRuntimeService');

const NEMOTRON = 'openrouter/nvidia/nemotron-3-super-120b-a12b:free';
const DEEPSEEK = 'deepseek-v4-flash';

let server;
let reply;
let requests;
let savedRun;
const previousEnv = { ...process.env };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/json', ...reply.headers });
      res.end(JSON.stringify({
        ...(reply.model ? { model: reply.model } : {}),
        choices: [{ message: { role: 'assistant', content: 'NO_REPLY' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }));
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.LITELLM_API_KEY = 'test-service-key';
});

afterAll(async () => {
  process.env = previousEnv;
  await new Promise((resolve) => { server.close(resolve); });
});

beforeEach(() => {
  jest.clearAllMocks();
  MessageClaimService.claim.mockResolvedValue({ claimed: true, expiresAt: new Date() });
  MessageClaimService.release.mockResolvedValue({ released: true });
  AgentRun.create.mockImplementation(async (doc) => {
    savedRun = { _id: 'run-1', ...doc, save: jest.fn().mockResolvedValue(undefined) };
    return savedRun;
  });
});

const installation = (model) => ({
  podId: 'pod-1',
  agentName: 'served',
  instanceId: 'default',
  displayName: 'Served',
  config: {
    runtime: { runtimeType: 'native' }, systemPrompt: 'answer', model, tools: [],
  },
});

const mention = {
  type: 'chat.mention',
  eventId: 'evt-1',
  payload: { messageId: 'msg-1', content: 'hi @served' },
};

const turnOf = async (model, nextReply) => {
  reply = nextReply;
  requests = [];
  const result = await runAgent(installation(model), mention);
  expect(result.status).toBe('succeeded');
  expect(requests).toHaveLength(1);
  const [turn] = savedRun.turns;
  return { model: turn.model, servedModel: turn.servedModel, fallbacks: turn.fallbacks };
};

test('a turn another group answered records both, and the hops', async () => {
  const turn = await turnOf(NEMOTRON, {
    // Through the proxy a fallback keeps the provider's own name in the body.
    model: 'deepseek/deepseek-chat',
    headers: { 'x-litellm-model-group': DEEPSEEK, 'x-litellm-attempted-fallbacks': '1' },
  });
  expect(turn).toEqual({ model: NEMOTRON, servedModel: DEEPSEEK, fallbacks: 1 });
  // The refusal still goes out: recording a fallback is not permission for one.
  expect(requests[0].body).toMatchObject({ model: NEMOTRON, disable_fallbacks: true });
});

test('a normal turn records the two equal, with no hops', async () => {
  const turn = await turnOf(DEEPSEEK, {
    model: DEEPSEEK,
    headers: { 'x-litellm-model-group': DEEPSEEK, 'x-litellm-attempted-fallbacks': '0' },
  });
  expect(turn).toEqual({ model: DEEPSEEK, servedModel: DEEPSEEK, fallbacks: undefined });
});

test('without the group header the body model is used, and without either nothing is recorded', async () => {
  expect(await turnOf(NEMOTRON, { model: DEEPSEEK, headers: {} }))
    .toEqual({ model: NEMOTRON, servedModel: DEEPSEEK, fallbacks: undefined });
  // An unmeasured turn is not recorded as served by the requested model.
  expect(await turnOf(NEMOTRON, { headers: { 'x-litellm-attempted-fallbacks': 'not-a-number' } }))
    .toEqual({ model: NEMOTRON, servedModel: undefined, fallbacks: undefined });
});
