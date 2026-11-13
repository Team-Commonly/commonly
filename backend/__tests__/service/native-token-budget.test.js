/**
 * F479 (re-lands #3047, TASK-654). A hosted run's budget is checked before each
 * model call: steps (MAX_TURNS), tokens summed over every call (MAX_TOKENS,
 * each call re-sends the whole context) and wall-clock time. A run that hits
 * one with nothing posted, on a turn a person asked for, tells that person it
 * ran out of budget: a reason they can act on, unlike the generic failure line.
 * A wake nobody asked for still posts nothing.
 *
 * Real: memory Mongo, the message pipeline, an HTTP model boundary.
 */
const http = require('http');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

jest.mock('../../models/pg/Message', () => ({ findByPodId: jest.fn().mockResolvedValue([]) }));
jest.mock('../../services/agentTypingService', () => ({
  emitAgentTypingStart: jest.fn(),
  emitAgentTypingStop: jest.fn(),
}));
jest.mock('../../config/socket', () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));
jest.mock('../../services/installable/eventHandlers', () => ({ dispatch: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/starterTaskService', () => ({ completeFirstTaskOnAnswer: jest.fn() }));
jest.mock('../../services/agentComputerBroker', () => ({ agentComputerBroker: {}, agentComputerEnabled: false }));

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentRun = require('../../models/AgentRun');
const Message = require('../../models/Message');
const {
  runAgent, forgetStopLines, HOSTED_RUN_FAILED_LINE, HOSTED_RUN_BUDGET_LINE,
} = require('../../services/nativeRuntimeService');

let server;
let previousEnv;
let owner;
let seat;
let pod;
let requests;
let script;
// Called with the request count after each model answer, so a test can move
// the clock between calls.
let onAnswered;

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const usage = (prompt, completion) => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
});
const toolRound = (calls, prompt, completion) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }],
  usage: usage(prompt, completion),
});
const textRound = (content, prompt, completion) => ({
  choices: [{ message: { role: 'assistant', content } }],
  usage: usage(prompt, completion),
});

beforeAll(async () => {
  await setupMongoDb();
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(raw));
      res.setHeader('Content-Type', 'application/json');
      const next = script.shift();
      if (!next) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: { message: 'unexpected model call' } }));
        return;
      }
      if (onAnswered) onAnswered(requests.length);
      res.end(JSON.stringify({ model: 'deepseek-v4-flash', ...next }));
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
});
afterAll(async () => {
  if (server) await new Promise((resolve) => { server.close(resolve); });
  await closeMongoDb();
});
beforeEach(async () => {
  previousEnv = { ...process.env };
  process.env.LITELLM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.LITELLM_MASTER_KEY = 'test-only';
  delete process.env.PG_HOST;
  await Promise.all([User.deleteMany({}), Pod.deleteMany({}), AgentRun.deleteMany({}), Message.deleteMany({})]);
  owner = await User.create({ username: 'budget-owner', email: 'budget-owner@example.test', password: 'test-password' });
  seat = await User.create({
    username: 'budget-agent',
    email: 'budget-agent@agents.commonly.local',
    password: 'test-password',
    isBot: true,
    botMetadata: { agentName: 'budget-agent', instanceId: 'default' },
  });
  pod = await Pod.create({
    name: 'Token budget test',
    type: 'team',
    createdBy: owner._id,
    members: [owner._id, seat._id],
    publicRead: false,
    joinPolicy: 'invite-only',
  });
  requests = [];
  script = [];
  onAnswered = null;
  forgetStopLines();
});
afterEach(() => {
  process.env = previousEnv;
  jest.restoreAllMocks();
});

const install = () => ({
  podId: pod._id,
  agentName: 'budget-agent',
  instanceId: 'default',
  installedBy: owner._id,
  config: {
    model: 'deepseek-v4-flash',
    runtime: { runtimeType: 'hosted' },
    hosted: { engine: 'native', provisionedAt: new Date() },
  },
});
const mention = () => ({
  type: 'chat.mention',
  payload: { content: '@budget-agent summarise this week', userId: String(owner._id), messageId: 'msg-1' },
});
// assignedTaskWakeService's shape: a kernel-authored chat.mention, no person.
const taskWake = () => ({
  type: 'chat.mention',
  payload: {
    triggerAuthor: 'kernel',
    assignedTaskWake: true,
    content: '[Your assigned work is still open]\n\n- TASK-1: Summarise this week in the pod',
  },
});
const agentPosts = async () => (await Message.find({ podId: pod._id, userId: seat._id }).sort({ createdAt: 1 }).lean())
  .map((m) => m.content);

test('a run a person asked for that hits the token budget tells them why', async () => {
  script = [
    toolRound([call('c1', 'commonly_read_context')], 205000, 100),
    textRound('Never asked.', 10, 1),
  ];

  const result = await runAgent(install(), mention());

  expect(result).toMatchObject({ status: 'failed', errorKind: 'token_cap' });
  expect(requests).toHaveLength(1);
  expect(await agentPosts()).toEqual([HOSTED_RUN_BUDGET_LINE]);
  expect(HOSTED_RUN_BUDGET_LINE).not.toBe(HOSTED_RUN_FAILED_LINE);
  expect((await AgentRun.findById(result.runId).lean()).metered).toBe(false);
});

test('a run that hits the step budget gets the same line', async () => {
  script = Array.from({ length: 10 }, (_, i) => toolRound([call(`c${i}`, 'commonly_read_context')], 1000, 10));

  const result = await runAgent(install(), mention());

  expect(result).toMatchObject({ status: 'failed', errorKind: 'turn_cap' });
  expect(await agentPosts()).toEqual([HOSTED_RUN_BUDGET_LINE]);
});

test('a run that hits the wall-clock budget gets the same line', async () => {
  const realNow = Date.now.bind(Date);
  let skew = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
  // The first answer lands 61 s into the run, past the 60 s budget.
  onAnswered = (count) => { if (count === 1) skew = 61000; };
  script = [
    toolRound([call('c1', 'commonly_read_context')], 1000, 10),
    textRound('Never asked.', 10, 1),
  ];

  const result = await runAgent(install(), mention());

  expect(result).toMatchObject({ status: 'failed', errorKind: 'timeout' });
  expect(requests).toHaveLength(1);
  expect(await agentPosts()).toEqual([HOSTED_RUN_BUDGET_LINE]);
});

test('a wake nobody asked for that hits the budget still posts nothing', async () => {
  script = [toolRound([call('c1', 'commonly_read_context')], 205000, 100)];

  const result = await runAgent(install(), taskWake());

  expect(result).toMatchObject({ status: 'failed', errorKind: 'token_cap' });
  expect(await agentPosts()).toEqual([]);
});

test('a failure that is not a budget keeps the generic line', async () => {
  // The model answers with nothing usable: a 500 on the only call.
  script = [];

  const result = await runAgent(install(), mention());

  expect(result.status).toBe('failed');
  expect(['token_cap', 'turn_cap', 'timeout']).not.toContain(result.errorKind);
  const posts = await agentPosts();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain(HOSTED_RUN_FAILED_LINE);
});
