const http = require('http');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

jest.mock('../../models/pg/Message', () => ({ findByPodId: jest.fn().mockResolvedValue([]) }));
jest.mock('../../services/agentTypingService', () => ({ emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn() }));
const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
jest.mock('../../config/socket', () => ({ getIO: () => ({ to: mockTo }) }));
jest.mock('../../services/installable/eventHandlers', () => ({ dispatch: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/starterTaskService', () => ({ completeFirstTaskOnAnswer: jest.fn() }));
jest.mock('../../services/agentComputerBroker', () => ({ agentComputerBroker: {}, agentComputerEnabled: false }));

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentRun = require('../../models/AgentRun');
const Message = require('../../models/Message');
const { runAgent } = require('../../services/nativeRuntimeService');
const AgentMessageService = require('../../services/agentMessageService');

let server;
let previousEnv;
let owner;
let seat;
let pod;
let requests;
let upstreamStatus;
const model = 'deepseek-v4-flash';
const privateReason = 'provider-secret-and-prompt-must-not-appear-in-chat';

beforeAll(async () => {
  await setupMongoDb();
  // A proxy-shaped HTTP boundary: substituting the fallback would turn a 5xx
  // into a successful answer. This makes removing disable_fallbacks observable.
  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.setHeader('Content-Type', 'application/json');
    if (upstreamStatus >= 500 && body.disable_fallbacks) {
      res.writeHead(upstreamStatus);
      res.end(JSON.stringify({ error: { message: privateReason } }));
    } else {
      res.end(JSON.stringify({ model: upstreamStatus >= 500 ? 'cloudflare/llama-3.1-8b' : model,
        choices: [{ message: { role: 'assistant', content: 'A model answer.' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeMongoDb();
});
beforeEach(async () => {
  previousEnv = { ...process.env };
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.LITELLM_MASTER_KEY = 'test-only';
  // Exercise the repository's Mongo message store and actual message pipeline;
  // socket/relay transports are external boundaries. The socket assertion also
  // proves this notice is emitted to the addressed pod, not merely constructed.
  delete process.env.PG_HOST;
  await Promise.all([User.deleteMany({}), Pod.deleteMany({}), AgentRun.deleteMany({}), Message.deleteMany({})]);
  owner = await User.create({ username: 'model-owner', email: 'model-owner@example.test', password: 'test-password' });
  seat = await User.create({ username: 'model-agent', email: 'model-agent@agents.commonly.local',
    password: 'test-password', isBot: true, botMetadata: { agentName: 'model-agent', instanceId: 'default' } });
  pod = await Pod.create({ name: 'Model failure test', type: 'team', createdBy: owner._id,
    members: [owner._id, seat._id], publicRead: false, joinPolicy: 'invite-only' });
  requests = [];
  jest.spyOn(AgentMessageService, 'postMessage');
  mockEmit.mockClear();
  mockTo.mockClear();
});
afterEach(() => { process.env = previousEnv; });

const run = (runtimeType = 'hosted') => runAgent({ podId: pod._id, agentName: 'model-agent', instanceId: 'default',
  installedBy: owner._id, config: { model, runtime: { runtimeType },
    ...(runtimeType === 'hosted' ? { hosted: { engine: 'native', provisionedAt: new Date() } } : {}) },
}, { type: 'chat.mention', payload: { content: 'Please answer.', userId: String(owner._id) } });

test.each(['hosted', 'native'])('a %s 503 persists failure and posts model/reason without substitution or private payload', async (runtimeType) => {
  upstreamStatus = 503;
  const result = await run(runtimeType);
  expect(result).toMatchObject({ status: 'failed', errorKind: 'llm_error' });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ model, disable_fallbacks: true });
  const saved = await AgentRun.findById(result.runId).lean();
  expect(saved.status).toBe('failed');
  expect(saved.errorMessage).toContain(model);
  expect(saved.errorMessage).toContain('HTTP 503');
  expect(saved.errorMessage).not.toContain(privateReason);
  expect(result.errorMessage).not.toContain(privateReason);
  expect(saved.turns).toHaveLength(0);
  if (runtimeType === 'hosted') expect(saved.metered).toBe(false);
  expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
  const message = AgentMessageService.postMessage.mock.calls[0][0];
  expect(message.content).toContain(model);
  expect(message.content).toContain('HTTP 503');
  expect(message.content).not.toContain(privateReason);
  expect(message.content).not.toContain('cloudflare');
  expect(message.metadata.runFailed).toBe(true);
  const delivered = await Message.findOne({ podId: pod._id, userId: seat._id }).lean();
  expect(delivered.content).toBe(message.content);
  expect(mockTo).toHaveBeenCalledWith(`pod_${pod._id}`);
  expect(mockEmit).toHaveBeenCalledWith('newMessage', expect.objectContaining({
    podId: String(pod._id), content: delivered.content,
  }));
});

test('a healthy default posts its answer and persists a successful turn', async () => {
  upstreamStatus = 200;
  const result = await run();
  expect(result.status).toBe('succeeded');
  const saved = await AgentRun.findById(result.runId).lean();
  expect(saved.turns[0].model).toBe(model);
  expect(AgentMessageService.postMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'A model answer.' }));
  expect(requests).toHaveLength(1);
});
