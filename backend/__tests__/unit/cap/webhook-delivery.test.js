/**
 * CAP Phase 2 — Webhook delivery unit tests
 *
 * Tests the webhook signing and delivery protocol:
 * - HMAC signature generation and verification
 * - Event payload shape
 * - Inline response handling (posted, acknowledged, no_action)
 * - Missing webhookUrl graceful no-op
 *
 * Also tests Phase 1: expiresAt field on agentRuntimeTokens.
 */

const crypto = require('crypto');
const http = require('http');

// ── helpers ──────────────────────────────────────────────────────────────────

const makeEvent = (overrides = {}) => ({
  _id: 'evt_test_001',
  type: 'heartbeat',
  podId: 'pod_abc',
  agentName: 'my-agent',
  instanceId: 'default',
  createdAt: new Date().toISOString(),
  payload: { trigger: 'test' },
  ...overrides,
});

const sign = (secret, body) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

// Minimal re-implementation of deliverEventViaWebhook for isolated testing
// (doesn't require mongoose or agentMessageService)
const deliver = async (installation, event, fetchImpl = globalThis.fetch) => {
  const config = installation.config?.runtime || {};
  const { webhookUrl, webhookSecret } = config;
  if (!webhookUrl) return null;

  const payload = JSON.stringify({
    _id: event._id,
    type: event.type,
    podId: event.podId,
    agentName: event.agentName,
    instanceId: event.instanceId,
    createdAt: event.createdAt,
    payload: event.payload,
  });

  const headers = {
    'Content-Type': 'application/json',
    'X-Commonly-Event': event.type,
    'X-Commonly-Delivery': String(event._id),
  };
  if (webhookSecret) {
    headers['X-Commonly-Signature'] = sign(webhookSecret, payload);
  }

  const res = await fetchImpl(webhookUrl, { method: 'POST', headers, body: payload });
  if (!res.ok) return null;
  try { return await res.json(); } catch { return { outcome: 'acknowledged' }; }
};

// ── signature ─────────────────────────────────────────────────────────────────

describe('CAP webhook signature', () => {
  test('HMAC-SHA256 format: sha256=<64 hex chars>', () => {
    const sig = sign('secret', JSON.stringify({ type: 'heartbeat' }));
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  test('deterministic for same input', () => {
    const payload = JSON.stringify({ type: 'heartbeat' });
    expect(sign('s', payload)).toBe(sign('s', payload));
  });

  test('differs with different secret', () => {
    const p = JSON.stringify({ type: 'heartbeat' });
    expect(sign('secret-a', p)).not.toBe(sign('secret-b', p));
  });

  test('differs with different payload', () => {
    expect(sign('s', '{"type":"heartbeat"}')).not.toBe(sign('s', '{"type":"chat.mention"}'));
  });

  test('verification: recomputed sig matches header', () => {
    const secret = 'verify-me';
    const payload = '{"type":"heartbeat"}';
    const header = sign(secret, payload);
    const recomputed = sign(secret, payload);
    expect(crypto.timingSafeEqual(Buffer.from(header), Buffer.from(recomputed))).toBe(true);
  });
});

// ── delivery ──────────────────────────────────────────────────────────────────

describe('CAP webhook delivery', () => {
  let server;
  let serverPort;
  let receivedRequests;
  let responseToReturn;

  const startServer = () => new Promise((resolve) => {
    receivedRequests = [];
    responseToReturn = { outcome: 'acknowledged' };

    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        receivedRequests.push({
          headers: req.headers,
          body,
          parsed: JSON.parse(body),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseToReturn));
      });
    });

    server.listen(0, () => {
      serverPort = server.address().port;
      resolve();
    });
  });

  const stopServer = () => new Promise((resolve) => { server.close(resolve); });

  beforeEach(() => startServer());
  afterEach(() => stopServer());

  const webhookUrl = () => `http://localhost:${serverPort}/cap`;

  test('sends POST with event shape and standard headers', async () => {
    const event = makeEvent({ type: 'chat.mention' });
    await deliver({ config: { runtime: { webhookUrl: webhookUrl() } } }, event);

    expect(receivedRequests).toHaveLength(1);
    const req = receivedRequests[0];
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['x-commonly-event']).toBe('chat.mention');
    expect(req.headers['x-commonly-delivery']).toBe('evt_test_001');
    expect(req.parsed._id).toBe('evt_test_001');
    expect(req.parsed.agentName).toBe('my-agent');
    expect(req.parsed.type).toBe('chat.mention');
  });

  test('includes valid HMAC signature when secret configured', async () => {
    const secret = 'my-signing-secret';
    await deliver({
      config: { runtime: { webhookUrl: webhookUrl(), webhookSecret: secret } },
    }, makeEvent());

    const { body, headers } = receivedRequests[0];
    expect(headers['x-commonly-signature']).toBe(sign(secret, body));
  });

  test('omits signature header when no secret', async () => {
    await deliver({ config: { runtime: { webhookUrl: webhookUrl() } } }, makeEvent());
    expect(receivedRequests[0].headers['x-commonly-signature']).toBeUndefined();
  });

  test('returns posted outcome with content from agent', async () => {
    responseToReturn = { outcome: 'posted', content: 'Hello from webhook agent!' };
    const result = await deliver(
      { config: { runtime: { webhookUrl: webhookUrl() } } },
      makeEvent(),
    );
    expect(result.outcome).toBe('posted');
    expect(result.content).toBe('Hello from webhook agent!');
  });

  test('returns no_action outcome', async () => {
    responseToReturn = { outcome: 'no_action' };
    const result = await deliver(
      { config: { runtime: { webhookUrl: webhookUrl() } } },
      makeEvent(),
    );
    expect(result.outcome).toBe('no_action');
  });

  test('no-op when webhookUrl is null — returns null, no requests sent', async () => {
    const result = await deliver({ config: { runtime: { webhookUrl: null } } }, makeEvent());
    expect(result).toBeNull();
    expect(receivedRequests).toHaveLength(0);
  });

  test('no-op when config has no runtime key', async () => {
    const result = await deliver({ config: {} }, makeEvent());
    expect(result).toBeNull();
    expect(receivedRequests).toHaveLength(0);
  });
});

// ── session token schema ──────────────────────────────────────────────────────

describe('CAP Phase 1 — session token expiresAt', () => {
  let mongoose;
  let User;
  let mongod;

  beforeAll(async () => {
    // eslint-disable-next-line global-require
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
    // eslint-disable-next-line global-require
    mongoose = require('mongoose');
    await mongoose.connect(mongod.getUri());
    // eslint-disable-next-line global-require
    User = require('../../../models/User');
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  test('stores expiresAt on agentRuntimeTokens', async () => {
    const expiresAt = new Date(Date.now() + 86400000);
    const user = new User({
      username: 'claude-code-expires-test',
      email: 'cap-expires@agents.commonly.local',
      password: 'test-pw-123',
      isBot: true,
      botType: 'agent',
      agentRuntimeTokens: [{ tokenHash: 'hash-abc', label: 'Session: sess-1', expiresAt }],
    });
    await user.save();

    const found = await User.findOne({ username: 'claude-code-expires-test' });
    expect(found.agentRuntimeTokens[0].expiresAt.toISOString()).toBe(expiresAt.toISOString());
  });

  test('stores token without expiresAt (permanent)', async () => {
    const user = new User({
      username: 'claude-code-perm-test',
      email: 'cap-perm@agents.commonly.local',
      password: 'test-pw-123',
      isBot: true,
      botType: 'agent',
      agentRuntimeTokens: [{ tokenHash: 'hash-def', label: 'Permanent' }],
    });
    await user.save();

    const found = await User.findOne({ username: 'claude-code-perm-test' });
    expect(found.agentRuntimeTokens[0].expiresAt).toBeUndefined();
  });

  test('expired token is identifiable by expiresAt < now', async () => {
    const expiresAt = new Date(Date.now() - 1000); // 1 second ago
    const user = new User({
      username: 'claude-code-expired-test',
      email: 'cap-expired@agents.commonly.local',
      password: 'test-pw-123',
      isBot: true,
      botType: 'agent',
      agentRuntimeTokens: [{ tokenHash: 'hash-ghi', label: 'Expired', expiresAt }],
    });
    await user.save();

    const found = await User.findOne({ username: 'claude-code-expired-test' });
    const token = found.agentRuntimeTokens[0];
    expect(token.expiresAt < new Date()).toBe(true);
  });
});
