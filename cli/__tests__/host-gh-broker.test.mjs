import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { execFile } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { connect } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { startSeatGhBroker } from '../src/lib/host-gh-broker.js';

const execFileAsync = promisify(execFile);
const TOKEN = `cm_agent_${'T'.repeat(64)}`;
let testRoot;
let broker;
let fetchImpl;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'commonly-host-gh-test-'));
  fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({
    callId: 'call-1', outcome: 'ok', result: { number: 7 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  broker = await startSeatGhBroker({
    runtimeToken: TOKEN, instanceUrl: 'https://api.example.invalid', root: testRoot, fetchImpl,
  });
});

afterEach(async () => {
  await broker?.close();
  await rm(testRoot, { recursive: true, force: true });
});

const run = (...argv) => execFileAsync(broker.shimPath, argv, {
  env: { ...process.env, COMMONLY_GH_SOCKET: broker.socketPath, COMMONLY_AGENT_TOKEN: '' },
  timeout: 10000,
});

it('forwards a fixed operation and the daemon-owned bearer, never a URL or token from the shim', async () => {
  const { stdout } = await run('pr', 'view', '7', '--grant-id', 'grant-1');
  expect(JSON.parse(stdout).result.number).toBe(7);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, options] = fetchImpl.mock.calls[0];
  expect(String(url)).toBe('https://api.example.invalid/api/mcp/grants/grant-1/cli');
  expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(JSON.parse(options.body)).toEqual({ operation: 'pr.view', args: { pullNumber: 7 } });
});

it.each([
  [['pr', 'create', '--title', 'Change', '--head', 'seat/agent-a/change', '--base', 'main', '--draft'],
    'pr.create', { title: 'Change', head: 'seat/agent-a/change', base: 'main', draft: true }],
  [['pr', 'comment', '7', '--body', 'A note'], 'pr.comment', { pullNumber: 7, body: 'A note' }],
  [['pr', 'review', '7', '--comment', '--body', 'Review note'],
    'pr.review_comment', { pullNumber: 7, body: 'Review note' }],
  [['issue', 'comment', '8', '--body', 'Issue note'], 'issue.comment', { issueNumber: 8, body: 'Issue note' }],
])('accepts only the listed %j grammar', async (argv, operation, args) => {
  await run(...argv, '--grant-id', 'grant-1');
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ operation, args });
});

it.each([
  ['pr', 'merge', '7'],
  ['pr', 'review', '7', '--approve'],
  ['api', 'repos/Team-Commonly/commonly'],
  ['pr', 'create', '--title', 'X', '--head', 'seat/a/x', '--base', 'main', '--repo', 'other/repo'],
])('refuses unlisted argv before contacting the backend', async (...argv) => {
  await expect(run(...argv, '--grant-id', 'grant-1')).rejects.toMatchObject({ code: 2 });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('rejects a removed seat endpoint after teardown', async () => {
  const socketPath = broker.socketPath;
  await broker.close();
  broker = null;
  await expect(new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.on('connect', resolve);
    socket.on('error', reject);
  })).rejects.toMatchObject({ code: 'ENOENT' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('reports a parked write as pending approval without claiming it executed', async () => {
  fetchImpl.mockResolvedValue(new Response(JSON.stringify({
    status: 'pending_approval', approvalId: 'approval-1',
  }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
  const { stdout } = await run('pr', 'create', '--title', 'Change', '--head', 'seat/agent-a/change',
    '--base', 'main', '--grant-id', 'grant-1');
  expect(JSON.parse(stdout)).toEqual({ status: 'pending_approval', approvalId: 'approval-1' });
});
