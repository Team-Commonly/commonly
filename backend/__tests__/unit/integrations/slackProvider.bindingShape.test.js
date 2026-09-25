/**
 * TASK-140 item 2 — the Slack provider read fields that no longer have a writer.
 *
 * `config.botToken` cannot be set by a request body any more (TASK-139: it is in
 * `SERVER_OWNED_CONFIG_KEYS` and Discord's route refuses it outright), and the
 * OAuth bind stores the opaque `config.botTokenRef` instead
 * (`routes/installables.ts`). `syncRecent` and `health` still asked for
 * `config.botToken` and `config.channelId`, so every row the bind creates read as
 * unconfigured — the provider answered a question about a field nobody writes.
 *
 * Measured callers (2026-09-25): neither method has a live one —
 * `registry.get('slack', …)` is reached for `getWebhookHandlers`
 * (`routes/webhooks/slack.ts`), `ingestEvent` (`routes/integrations.ts`) and
 * `publishPost` (unsupported), and the only `.health()`/`.syncRecent()` callers
 * are the X/Instagram admin test routes and the Discord-only sync job. So this is
 * a no-live-regression fix that keeps a future wiring from reporting a healthy
 * bound row as broken; the tests below are the contract for that shape.
 */
const mockGet = jest.fn();
const mockHistory = jest.fn();
const mockSlackApi = jest.fn((token) => ({ token, history: mockHistory }));
const crypto = require('crypto');

jest.mock('../../../services/connectorSecrets', () => ({ get: (...args) => mockGet(...args) }));
jest.mock('../../../services/slackApi', () => mockSlackApi);

const createSlackProvider = require('../../../integrations/providers/slackProvider');

const boundRow = () => createSlackProvider({
  _id: 'i-bound',
  config: { chatId: 'D0123', chatType: 'im', teamId: 'T1', botTokenRef: 'secret-ref-1' },
});

const legacyRow = () => createSlackProvider({
  _id: 'i-legacy',
  config: { channelId: 'C0456', botToken: 'xoxb-legacy' },
});

describe('slackProvider — the row shape the bind writes', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockHistory.mockReset();
    mockSlackApi.mockClear();
    delete process.env.SLACK_BOT_TOKEN;
  });

  it('syncs a bound row by resolving its ref and reading its chatId', async () => {
    mockGet.mockResolvedValue('xoxb-from-ring');
    mockHistory.mockResolvedValue({ messages: [] });

    const result = await boundRow().syncRecent({ hours: 2 });

    expect(mockGet).toHaveBeenCalledWith('secret-ref-1');
    expect(mockSlackApi).toHaveBeenCalledWith('xoxb-from-ring');
    expect(mockHistory.mock.calls[0][0]).toBe('D0123');
    expect(result).toMatchObject({ success: true, messageCount: 0 });
  });

  it('reports a bound row healthy', async () => {
    mockGet.mockResolvedValue('xoxb-from-ring');

    await expect(boundRow().health()).resolves.toEqual({ ok: true });
  });

  it('reports the resolution failure, not "no token", when the ref cannot be read', async () => {
    mockGet.mockRejectedValue(new Error('ConnectorSecretNotFoundError: secret-ref-1'));

    await expect(boundRow().health()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('secret-ref-1'),
    });
  });

  it('still answers for a legacy row from its own channel and token', async () => {
    mockHistory.mockResolvedValue({ messages: [] });

    await legacyRow().syncRecent({ hours: 1 });

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSlackApi).toHaveBeenCalledWith('xoxb-legacy');
    expect(mockHistory.mock.calls[0][0]).toBe('C0456');
  });

  it('falls back to the instance token when no ref and no stored copy exist', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-instance';
    mockHistory.mockResolvedValue({ messages: [] });

    await createSlackProvider({ _id: 'i-env', config: { channelId: 'C0456' } }).syncRecent({ hours: 1 });

    expect(mockSlackApi).toHaveBeenCalledWith('xoxb-instance');
  });

  it('names the missing binding instead of calling Slack with undefined', async () => {
    const row = createSlackProvider({ _id: 'i-empty', config: {} });

    await expect(row.syncRecent({ hours: 1 })).rejects.toThrow(/chat binding/);
    expect(mockHistory).not.toHaveBeenCalled();
    await expect(row.health()).resolves.toMatchObject({ ok: false });
  });

  it('verifies an event with the instance secret, not the row copy, when the row carries one', async () => {
    process.env.SLACK_SIGNING_SECRET = 'instance-secret';
    const payload = { type: 'url_verification', challenge: 'ch-1' };
    const timestamp = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify(payload);
    const signature = `v0=${crypto.createHmac('sha256', 'instance-secret')
      .update(`v0:${timestamp}:${raw}`).digest('hex')}`;

    // The row carries a DIFFERENT, planted copy: the legacy route already
    // verified the request with the instance secret, so this handler must agree
    // with it rather than with the row (TASK-141 — before this it 401'd here).
    const provider = createSlackProvider({
      _id: 'i-planted',
      config: { chatId: 'D0123', signingSecret: 'row-planted-secret' },
    });
    const { events } = provider.getWebhookHandlers();
    const res = {
      code: null, body: null,
      status(code) { this.code = code; return this; },
      send(payloadOut) { this.body = payloadOut; return this; },
      sendStatus(code) { this.code = code; return this; },
    };

    await events({
      headers: { 'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': signature },
      body: payload,
      rawBody: raw,
    }, res);

    expect(res.code).toBe(200);
    expect(res.body).toBe('ch-1');
    delete process.env.SLACK_SIGNING_SECRET;
  });

  it('fails closed when the instance secret is unset, whatever the row holds', async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    const payload = { type: 'url_verification', challenge: 'ch-2' };
    const timestamp = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify(payload);
    const signature = `v0=${crypto.createHmac('sha256', 'row-planted-secret')
      .update(`v0:${timestamp}:${raw}`).digest('hex')}`;

    const provider = createSlackProvider({
      _id: 'i-planted-2',
      config: { chatId: 'D0123', signingSecret: 'row-planted-secret' },
    });
    const { events } = provider.getWebhookHandlers();
    const res = {
      code: null, body: null,
      status(code) { this.code = code; return this; },
      send(payloadOut) { this.body = payloadOut; return this; },
      sendStatus(code) { this.code = code; return this; },
    };

    await events({
      headers: { 'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': signature },
      body: payload,
      rawBody: raw,
    }, res);

    expect(res.code).toBe(401);
  });
});
