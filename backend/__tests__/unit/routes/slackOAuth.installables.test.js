const request = require('supertest');
const express = require('express');
const TEST_PUBLIC_APP_URL = 'https://connectors.example.test';
const originalPublicAppUrl = process.env.PUBLIC_APP_URL;
const originalFrontendUrl = process.env.FRONTEND_URL;

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: '64b64c48c4f37a6b2f34c111' };
  next();
});
jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({
  findOne: jest.fn(), findOneAndUpdate: jest.fn(), findById: jest.fn(), updateOne: jest.fn(),
}));
jest.mock('../../../models/InstallableInstallation', () => ({ findOne: jest.fn() }));
jest.mock('../../../utils/secret', () => ({ randomSecret: jest.fn(() => 'nonce-value') }));
jest.mock('../../../services/telegramConnectCode', () => ({
  mintConnectCode: jest.fn(() => ({ connectCode: 'r'.repeat(32), connectCodeExpiresAt: new Date(Date.now() + 60_000) })),
}));
jest.mock('../../../services/connectorSecrets', () => ({ get: jest.fn(), put: jest.fn(), revoke: jest.fn() }));
// Same reason as slackBridgeService.test.js: the constructor is stubbed, the
// escape is real — the connect marker's escaping is what this file asserts.
jest.mock('../../../services/slackApi', () => {
  const actual = jest.requireActual('../../../services/slackApi');
  const mock = jest.fn().mockImplementation(() => ({
    openConversation: jest.fn(),
  }));
  mock.escapeSlackMrkdwn = actual.escapeSlackMrkdwn;
  return mock;
});
jest.mock('../../../services/slackOAuthService', () => {
  class SlackOAuthConfigurationError extends Error { constructor() { super('not configured'); this.code = 'slack_oauth_not_configured'; } }
  class SlackOAuthExchangeError extends Error { constructor() { super('exchange failed'); this.code = 'slack_oauth_exchange_failed'; } }
  return {
    SlackOAuthConfigurationError,
    SlackOAuthExchangeError,
    buildAuthorizeUrl: jest.fn((state) => `https://slack.test/authorize?state=${state}`),
    exchangeCode: jest.fn(),
  };
});
jest.mock('../../../services/installable/installableInstallationService', () => ({
  install: jest.fn(), uninstall: jest.fn(),
  InstallLockLostError: class InstallLockLostError extends Error {},
  InstallableAlreadyInstalledError: class InstallableAlreadyInstalledError extends Error {},
  InstallableNotFoundError: class InstallableNotFoundError extends Error {},
  InstallableProjectionError: class InstallableProjectionError extends Error {},
  InstallInProgressError: class InstallInProgressError extends Error {},
}));

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const InstallableInstallation = require('../../../models/InstallableInstallation');
const connectorSecrets = require('../../../services/connectorSecrets');
const { mintConnectCode } = require('../../../services/telegramConnectCode');
const SlackApi = require('../../../services/slackApi');
const deliveryFailures = require('../../../services/connectorDeliveryFailureService');
const slackOAuth = require('../../../services/slackOAuthService');
const installableRoutes = require('../../../routes/installables');

const app = express();
app.use(express.json());
app.use('/api/installables', installableRoutes);
app.use('/api/webhooks/slack/oauth', installableRoutes.slackOAuthCallbackRouter);

const ownerId = '64b64c48c4f37a6b2f34c111';
const integration = {
  _id: 'integration-1',
  installationId: 'install-1',
  type: 'slack',
  isActive: true,
  podId: '64b64c48c4f37a6b2f34c222',
  config: {
    connectCode: 'c'.repeat(32),
    connectCodeExpiresAt: new Date(Date.now() + 60_000),
    oauthStateNonce: 'nonce-value',
  },
};

const own = () => {
  InstallableInstallation.findOne.mockResolvedValue({ _id: 'install-1', targetId: ownerId, status: 'active' });
  Integration.findOne.mockResolvedValue({ ...integration, config: { ...integration.config } });
};

describe('Slack installable OAuth routes', () => {
  beforeAll(() => {
    process.env.PUBLIC_APP_URL = TEST_PUBLIC_APP_URL;
    delete process.env.FRONTEND_URL;
  });

  afterAll(() => {
    if (originalPublicAppUrl === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = originalPublicAppUrl;
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    own();
  });

  test('mints a browser-bound nonce and sends only the lifecycle code as OAuth state', async () => {
    Integration.findOneAndUpdate.mockResolvedValue({ ...integration });
    const response = await request(app).post('/api/installables/slack/authorize-url');

    expect(response.status).toBe(200);
    expect(response.body.authorizeUrl).toContain(`state=${integration.config.connectCode}`);
    expect(response.headers['set-cookie'][0]).toContain('commonly_slack_oauth_nonce=nonce-value');
    expect(Integration.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'integration-1', 'config.connectCode': integration.config.connectCode }),
      expect.objectContaining({
        $set: expect.objectContaining({
          'config.oauthStateNonce': 'nonce-value',
        }),
      }),
      expect.anything(),
    );
  });

  test('re-mints an expired Slack OAuth state without disconnecting the install', async () => {
    const expired = {
      ...integration,
      config: { ...integration.config, connectCodeExpiresAt: new Date(Date.now() - 1_000) },
    };
    Integration.findOne.mockResolvedValue(expired);
    Integration.findOneAndUpdate
      .mockResolvedValueOnce({ ...integration, config: { ...integration.config, connectCode: 'r'.repeat(32) } })
      .mockResolvedValueOnce({ ...integration, config: { ...integration.config, connectCode: 'r'.repeat(32) } });

    const response = await request(app).post('/api/installables/slack/authorize-url');

    expect(response.status).toBe(200);
    expect(mintConnectCode).toHaveBeenCalledTimes(1);
    expect(slackOAuth.buildAuthorizeUrl).toHaveBeenCalledWith('r'.repeat(32));
    expect(Integration.findOneAndUpdate.mock.calls[0]).toEqual([
      expect.objectContaining({ _id: 'integration-1', type: 'slack', isActive: true }),
      expect.objectContaining({ $set: expect.objectContaining({ 'config.connectCode': 'r'.repeat(32) }) }),
      expect.anything(),
    ]);
  });

  test('refuses a callback without its browser nonce before Slack exchange', async () => {
    const response = await request(app)
      .get(`/api/webhooks/slack/oauth/callback?state=${integration.config.connectCode}&code=slack-code`);

    expect(response.status).toBe(302);
    expect(slackOAuth.exchangeCode).not.toHaveBeenCalled();
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
    expect(response.headers.location).toBe(`${TEST_PUBLIC_APP_URL}/v2/connectors?slack=error&code=invalid_state`);
  });

  test('refuses a callback with a different-length browser nonce before Slack exchange', async () => {
    const response = await request(app)
      .get(`/api/webhooks/slack/oauth/callback?state=${integration.config.connectCode}&code=slack-code`)
      .set('Cookie', 'commonly_slack_oauth_nonce=short');

    expect(slackOAuth.exchangeCode).not.toHaveBeenCalled();
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`${TEST_PUBLIC_APP_URL}/v2/connectors?slack=error&code=invalid_state`);
  });

  test('stores only a secret reference in a pending bind after a claimed callback', async () => {
    Integration.findOneAndUpdate
      .mockResolvedValueOnce({ ...integration })
      .mockResolvedValueOnce({ ...integration, config: { pendingBind: { botTokenRef: 'secret-ref' } } });
    slackOAuth.exchangeCode.mockResolvedValue({
      accessToken: 'xoxb-never-store-on-integration',
      teamId: 'T1', teamName: 'Example', slackUserId: 'U1', slackUserName: 'sam',
    });
    SlackApi.mock.instances[0]?.openConversation?.mockResolvedValue({ ok: true, channel: { id: 'D1' } });
    // Constructor instance is created inside the handler; set its method via
    // the default implementation's return object after construction below.
    SlackApi.mockImplementationOnce(() => ({ openConversation: jest.fn().mockResolvedValue({ ok: true, channel: { id: 'D1' } }) }));
    connectorSecrets.put.mockResolvedValue('secret-ref');

    const response = await request(app)
      .get(`/api/webhooks/slack/oauth/callback?state=${integration.config.connectCode}&code=slack-code`)
      .set('Cookie', 'commonly_slack_oauth_nonce=nonce-value');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`${TEST_PUBLIC_APP_URL}/v2/connectors?slack=pending`);
    expect(slackOAuth.exchangeCode).toHaveBeenCalledWith('slack-code');
    expect(connectorSecrets.put).toHaveBeenCalledWith('integration-1', 'slack', 'xoxb-never-store-on-integration');
    const [, commit] = Integration.findOneAndUpdate.mock.calls[1];
    expect(commit.$set['config.pendingBind']).toMatchObject({ teamId: 'T1', chatId: 'D1', botTokenRef: 'secret-ref' });
    expect(JSON.stringify(commit)).not.toContain('xoxb-never-store-on-integration');
  });

  test('refuses a replayed browser nonce when its row already has a pending bind', async () => {
    Integration.findOne
      .mockResolvedValueOnce({ ...integration, config: { ...integration.config } })
      // A replay sees the same row after the first callback has committed its
      // pending bind. The selector below must exclude it, so Mongo returns no
      // candidate rather than exposing its consumed nonce.
      .mockResolvedValueOnce(null);
    Integration.findOneAndUpdate
      .mockResolvedValueOnce({ ...integration })
      .mockResolvedValueOnce({ ...integration, config: { pendingBind: { botTokenRef: 'secret-ref' } } });
    slackOAuth.exchangeCode.mockResolvedValue({
      accessToken: 'xoxb-never-store-on-integration',
      teamId: 'T1', teamName: 'Example', slackUserId: 'U1', slackUserName: 'sam',
    });
    SlackApi.mockImplementationOnce(() => ({ openConversation: jest.fn().mockResolvedValue({ ok: true, channel: { id: 'D1' } }) }));
    connectorSecrets.put.mockResolvedValue('secret-ref');

    const first = await request(app)
      .get(`/api/webhooks/slack/oauth/callback?state=${integration.config.connectCode}&code=slack-code`)
      .set('Cookie', 'commonly_slack_oauth_nonce=nonce-value');
    const exchangesBeforeReplay = slackOAuth.exchangeCode.mock.calls.length;
    const writesBeforeReplay = Integration.findOneAndUpdate.mock.calls.length;
    const replay = await request(app)
      .get(`/api/webhooks/slack/oauth/callback?state=${integration.config.connectCode}&code=slack-code`)
      .set('Cookie', 'commonly_slack_oauth_nonce=nonce-value');

    expect(Integration.findOne.mock.calls[1][0]).toEqual(expect.objectContaining({
      'config.pendingBind': { $exists: false },
    }));
    expect(slackOAuth.exchangeCode).toHaveBeenCalledTimes(exchangesBeforeReplay);
    expect(Integration.findOneAndUpdate).toHaveBeenCalledTimes(writesBeforeReplay);
    expect(first.headers.location).toBe(`${TEST_PUBLIC_APP_URL}/v2/connectors?slack=pending`);
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toBe(`${TEST_PUBLIC_APP_URL}/v2/connectors?slack=error&code=invalid_state`);
    expect(exchangesBeforeReplay).toBe(1);
    expect(writesBeforeReplay).toBe(2);
  });

  test('confirms only the owner binding and never serializes secret material', async () => {
    const pending = {
      teamId: 'T1', teamName: 'Example', slackUserId: 'U1', slackUserName: 'sam',
      chatId: 'D1', botTokenRef: 'secret-ref', expiresAt: new Date(Date.now() + 60_000),
    };
    Integration.findOne.mockResolvedValue({ ...integration, config: { pendingBind: pending } });
    Pod.findById
      .mockResolvedValueOnce({ createdBy: { toString: () => 'another' }, members: [ownerId] })
      .mockReturnValueOnce({
        // Purposefully hostile: this name is interpolated into the marker a
        // human reads in Slack, and mrkdwn would draw `<...>` as markup.
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: '<Evil|pod>' }) }),
      });
    Integration.findOneAndUpdate.mockResolvedValue({
      ...integration,
      status: 'connected',
      // Plain-object return deliberately bypasses Integration.toJSON(), as a
      // lean query would. The route backstop must still strip both values.
      config: { ...pending, botTokenRef: 'secret-ref', oauthStateNonce: 'nonce-never-return', chatType: 'im' },
    });
    connectorSecrets.get.mockResolvedValue('xoxb-secret');
    SlackApi.mockImplementationOnce(() => ({ postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '1.1' }) }));

    const response = await request(app).post('/api/installables/slack/confirm');

    expect(response.status).toBe(200);
    expect(Integration.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'integration-1', 'config.pendingBind.botTokenRef': 'secret-ref' }),
      expect.objectContaining({ $set: expect.objectContaining({ 'config.chatType': 'im', 'config.botTokenRef': 'secret-ref' }) }),
      expect.anything(),
    );
    expect(JSON.stringify(response.body)).not.toContain('secret-ref');
    expect(JSON.stringify(response.body)).not.toContain('nonce-never-return');
    expect(SlackApi.mock.results[0].value.postMessage).toHaveBeenCalledWith('D1', '[&lt;Evil|pod&gt;] connected');
  });

  test('a reconnect clears the reason an earlier flip left on the row (wren 73838)', async () => {
    const pending = {
      teamId: 'T1', slackUserId: 'U1', chatId: 'D1', botTokenRef: 'secret-ref',
      expiresAt: new Date(Date.now() + 60_000),
    };
    Integration.findOne.mockResolvedValue({ ...integration, config: { pendingBind: pending } });
    Pod.findById
      .mockResolvedValueOnce({ createdBy: { toString: () => 'another' }, members: [ownerId] })
      .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Pod' }) }) });
    Integration.findOneAndUpdate.mockResolvedValue({ ...integration, status: 'connected', config: { ...pending, chatType: 'im' } });
    connectorSecrets.get.mockResolvedValue('xoxb-secret');
    SlackApi.mockImplementationOnce(() => ({ postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '1.1' }) }));

    const response = await request(app).post('/api/installables/slack/confirm');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('connected');
    // A bind is the only thing that proves the connector works again, so it is
    // the only thing that may clear what a flip wrote — otherwise a reconnect
    // after any failure keeps naming a reason that is no longer true.
    expect(Integration.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'integration-1' }),
      expect.objectContaining({ $set: expect.objectContaining({ errorMessage: null }) }),
      expect.anything(),
    );
  });

  test('a permanent refusal on the confirmation marker flips the connector and names the reason (wren 73837)', async () => {
    const pending = {
      teamId: 'T1', slackUserId: 'U1', chatId: 'D1', botTokenRef: 'secret-ref',
      expiresAt: new Date(Date.now() + 60_000),
    };
    // The marker goes to the chat this confirm just stored, so this is a
    // bound-chat send — the twin of the Telegram bind confirmation.
    Integration.findOne.mockResolvedValue({ ...integration, config: { pendingBind: pending } });
    Pod.findById
      .mockResolvedValueOnce({ createdBy: { toString: () => 'another' }, members: [ownerId] })
      .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Pod' }) }) });
    Integration.findOneAndUpdate.mockResolvedValue({ ...integration, status: 'connected', config: { ...pending, chatType: 'im' } });
    connectorSecrets.get.mockResolvedValue('xoxb-secret');
    SlackApi.mockImplementationOnce(() => ({ postMessage: jest.fn().mockResolvedValue({ ok: false, error: 'channel_not_found' }) }));
    // The route re-reads after a flip, so the response cannot keep saying
    // "connected" while the row says the connector needs attention.
    Integration.findById.mockResolvedValue({
      ...integration, status: 'error', errorMessage: deliveryFailures.SLACK_CHANNEL_GONE_REASON, config: {},
    });

    const response = await request(app).post('/api/installables/slack/confirm');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('error');
    expect(Integration.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'integration-1', 'config.chatId': 'D1' },
      {
        $set: { status: 'error', errorMessage: deliveryFailures.SLACK_CHANNEL_GONE_REASON },
        $unset: { 'config.chatId': '' },
      },
      { new: true },
    );
  });

  test('rejects a pending Slack bind and revokes its secret reference', async () => {
    const pending = {
      teamId: 'T1', slackUserId: 'U1', chatId: 'D1', botTokenRef: 'secret-ref',
      expiresAt: new Date(Date.now() + 60_000),
    };
    Integration.findOne.mockResolvedValue({ ...integration, config: { pendingBind: pending } });
    Integration.findOneAndUpdate.mockResolvedValue({ ...integration, config: {} });

    const response = await request(app).post('/api/installables/slack/reject');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'rejected' });
    expect(Integration.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'integration-1', 'config.pendingBind.botTokenRef': 'secret-ref' }),
      { $unset: { 'config.pendingBind': 1 } },
      expect.anything(),
    );
    expect(connectorSecrets.revoke).toHaveBeenCalledWith('secret-ref');
  });

  test('expires a stale pending bind back to active pending, not an invisible inactive row', async () => {
    const pending = {
      teamId: 'T1', slackUserId: 'U1', chatId: 'D1', botTokenRef: 'secret-ref',
      expiresAt: new Date(Date.now() - 60_000),
    };
    Integration.findOne.mockResolvedValue({ ...integration, config: { pendingBind: pending } });
    Integration.findOneAndUpdate.mockResolvedValue({ ...integration, status: 'pending', isActive: true, config: {} });

    const response = await request(app).post('/api/installables/slack/confirm');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('slack_bind_expired');
    expect(Integration.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'integration-1', 'config.pendingBind.botTokenRef': 'secret-ref' }),
      expect.objectContaining({ $set: { status: 'pending', errorMessage: null } }),
      expect.anything(),
    );
    expect(connectorSecrets.revoke).toHaveBeenCalledWith('secret-ref');
  });
});

// The suite above hands the routes plain objects, where an absent pendingBind
// is absent. Production hands them a Mongoose document, and `config.pendingBind`
// is a nested schema path: it hydrates as `{}` on a row that has no bind. Read
// by truthiness, that refused every new Slack install from #1537 on. These
// tests go through the real model so the route sees what `findOne` returns.
describe('Slack routes on a hydrated Integration document', () => {
  const RealIntegration = jest.requireActual('../../../models/Integration');
  const hydrated = (config) => RealIntegration.hydrate({
    _id: '64b64c48c4f37a6b2f34c333',
    installationId: 'install-1',
    type: 'slack',
    status: 'pending',
    isActive: true,
    config,
  });
  const freshInstall = () => hydrated({
    connectCode: 'c'.repeat(32),
    connectCodeExpiresAt: new Date(Date.now() + 60_000),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    InstallableInstallation.findOne.mockResolvedValue({ _id: 'install-1', targetId: ownerId, status: 'active' });
  });

  test('the hydrated shape this guards: a row with no bind still carries a truthy pendingBind', () => {
    // If a schema change ever stops this, the tests below stop proving anything.
    expect(freshInstall().config.pendingBind).toBeTruthy();
  });

  test('a fresh install with no bind gets an authorize URL', async () => {
    const doc = freshInstall();
    Integration.findOne.mockResolvedValue(doc);
    Integration.findOneAndUpdate.mockResolvedValue(doc);

    const response = await request(app).post('/api/installables/slack/authorize-url');

    expect(response.status).toBe(200);
    expect(response.body.authorizeUrl).toContain(`state=${'c'.repeat(32)}`);
  });

  test('a row that holds a bind is still refused as already authorized', async () => {
    Integration.findOne.mockResolvedValue(hydrated({
      pendingBind: {
        chatId: 'D1', botTokenRef: 'secret-ref', expiresAt: new Date(Date.now() + 60_000),
      },
    }));

    const response = await request(app).post('/api/installables/slack/authorize-url');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('slack_already_authorized');
  });

  test.each(['confirm', 'reject'])('%s with no bind is named as missing and writes nothing', async (verb) => {
    Integration.findOne.mockResolvedValue(freshInstall());

    const response = await request(app).post(`/api/installables/slack/${verb}`);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('slack_bind_missing');
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
    expect(connectorSecrets.revoke).not.toHaveBeenCalled();
  });
});
