/**
 * TASK-654. A hosted run's token budget is usage summed over every model call
 * (each call re-sends the whole context), checked before the next call. A task
 * wake that reads the board and pod several times before it posts is the shape
 * that hit the cap. Two contracts, against a real HTTP model boundary and the
 * Mongo message pipeline:
 *  - a task wake with six tool calls before its post completes and posts;
 *  - a run that still hits a cap posts a line that names the budget, worded
 *    for who is waiting: the person who asked, or nobody on a kernel wake.
 */
const http = require('http');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

jest.mock('../../models/pg/Message', () => ({ findByPodId: jest.fn().mockResolvedValue([]) }));
jest.mock('../../services/agentTypingService', () => ({
  emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn(),
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
  runAgent, HOSTED_RUN_FAILED_LINE, HOSTED_RUN_BUDGET_LINE, HOSTED_WAKE_BUDGET_LINE,
} = require('../../services/nativeRuntimeService');

let server;
let previousEnv;
let owner;
let seat;
let pod;
let requests;
let script;

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const usage = (prompt, completion) => ({
  prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
});
const toolRound = (calls, prompt, completion) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }], usage: usage(prompt, completion),
});
const textRound = (content, prompt, completion) => ({
  choices: [{ message: { role: 'assistant', content } }], usage: usage(prompt, completion),
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
  owner = await User.create({
    username: 'budget-owner', email: 'budget-owner@example.test', password: 'test-password',
  });
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
});
afterEach(() => { process.env = previousEnv; });

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
// assignedTaskWakeService's shape: a kernel-authored chat.mention, no person.
const taskWake = () => ({
  type: 'chat.mention',
  payload: {
    triggerAuthor: 'kernel',
    assignedTaskWake: true,
    content: '[Your assigned work is still open]\n\n- TASK-1: Summarise this week in the pod', 
  }, 
});
const mention = () => ({
  type: 'chat.mention',
  payload: {
    content: '@budget-agent summarise this week',
    userId: String(owner._id), 
  }, 
});
const agentPosts = () => Message.find({ podId: pod._id, userId: seat._id }).sort({ createdAt: 1 }).lean();

test('a task wake with six tool calls before its post completes and posts', async () => {
  // Prompts grow ~3k to ~27k, as the failed wakes did. The sum is past twice
  // the old 50k budget; no single prompt is anywhere near a context limit.
  script = [
    toolRound([call('c1', 'commonly_read_context')], 3049, 100),
    toolRound([call('c2', 'commonly_read_memory')], 7584, 548),
    toolRound([call('c3', 'commonly_read_context', { messageCount: 50 })], 11868, 1574),
    toolRound([call('c4', 'commonly_read_memory')], 13480, 1254),
    toolRound([call('c5', 'commonly_read_context')], 16200, 1100),
    toolRound([call('c6', 'commonly_read_context', { messageCount: 40 })], 19800, 1200),
    toolRound(
      [call('c7', 'commonly_post_message', { content: 'TASK-1 summary: three rows closed this week.' })],
      23500,
      1900,
    ),
    textRound('', 27400, 20),
  ];

  const result = await runAgent(install(), taskWake());

  expect(result.status).toBe('succeeded');
  expect(result.totalTokens).toBeGreaterThan(100000);
  const saved = await AgentRun.findById(result.runId).lean();
  expect(saved.errorKind).toBeUndefined();
  expect(saved.turns).toHaveLength(8);
  expect(requests).toHaveLength(8);
  expect((await agentPosts()).map((m) => m.content)).toEqual(['TASK-1 summary: three rows closed this week.']);
});

test('an addressed run that hits the token budget tells the person why, in the room', async () => {
  script = [
    toolRound([call('c1', 'commonly_read_context')], 205000, 100),
    textRound('Never asked.', 10, 1),
  ];

  const result = await runAgent(install(), mention());

  expect(result).toMatchObject({ status: 'failed', errorKind: 'token_cap' });
  expect(requests).toHaveLength(1);
  const posts = await agentPosts();
  expect(posts.map((m) => m.content)).toEqual([HOSTED_RUN_BUDGET_LINE]);
  expect(posts[0].content).not.toBe(HOSTED_RUN_FAILED_LINE);
  expect((await AgentRun.findById(result.runId).lean()).metered).toBe(false);
});

test('a task wake that hits the token budget says the row is still open, not "ask again"', async () => {
  script = [
    toolRound([call('c1', 'commonly_read_context')], 205000, 100),
  ];

  const result = await runAgent(install(), taskWake());

  expect(result).toMatchObject({ status: 'failed', errorKind: 'token_cap' });
  expect((await agentPosts()).map((m) => m.content)).toEqual([HOSTED_WAKE_BUDGET_LINE]);
});

test('a run that hits the step cap gets the same budget line', async () => {
  script = Array.from({ length: 10 }, (_, i) => toolRound([call(`c${i}`, 'commonly_read_memory')], 1000, 10));

  const result = await runAgent(install(), mention());

  expect(result).toMatchObject({ status: 'failed', errorKind: 'turn_cap' });
  expect((await agentPosts()).map((m) => m.content)).toEqual([HOSTED_RUN_BUDGET_LINE]);
});
