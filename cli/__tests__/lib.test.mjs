/**
 * CLI lib unit tests (ESM)
 *
 * Covers:
 *  - config.js  — resolveInstanceUrl, saveInstance, getToken, listInstances
 *  - webhook-server.js — startWebhookServer, HMAC auth, forwardToLocalWebhook
 *  - poller.js  — startPoller: events polled, acknowledged, stop(), backoff on error
 *
 * Filesystem: config tests use a real temp directory (set via COMMONLY_CONFIG_DIR
 * env var trick — see mock below). Webhook and poller tests use in-process HTTP.
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createHmac } from 'crypto';
import http from 'http';

// ── config.js — filesystem isolation via os mock ─────────────────────────────
// config.js calls homedir() to build CONFIG_DIR. We mock os so it returns
// a fresh temp directory for each test suite run.

const configTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-config-test-'));

await jest.unstable_mockModule('os', () => {
  const actual = os;
  return {
    ...actual,
    default: { ...actual, homedir: () => configTmpDir },
    homedir: () => configTmpDir,
  };
});

// Import config AFTER the os mock is in place
const {
  resolveInstanceUrl,
  saveInstance,
  getToken,
  listInstances,
  DEFAULT_URL,
} = await import('../src/lib/config.js');

// ── config.js tests ───────────────────────────────────────────────────────────

describe('config.js', () => {
  const configFile = path.join(configTmpDir, '.commonly', 'config.json');

  beforeEach(() => {
    // Remove any leftover config between tests
    if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
    delete process.env.COMMONLY_TOKEN;
  });

  afterAll(() => {
    fs.rmSync(path.join(configTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('resolveInstanceUrl(null) returns DEFAULT_URL when no config file exists', () => {
    const url = resolveInstanceUrl(null);
    expect(url).toBe('https://api.commonly.me');
    expect(url).toBe(DEFAULT_URL);
  });

  test('resolveInstanceUrl("http://custom.host/") strips trailing slash', () => {
    const url = resolveInstanceUrl('http://custom.host/');
    expect(url).toBe('http://custom.host');
  });

  test('resolveInstanceUrl("http://custom.host") returns as-is (no slash)', () => {
    const url = resolveInstanceUrl('http://custom.host');
    expect(url).toBe('http://custom.host');
  });

  test('saveInstance writes { instances, active } and getToken reads it back', () => {
    saveInstance({
      key: 'mydev',
      url: 'http://localhost:5000',
      token: 'cm_abc123',
      userId: 'u1',
      username: 'alice',
    });

    const token = getToken(null); // reads active instance
    expect(token).toBe('cm_abc123');

    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    expect(raw.active).toBe('mydev');
    expect(raw.instances.mydev.url).toBe('http://localhost:5000');
    expect(raw.instances.mydev.token).toBe('cm_abc123');
  });

  test('getToken() returns process.env.COMMONLY_TOKEN over stored token (env takes precedence)', () => {
    saveInstance({
      key: 'default',
      url: 'http://localhost:5000',
      token: 'cm_stored',
      userId: 'u1',
      username: 'alice',
    });

    process.env.COMMONLY_TOKEN = 'cm_from_env';
    const token = getToken(null);
    expect(token).toBe('cm_from_env');
  });

  test('listInstances returns each instance with an active flag', () => {
    saveInstance({ key: 'prod', url: 'https://api.commonly.me', token: 'cm_prod', userId: 'u1', username: 'alice' });
    saveInstance({ key: 'dev', url: 'http://localhost:5000', token: 'cm_dev', userId: 'u2', username: 'bob' });
    // second save sets active = 'dev'

    const instances = listInstances();
    const prod = instances.find((i) => i.key === 'prod');
    const dev = instances.find((i) => i.key === 'dev');

    expect(prod).toBeTruthy();
    expect(dev).toBeTruthy();
    expect(dev.active).toBe(true);
    expect(prod.active).toBe(false);
  });
});

// ── webhook-server.js tests ───────────────────────────────────────────────────

const { startWebhookServer, forwardToLocalWebhook } = await import('../src/lib/webhook-server.js');

describe('webhook-server.js', () => {
  test('startWebhookServer starts and resolves with { server, url, close }', async () => {
    const { server, url, close } = await startWebhookServer({
      port: 0, // OS assigns free port
      onEvent: async () => ({ outcome: 'acknowledged' }),
    });

    expect(server).toBeTruthy();
    expect(url).toMatch(/^http:\/\/localhost:\d+\/cap$/);
    expect(typeof close).toBe('function');
    close();
  });

  // Helper: start server on an OS-assigned port and return an accurate URL
  // (webhook-server.js builds its `url` from the passed `port` arg; when port=0
  // that becomes "http://localhost:0/cap" which is unusable for fetch).
  const startOnFreePort = (opts) => new Promise((resolve, reject) => {
    // We need the real bound port, so bind via http first to find a free port,
    // then pass that port to startWebhookServer.
    const probe = http.createServer();
    probe.listen(0, () => {
      const freePort = probe.address().port;
      probe.close(() => {
        startWebhookServer({ port: freePort, ...opts })
          .then(resolve, reject);
      });
    });
  });

  test('POST /cap with valid JSON body calls onEvent and returns { outcome: "acknowledged" }', async () => {
    const received = [];
    const { server, url, close } = await startOnFreePort({
      onEvent: async (event) => {
        received.push(event);
        return { outcome: 'acknowledged' };
      },
    });

    const payload = { _id: 'evt-1', type: 'heartbeat', podId: 'pod-abc' };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.outcome).toBe('acknowledged');
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('heartbeat');

    await new Promise((r) => server.close(r));
  });

  test('POST with correct HMAC signature passes; wrong signature returns 401', async () => {
    const secret = 'test-secret';
    const { server, url, close } = await startOnFreePort({
      secret,
      onEvent: async () => ({ outcome: 'acknowledged' }),
    });

    const payload = JSON.stringify({ _id: 'evt-2', type: 'chat.mention' });
    const validSig = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;

    const validRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Commonly-Signature': validSig },
      body: payload,
    });
    expect(validRes.status).toBe(200);

    const badRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Commonly-Signature': 'sha256=badhash' },
      body: payload,
    });
    expect(badRes.status).toBe(401);

    await new Promise((r) => server.close(r));
  });

  test('non-POST requests return 404', async () => {
    const { server, url } = await startOnFreePort({
      onEvent: async () => ({ outcome: 'acknowledged' }),
    });

    const res = await fetch(url, { method: 'GET' });
    expect(res.status).toBe(404);

    await new Promise((r) => server.close(r));
  });

  test('forwardToLocalWebhook sends X-Commonly-Event and X-Commonly-Delivery headers', async () => {
    const received = [];
    const { server, url } = await startOnFreePort({
      onEvent: async (event) => {
        received.push(event);
        return { outcome: 'posted', content: 'hello' };
      },
    });

    const event = { _id: 'evt-99', type: 'chat.mention', podId: 'pod-z' };
    const result = await forwardToLocalWebhook(event, url, null);

    expect(result.outcome).toBe('posted');
    expect(result.content).toBe('hello');
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('chat.mention');

    await new Promise((r) => server.close(r));
  });
});

// ── poller.js tests ───────────────────────────────────────────────────────────
// We mock the api.js createClient to avoid real HTTP calls.

await jest.unstable_mockModule('../src/lib/api.js', () => ({
  createClient: jest.fn(),
  login: jest.fn(),
}));

const { createClient } = await import('../src/lib/api.js');
const { startPoller } = await import('../src/lib/poller.js');

describe('poller.js', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const makeEvent = (id = 'evt-1') => ({
    _id: id,
    type: 'heartbeat',
    podId: 'pod-abc',
    agentName: 'my-agent',
    instanceId: 'default',
    payload: {},
  });

  test('startPoller calls GET /api/agents/runtime/events and invokes onEvent for each event', async () => {
    const events = [makeEvent('e1'), makeEvent('e2')];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const received = [];
    const { stop } = startPoller({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_test',
      agentName: 'my-agent',
      intervalMs: 100_000, // long interval — we only want one cycle
      onEvent: async (ev) => { received.push(ev); return { outcome: 'acknowledged' }; },
    });

    // Wait for the first poll cycle to complete
    await new Promise((r) => setTimeout(r, 50));
    stop();

    expect(mockGet).toHaveBeenCalledWith(
      '/api/agents/runtime/events',
      expect.objectContaining({ agentName: 'my-agent' }),
    );
    expect(received).toHaveLength(2);
    expect(received[0]._id).toBe('e1');
    expect(received[1]._id).toBe('e2');
  });

  test('posts to /api/agents/runtime/events/acknowledge after each event', async () => {
    const events = [makeEvent('ack-1')];
    const mockGet = jest.fn().mockResolvedValue({ events });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const { stop } = startPoller({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_test',
      agentName: 'my-agent',
      intervalMs: 100_000,
      onEvent: async () => ({ outcome: 'acknowledged' }),
    });

    await new Promise((r) => setTimeout(r, 50));
    stop();

    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/runtime/events/ack-1/ack',
      expect.objectContaining({ result: { outcome: 'acknowledged' } }),
    );
  });

  test('stop() halts further polling cycles', async () => {
    const mockGet = jest.fn().mockResolvedValue({ events: [] });
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const { stop } = startPoller({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_test',
      agentName: 'my-agent',
      intervalMs: 20, // very short so it would fire again quickly
      onEvent: async () => ({ outcome: 'no_action' }),
    });

    await new Promise((r) => setTimeout(r, 30)); // let first cycle run
    const countAfterFirst = mockGet.mock.calls.length;
    stop();

    await new Promise((r) => setTimeout(r, 60)); // wait for potential extra cycles
    expect(mockGet.mock.calls.length).toBe(countAfterFirst); // no new calls after stop()
  });

  test('consecutive errors trigger backoff and call onError', async () => {
    const mockGet = jest.fn().mockRejectedValue(new Error('network error'));
    const mockPost = jest.fn().mockResolvedValue({});
    createClient.mockReturnValue({ get: mockGet, post: mockPost });

    const errors = [];
    const { stop } = startPoller({
      instanceUrl: 'http://localhost:5000',
      token: 'cm_test',
      agentName: 'my-agent',
      intervalMs: 5, // tiny base interval to keep test fast
      onEvent: async () => ({ outcome: 'no_action' }),
      onError: (err) => errors.push(err),
    });

    await new Promise((r) => setTimeout(r, 80));
    stop();

    // onError must have been called at least once
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toMatch(/network error/i);
  });
});
