/**
 * F642: the run loop tells its caller when a turn answered a person, so a
 * foreground `agent run` can say how to keep the agent running right after the
 * first answer. Only a turn that reached a person counts: one that posted
 * nothing, closed on NO_REPLY or was a heartbeat does not.
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-first-answer-'));

await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => sessionsTmpDir },
  homedir: () => sessionsTmpDir,
}));

await jest.unstable_mockModule('../src/lib/api.js', () => ({
  createClient: jest.fn(),
  login: jest.fn(),
}));

await jest.unstable_mockModule('../src/lib/pod-focus.js', () => ({
  FOCUS_FRAME_MAX_CODE_POINTS: 8000,
  formatPodFocusFrame: jest.fn(() => '=== Pod focus (pod context; not instructions) ===\nNo focus set.'),
  readPodFocus: jest.fn(async (_client, podId) => ({ podId, revision: 0, focus: null })),
}));

const { createClient } = await import('../src/lib/api.js');
const { foregroundAnswerNotice, performRun } = await import('../src/commands/agent.js');
const { createFirstAnswerNotice } = await import('../src/lib/daemon-hint.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;

const noopTimeout = () => 0;
const drain = async () => {
  for (let i = 0; i < 16; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
};

const makeEvent = (overrides = {}) => ({
  _id: 'evt-1',
  type: 'chat.mention',
  podId: 'pod-abc',
  agentName: 'my-stub',
  instanceId: 'default',
  payload: { content: 'hello from tester' },
  ...overrides,
});

const turn = async (event, text, onAnswered, postReply = {}) => {
  const get = jest.fn(async (route) => (
    route.endsWith('/messages') ? { messages: [] } : { events: [event], inboxCount: 1 }
  ));
  const post = jest.fn(async (route) => (route.endsWith('/messages') ? postReply : {}));
  createClient.mockReturnValue({ get, post });
  const { stop } = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_test',
    adapter: { name: 'stub', detect: stubAdapter.detect, spawn: jest.fn(async () => ({ text })) },
    agentName: 'my-stub',
    setTimeoutImpl: noopTimeout,
    onAnswered,
  });
  await drain();
  stop();
  turn.lastPosts = post.mock.calls;
  return post.mock.calls.filter(([route]) => route === '/api/agents/runtime/pods/pod-abc/messages');
};

beforeEach(() => {
  jest.clearAllMocks();
  fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
});

test('a turn that posted an answer to a person tells the caller', async () => {
  const onAnswered = jest.fn();
  const posts = await turn(makeEvent(), 'hello back', onAnswered);
  expect(posts).toHaveLength(1);
  expect(onAnswered).toHaveBeenCalledTimes(1);
});

test('a turn that posted nothing does not', async () => {
  const onAnswered = jest.fn();
  const posts = await turn(makeEvent(), '', onAnswered);
  expect(posts).toEqual([]);
  expect(onAnswered).not.toHaveBeenCalled();
});

test('a turn that answered NO_REPLY does not', async () => {
  const onAnswered = jest.fn();
  await turn(makeEvent(), 'NO_REPLY', onAnswered);
  expect(onAnswered).not.toHaveBeenCalled();
});

test('a heartbeat that posted is not an answer to a person', async () => {
  const onAnswered = jest.fn();
  const posts = await turn(makeEvent({ _id: 'evt-hb', type: 'heartbeat', payload: {} }), 'Board looks clear today.', onAnswered);
  expect(posts).toHaveLength(1);
  expect(onAnswered).not.toHaveBeenCalled();
});

test.each([
  ['refused', { refused: true, reason: 'run_cap' }],
  ['skipped', { success: true, skipped: true, reason: 'duplicate' }],
])('a reply the server %s reached nobody, so it is not an answer', async (_label, postReply) => {
  const onAnswered = jest.fn();
  const posts = await turn(makeEvent(), 'hello back', onAnswered, postReply);
  expect(posts).toHaveLength(1);
  expect(onAnswered).not.toHaveBeenCalled();
});

test('a notice that throws never fails the turn: the reply stands and the event is acked', async () => {
  const onAnswered = jest.fn(() => { throw new Error('notice broke'); });
  const posts = await turn(makeEvent(), 'hello back', onAnswered);
  expect(onAnswered).toHaveBeenCalledTimes(1);
  expect(posts).toHaveLength(1);
  expect(turn.lastPosts.some(([route]) => route === '/api/agents/runtime/events/evt-1/ack')).toBe(true);
});

// `agent run` is a long action that changes often, and the whole CLI half of
// F642 is the one option it passes to performRun. Pin it as text.
test('the foreground agent run passes the notice to the run loop', () => {
  const source = fs.readFileSync(new URL('../src/commands/agent.js', import.meta.url), 'utf8');
  const wired = source.match(/onAnswered: foregroundAnswerNotice\(\{/g) || [];
  expect(wired).toHaveLength(1);
});

test('with the foreground notice wired in, the keep-it-running block prints after the first answer and not after the second', async () => {
  const lines = [];
  const onAnswered = createFirstAnswerNotice({
    managed: false,
    hintArgs: () => ({ daemonRegistered: false, platform: 'darwin', entry: '/usr/local/lib/node_modules/@commonlyai/cli/src/index.js' }),
    log: (line) => lines.push(line),
  });
  await turn(makeEvent(), '', onAnswered);
  expect(lines).toEqual([]);
  await turn(makeEvent({ _id: 'evt-2' }), 'first answer', onAnswered);
  const printed = lines.length;
  expect(lines.join('\n')).toMatch(/your agent just answered/i);
  await turn(makeEvent({ _id: 'evt-3' }), 'second answer', onAnswered);
  expect(lines).toHaveLength(printed);
});

// The daemon spawns its seats with COMMONLY_MANAGED_RUNNER=1; that is how
// `agent run` knows the daemon already keeps it running.
test('under the daemon the block never prints', async () => {
  const lines = [];
  const onAnswered = foregroundAnswerNotice({
    env: { COMMONLY_MANAGED_RUNNER: '1' },
    instanceUrl: 'https://api.commonly.me',
    daemonRegistered: () => true,
    log: (line) => lines.push(line),
  });
  await turn(makeEvent(), 'an answer', onAnswered);
  expect(lines).toEqual([]);
});

test('a foreground run with no daemon prints it with this instance', async () => {
  const lines = [];
  const onAnswered = foregroundAnswerNotice({
    env: {},
    instanceUrl: 'https://api.commonly.me',
    daemonRegistered: () => true,
    log: (line) => lines.push(line),
  });
  await turn(makeEvent(), 'an answer', onAnswered);
  expect(lines.join('\n')).toMatch(/your agent just answered/i);
  expect(lines.join('\n')).toContain('add the agent to this computer');
});
