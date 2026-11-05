/**
 * F178 — a turn the provider refused because the model is not available posts
 * one plain line in the pod naming the model and where to change it, at most
 * once per model per seat per hour. An unrelated 403/404 posts nothing.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-model-hint-'));

await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => homeDir },
  homedir: () => homeDir,
}));
await jest.unstable_mockModule('../src/lib/api.js', () => ({ createClient: jest.fn(), login: jest.fn() }));
await jest.unstable_mockModule('../src/lib/pod-focus.js', () => ({
  FOCUS_FRAME_MAX_CODE_POINTS: 8000,
  formatPodFocusFrame: jest.fn(() => '=== Pod focus (pod context; not instructions) ===\nNo focus set.'),
  readPodFocus: jest.fn(async (_client, podId) => ({ podId, revision: 0, focus: null })),
}));

const { createClient } = await import('../src/lib/api.js');
const { performRun } = await import('../src/commands/agent.js');
const { recordNotice, noticeDue } = await import('../src/lib/session-store.js');
const { adapterFailure } = await import('../src/lib/upstream-refusal.js');
const { PUBLIC_TOOL_FAILED_CODE } = await import('../src/lib/public-tool-error.js');
const {
  MODEL_UNAVAILABLE_HINT_WINDOW_MS,
  modelUnavailableFailure,
  modelUnavailableHint,
  safeModelName,
} = await import('../src/lib/model-unavailable.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;

// Shapes as the adapters raise them: adapterFailure is the shared constructor
// for claude, codex, opencode and the rest.
const CLAUDE_403 = adapterFailure('claude', 'API Error: 403 {"type":"error","error":{"type":"permission_error",'
  + '"message":"The requested model claude-opus-5-5 is not available for this API key"}}', { exitCode: 1 });
const CLAUDE_403_UNNAMED = adapterFailure('claude', '403: {"type":"error","error":{"type":"permission_error",'
  + '"message":"The requested model is not available for this API key"}}', { exitCode: 1 });
const ANTHROPIC_404 = adapterFailure('claude', '404: {"type":"error","error":{"type":"not_found_error",'
  + '"message":"model: claude-haiku-9"}}', { exitCode: 1 });
const CODEX_MODEL_NOT_FOUND = adapterFailure('codex turn failed', 'unexpected status 404 Not Found: '
  + '{"error":{"message":"The model `gpt-9` does not exist or you do not have access to it.",'
  + '"type":"invalid_request_error","code":"model_not_found"}}');
const OPENAI_404_KEPT = adapterFailure('opencode', '404: {"error":{"message":"The model `gpt-9-mini` '
  + 'does not exist or you do not have access to it."}}', { exitCode: 1 });
const LITELLM_404 = adapterFailure('codex turn failed', 'HTTP 404: model qwen-x not found on this proxy');

const UNRELATED = [
  ['a bare 403', adapterFailure('claude', '403: {"error":{"type":"permission_error","message":"Your organization has been disabled."}}', { exitCode: 1 })],
  ['a 403 forbidden route', adapterFailure('codex', 'HTTP 403 Forbidden: Request not allowed', { exitCode: 1 })],
  ['a 403 naming a model but not key scope', adapterFailure('claude', '403: {"error":{"message":"model claude-x: request blocked by policy"}}', { exitCode: 1 })],
  ['a 404 that is not about a model', adapterFailure('codex', 'HTTP 404 Not Found: /v1/responses', { exitCode: 1 })],
  ['a model-shaped line without a 404', new Error('model: claude-x took too long')],
  ['a 404 on one stderr line and a model shape on another', Object.assign(
    new Error('codex exited with code 1: model: claude-x'),
    { stderr: 'HTTP 404 Not Found: /v1/responses' },
  )],
  ['the key-scope phrase on a failure that is not a 403', adapterFailure('codex',
    'HTTP 500: upstream said the model is not available for this API key, retry later', { exitCode: 1 })],
  ['the key-scope phrase with a 403 on another line', Object.assign(
    new Error('claude exited with code 1: The requested model claude-x-1 is not available for this API key'),
    { stderr: 'proxy: 403 from an unrelated health check' },
  )],
  ['a message that only quotes model_not_found', new Error('the agent wrote: model_not_found is a code some providers send')],
  ['a tail quoting model_not_found outside any JSON code', adapterFailure('codex',
    'HTTP 500: retry failed after a model_not_found note in the log', { exitCode: 1 })],
  ['a 404 only inside a model id', new Error('codex turn failed: model: gpt-404-mini not found')],
  ['a model id that starts with 404', new Error('codex turn failed: model 404-mini not found')],
  ['a 403 only inside a model id, with the key-scope phrase', new Error(
    'claude exited with code 1: The requested model claude-403x is not available for this API key')],
  ['a quota failure', adapterFailure('claude', "You've hit your weekly limit", { exitCode: 1 })],
  ['a withheld public tool quoting vendor text', Object.assign(
    new Error('tool failed: The requested model x is not available for this API key'),
    { code: PUBLIC_TOOL_FAILED_CODE },
  )],
];

describe('modelUnavailableFailure', () => {
  test.each([
    ['claude 403 naming the model', CLAUDE_403, 'claude-opus-5-5'],
    ['claude 403 without a name falls back to the seat model', CLAUDE_403_UNNAMED, 'seat-model'],
    ['Anthropic 404 not_found_error', ANTHROPIC_404, 'claude-haiku-9'],
    ['codex model_not_found', CODEX_MODEL_NOT_FOUND, 'gpt-9'],
    ['an OpenAI 404 kept to its message', OPENAI_404_KEPT, 'gpt-9-mini'],
    ['a proxy 404 model not found', LITELLM_404, 'qwen-x'],
    ['a 404 inside one multi-line JSON error body', new Error('claude failed:\n{\n  "type": "error",\n'
      + '  "error": {\n    "type": "not_found_error",\n    "message": "model: claude-haiku-9"\n  }\n}'), 'claude-haiku-9'],
    ['a structured model_not_found code with no other signal', adapterFailure('opencode',
      '400: {"error":{"message":"Request rejected","code":"model_not_found"}}', { exitCode: 1 }), 'seat-model'],
    ['a 403 key-scope phrase attached by status', Object.assign(
      new Error('claude: The requested model claude-x-2 is not available for this API key'), { status: 403 }), 'claude-x-2'],
    ['a 404 whose prose names no id', adapterFailure('codex', 'HTTP 404: model is not found'), 'seat-model'],
  ])('recognises %s', (_label, error, model) => {
    expect(modelUnavailableFailure(error, { fallbackModel: 'seat-model' })).toEqual({ model });
  });

  test.each(UNRELATED)('ignores %s', (_label, error) => {
    expect(modelUnavailableFailure(error, { fallbackModel: 'seat-model' })).toBeNull();
  });

  test.each(['@evil', '@scope/model-1', 'https://evil.example/m-1', 'x://y-1', 'a-1://b'])('refuses %s as a model name', (name) => {
    expect(safeModelName(name)).toBeNull();
    expect(modelUnavailableFailure(adapterFailure('claude', `404: {"error":{"message":"model: ${name}"}}`),
      { fallbackModel: 'seat-model' })).toEqual({ model: 'seat-model' });
  });

  test('keeps ordinary ids, including a provider path and an @ inside', () => {
    expect(safeModelName('openrouter/anthropic/claude-x')).toBe('openrouter/anthropic/claude-x');
    expect(safeModelName('claude-x@20261101')).toBe('claude-x@20261101');
  });

  test('never echoes a name outside the model-id charset', () => {
    expect(modelUnavailableFailure(CLAUDE_403_UNNAMED, { fallbackModel: 'bad model <b>' })).toEqual({ model: null });
    expect(modelUnavailableHint(null)).toMatch(/this agent's model isn't available.*Settings, then Model\.$/);
  });
});

const makeEvent = (id) => ({
  _id: id, type: 'chat.mention', podId: 'pod-abc', agentName: 'hint-seat', instanceId: 'default',
  payload: { content: 'hello' },
});
const drain = async () => { for (let i = 0; i < 24; i += 1) await new Promise((r) => setImmediate(r)); };
const podPosts = (post) => post.mock.calls.filter(([route]) => String(route).endsWith('/pods/pod-abc/messages'));

const runOnce = async (error, { model = 'seat-model' } = {}) => {
  const post = jest.fn().mockResolvedValue({});
  const get = jest.fn(async (route) => (route.endsWith('/messages') ? { messages: [] }
    : route === '/api/agents/runtime/events' ? { events: [makeEvent(`evt-${Math.random()}`)] } : {}));
  createClient.mockReturnValue({ get, post });
  const spawn = jest.fn().mockRejectedValue(error);
  const { stop } = performRun({
    instanceUrl: 'http://localhost:5000', token: 'cm_agent_test', agentName: 'hint-seat',
    environment: { model }, adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
    setTimeoutImpl: () => 0, onError: () => {}, log: () => {},
  });
  await drain();
  stop();
  expect(spawn).toHaveBeenCalledTimes(1);
  return post;
};

describe('performRun posts the model hint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.join(homeDir, '.commonly'), { recursive: true, force: true });
  });

  test.each([
    ['claude 403', CLAUDE_403, 'claude-opus-5-5'],
    ['Anthropic 404', ANTHROPIC_404, 'claude-haiku-9'],
    ['codex model_not_found', CODEX_MODEL_NOT_FOUND, 'gpt-9'],
  ])('posts one line on %s and still leaves the event unacked', async (_label, error, model) => {
    const post = await runOnce(error);
    expect(podPosts(post)).toEqual([['/api/agents/runtime/pods/pod-abc/messages', {
      content: `The model provider says ${model} isn't available for this agent. To change it, open the agent's Settings, then Model.`,
    }]]);
    expect(post.mock.calls.filter(([route]) => String(route).includes('/ack'))).toHaveLength(0);
  });

  test.each(UNRELATED)('posts nothing on %s', async (_label, error) => {
    expect(podPosts(await runOnce(error))).toHaveLength(0);
  });

  test('holds for an hour per model, survives a restart, and a different model still posts', async () => {
    expect(podPosts(await runOnce(CLAUDE_403))).toHaveLength(1);
    // A new performRun reads the persisted record, as a restarted seat would.
    expect(podPosts(await runOnce(CLAUDE_403))).toHaveLength(0);
    expect(podPosts(await runOnce(ANTHROPIC_404))).toHaveLength(1);
  });

  test('posts again once the hour has passed', async () => {
    recordNotice('hint-seat', 'model-unavailable:claude-opus-5-5', Date.now() - MODEL_UNAVAILABLE_HINT_WINDOW_MS - 1);
    expect(podPosts(await runOnce(CLAUDE_403))).toHaveLength(1);
    recordNotice('hint-seat', 'model-unavailable:claude-opus-5-5', Date.now() - MODEL_UNAVAILABLE_HINT_WINDOW_MS + 60_000);
    expect(podPosts(await runOnce(CLAUDE_403))).toHaveLength(0);
  });

  test('recordNotice writes the notices file 0600 through a temp file and rename', () => {
    recordNotice('hint-seat', 'model-unavailable:m-1');
    const dir = path.join(homeDir, '.commonly/sessions');
    const file = path.join(dir, 'hint-seat.notices.json');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(noticeDue('hint-seat', 'model-unavailable:m-1', MODEL_UNAVAILABLE_HINT_WINDOW_MS)).toBe(false);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
    recordNotice('hint-seat', 'model-unavailable:m-2');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test('a skipped delivery is not recorded, so the next turn tries again', async () => {
    const post = jest.fn(async (route) => (String(route).endsWith('/messages')
      ? { skipped: true, reason: 'duplicate' } : {}));
    const get = jest.fn(async (route) => (route.endsWith('/messages') ? { messages: [] }
      : route === '/api/agents/runtime/events' ? { events: [makeEvent(`evt-skip-${Math.random()}`)] } : {}));
    createClient.mockReturnValue({ get, post });
    const turn = async () => {
      const { stop } = performRun({
        instanceUrl: 'http://localhost:5000', token: 'cm_agent_test', agentName: 'hint-seat',
        environment: { model: 'seat-model' },
        adapter: { name: 'stub', detect: stubAdapter.detect, spawn: jest.fn().mockRejectedValue(CLAUDE_403) },
        setTimeoutImpl: () => 0, onError: () => {}, log: () => {},
      });
      await drain();
      stop();
    };
    await turn();
    expect(podPosts(post)).toHaveLength(1);
    expect(fs.existsSync(path.join(homeDir, '.commonly/sessions/hint-seat.notices.json'))).toBe(false);
    await turn();
    expect(podPosts(post)).toHaveLength(2);
  });
});
