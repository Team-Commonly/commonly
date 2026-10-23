const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const mockBinding = jest.fn();
const mockCreateReceipt = jest.fn();
const mockDeleteReceipt = jest.fn();
const mockHandle = jest.fn();
jest.mock('../../../services/githubGigService', () => ({
  githubLocation: jest.requireActual('../../../services/githubGigService').githubLocation,
  boundPodForGithubEvent: (...args) => mockBinding(...args),
}));
jest.mock('../../../models/GithubGigDelivery', () => ({
  create: (...args) => mockCreateReceipt(...args),
  deleteOne: (...args) => mockDeleteReceipt(...args),
}));
jest.mock('../../../services/installable/eventHandlers', () => ({
  eventHandlers: { 'github.gig': (...args) => mockHandle(...args) },
}));

const route = require('../../../routes/webhooks/github');
const app = express();
app.use('/api/webhooks/github', route.githubGigRawBody);
app.use('/api/webhooks/github', route.githubGigRawError);
app.use(express.json());
app.use('/api/webhooks/github', route);

const payload = {
  action: 'opened', installation: { id: 123 },
  repository: { owner: { login: 'Team-Commonly' }, name: 'commonly' },
  pull_request: { number: 42, title: 'External text' },
};
const deliver = (body, overrides = {}, target = app) => {
  const signature = `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;
  return request(target).post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signature)
    .set('X-GitHub-Event', 'pull_request')
    .set('X-GitHub-Delivery', '123e4567-e89b-12d3-a456-426614174000')
    .set(overrides)
    .send(body);
};

beforeEach(() => {
  process.env.GITHUB_GIG_WEBHOOK_SECRET = 'secret';
  process.env.GITHUB_GIG_ENABLED = 'true';
  mockBinding.mockReset().mockResolvedValue(null);
  mockCreateReceipt.mockReset().mockResolvedValue({});
  mockDeleteReceipt.mockReset().mockResolvedValue({});
  mockHandle.mockReset().mockResolvedValue(undefined);
});
afterAll(() => {
  delete process.env.GITHUB_GIG_WEBHOOK_SECRET;
  delete process.env.GITHUB_GIG_ENABLED;
});

test('missing and invalid signatures return 401 before parsing or lookup', async () => {
  const missing = await request(app).post('/api/webhooks/github')
    .set('Content-Type', 'application/json').send('{bad json');
  const invalid = await deliver('{bad json', { 'X-Hub-Signature-256': 'sha256=0000' });
  expect(missing.status).toBe(401);
  expect(invalid.status).toBe(401);
  expect(missing.text).toBe('');
  expect(mockBinding).not.toHaveBeenCalled();
  expect(mockCreateReceipt).not.toHaveBeenCalled();
});

test('a well-formed signature made with another secret returns 401 before lookup', async () => {
  const body = JSON.stringify(payload);
  const wrongDigest = crypto.createHmac('sha256', 'another-secret').update(body).digest('hex');
  const response = await deliver(body, { 'X-Hub-Signature-256': `sha256=${wrongDigest}` });
  expect(response.status).toBe(401);
  expect(response.text).toBe('');
  expect(mockBinding).not.toHaveBeenCalled();
  expect(mockCreateReceipt).not.toHaveBeenCalled();
});

test('a signed delivery is silent when the gig is disabled', async () => {
  process.env.GITHUB_GIG_ENABLED = 'false';
  const response = await deliver(JSON.stringify(payload));
  expect(response.status).toBe(204);
  expect(mockBinding).not.toHaveBeenCalled();
  expect(mockCreateReceipt).not.toHaveBeenCalled();
  expect(mockHandle).not.toHaveBeenCalled();
});

test('signature covers the raw bytes, including whitespace', async () => {
  const body = JSON.stringify(payload, null, 2);
  const response = await deliver(body);
  expect(response.status).toBe(204);
  expect(mockBinding).toHaveBeenCalledWith({
    installationId: '123', owner: 'Team-Commonly', repo: 'commonly', number: '42',
  });
  expect(mockCreateReceipt).not.toHaveBeenCalled();
});

test('an unbound App-wide delivery is silent and does not write a receipt', async () => {
  const response = await deliver(JSON.stringify(payload));
  expect(response.status).toBe(204);
  expect(mockBinding).toHaveBeenCalledTimes(1);
  expect(mockCreateReceipt).not.toHaveBeenCalled();
  expect(mockHandle).not.toHaveBeenCalled();
});

test('a bound delivery is claimed once and replay does not post twice', async () => {
  mockBinding.mockResolvedValue('aaaaaaaaaaaaaaaaaaaaaaaa');
  const seenHashes = new Set();
  mockCreateReceipt.mockImplementation(async ({ bodyHash }) => {
    if (seenHashes.has(bodyHash)) throw Object.assign(new Error('duplicate body'), { code: 11000 });
    seenHashes.add(bodyHash);
  });
  const first = await deliver(JSON.stringify(payload));
  await new Promise((resolve) => setImmediate(resolve));
  const replay = await deliver(JSON.stringify(payload), { 'X-GitHub-Delivery': '123e4567-e89b-12d3-a456-426614174001' });
  expect(first.status).toBe(204);
  expect(replay.status).toBe(204);
  expect(mockCreateReceipt).toHaveBeenCalledTimes(2);
  expect(mockCreateReceipt.mock.calls[0][0].bodyHash).toBe(crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
  expect(mockCreateReceipt.mock.calls[1][0].bodyHash).toBe(mockCreateReceipt.mock.calls[0][0].bodyHash);
  expect(mockHandle).toHaveBeenCalledTimes(1);
});

test('a handler failure releases the receipt and returns 503 for retry', async () => {
  mockBinding.mockResolvedValue('aaaaaaaaaaaaaaaaaaaaaaaa');
  mockHandle.mockRejectedValueOnce(new Error('outsider payload secret')).mockResolvedValueOnce(undefined);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const first = await deliver(JSON.stringify(payload));
    expect(first.status).toBe(503);
    expect(first.text).toBe('');
    expect(mockDeleteReceipt).toHaveBeenCalledWith({ deliveryId: '123e4567-e89b-12d3-a456-426614174000' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('outsider payload secret');
    const retry = await deliver(JSON.stringify(payload));
    expect(retry.status).toBe(204);
    expect(mockHandle).toHaveBeenCalledTimes(2);
  } finally { warn.mockRestore(); }
});

test('the production raw parser accepts a large signed delivery and returns an empty 413 above its ceiling', async () => {
  const large = JSON.stringify({ ...payload, padding: 'x'.repeat(200 * 1024) });
  expect((await deliver(large)).status).toBe(204);
  const tooLarge = await request(app).post('/api/webhooks/github')
    .set('Content-Type', 'application/json').send('x'.repeat(26 * 1024 * 1024));
  expect(tooLarge.status).toBe(413);
  expect(tooLarge.text).toBe('');
  expect(mockBinding).toHaveBeenCalledTimes(1);
});

test('the source bucket counts invalid signatures but still returns empty 401 on overflow', async () => {
  const limitedApp = express();
  limitedApp.use('/api/webhooks/github', route.githubGigRawBody);
  limitedApp.use('/api/webhooks/github', route.githubGigRawError);
  limitedApp.use('/api/webhooks/github', route.createGithubGigRateLimit(2));
  limitedApp.use('/api/webhooks/github', route);
  const bad = { 'X-Hub-Signature-256': 'sha256=0000' };
  const first = await deliver(JSON.stringify(payload), bad, limitedApp);
  const second = await deliver(JSON.stringify(payload), bad, limitedApp);
  const third = await deliver(JSON.stringify(payload), bad, limitedApp);
  const valid = await deliver(JSON.stringify(payload), {}, limitedApp);
  expect([first, second, third].map((res) => [res.status, res.text])).toEqual([[401, ''], [401, ''], [401, '']]);
  expect([first, second, third].map((res) => res.headers['ratelimit-limit'])).toEqual([undefined, undefined, undefined]);
  expect(valid.status).toBe(429);
  expect(mockBinding).not.toHaveBeenCalled();
});

test('the production route mounts its source limiter once', () => {
  const post = route.stack.find((layer) => layer.route?.path === '/');
  expect(post.route.stack).toHaveLength(3);
});

test('checks remain off until checks:read is granted', async () => {
  const check = { ...payload, action: 'completed', check_run: { conclusion: 'failure', pull_requests: [{ number: 42 }] } };
  const response = await deliver(JSON.stringify(check), { 'X-GitHub-Event': 'check_run' });
  expect(response.status).toBe(204);
  expect(mockBinding).not.toHaveBeenCalled();
});

test.each([
  ['pull_request_review', 'submitted', { pull_request: { number: 42 }, review: { state: 'approved', body: 'outsider' } }],
  ['issues', 'opened', { issue: { number: 42, title: 'outsider' } }],
  ['issues', 'closed', { issue: { number: 42, body: 'outsider' } }],
])('%s %s routes only when bound', async (eventType, action, fields) => {
  mockBinding.mockResolvedValue('aaaaaaaaaaaaaaaaaaaaaaaa');
  const body = JSON.stringify({
    action, installation: payload.installation, repository: payload.repository, ...fields,
  });
  const response = await deliver(body, {
    'X-GitHub-Event': eventType,
    'X-GitHub-Delivery': `123e4567-e89b-12d3-a456-42661417400${action === 'closed' ? 1 : eventType === 'issues' ? 2 : 3}`,
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(response.status).toBe(204);
  expect(mockBinding).toHaveBeenCalledTimes(1);
  expect(mockCreateReceipt).toHaveBeenCalledTimes(1);
  expect(mockHandle).toHaveBeenCalledWith(expect.objectContaining({ eventType }));
});
