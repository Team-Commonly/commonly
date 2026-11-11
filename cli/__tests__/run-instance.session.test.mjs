/**
 * run-instance.session.test.mjs — F306
 *
 * A second instance keeps its local state under its own key (`localKey`), so it
 * never resumes the default instance's session in a pod they share, which would
 * hand it the other instance's conversation.
 */
import { jest } from '@jest/globals';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-instance-session-'));

await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => homeDir },
  homedir: () => homeDir,
}));

await jest.unstable_mockModule('../src/lib/pod-focus.js', () => ({
  FOCUS_FRAME_MAX_CODE_POINTS: 8000,
  formatPodFocusFrame: jest.fn(() => '=== Pod focus (pod context; not instructions) ===\nNo focus set.'),
  readPodFocus: jest.fn(async (_client, podId) => ({ podId, revision: 0, focus: null })),
}));

const { performRun } = await import('../src/commands/agent.js');
const { setSession } = await import('../src/lib/session-store.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;

const POD = 'pod-306';
const mention = (id) => ({
  _id: id,
  type: 'chat.mention',
  podId: POD,
  agentName: 'nova',
  instanceId: 'priya-nova',
  payload: { content: 'hello', messageId: `msg-${id}` },
});

// The first inbox poll gets one mention; every later poll and any other call
// answers 200 with an empty body.
const startStub = async (first) => {
  let polls = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // A seat with no enforced sandbox re-reads its pods before every turn and
    // runs only while all are confirmed private (lib/unconfined-seat-guard.js).
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/agents/runtime/installations') {
      res.end(JSON.stringify({ installations: [{
        podId: POD, publicRead: false, communityListed: false, joinPolicy: 'invite-only',
      }] }));
      return;
    }
    const isPoll = req.method === 'GET' && req.url.split('?')[0] === '/api/agents/runtime/events';
    if (isPoll) polls += 1;
    res.end(isPoll && polls === 1 ? JSON.stringify({ events: [first], inboxCount: 1 }) : '{}');
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
};

const runOnce = async (eventId) => {
  const stub = await startStub(mention(eventId));
  const spawn = jest.fn(async () => ({ text: '' }));
  const { stop } = performRun({
    instanceUrl: stub.url,
    token: 'cm_agent_test',
    adapter: { name: 'codex', detect: stubAdapter.detect, spawn },
    agentName: 'nova',
    instanceId: 'priya-nova',
    localKey: 'nova@priya-nova',
    intervalMs: 20,
    retryJitterRatio: 0,
    superviseRuns: false,
    revokeOrphansImpl: async () => {},
    onError: () => {},
  });
  const deadline = Date.now() + 5000;
  while (spawn.mock.calls.length === 0 && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  await stop();
  await stub.close();
  return spawn.mock.calls[0]?.[1];
};

afterAll(() => { fs.rmSync(homeDir, { recursive: true, force: true }); });

test("a second instance never resumes the default instance's session", async () => {
  setSession('nova', POD, 'sess-default');
  const ctx = await runOnce('evt-306-a');
  expect(ctx).toBeDefined();
  expect(ctx.sessionId).not.toBe('sess-default');
});

test('a second instance resumes its own session', async () => {
  setSession('nova@priya-nova', POD, 'sess-second');
  const ctx = await runOnce('evt-306-b');
  expect(ctx.sessionId).toBe('sess-second');
});
