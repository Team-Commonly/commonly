const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: '64b64c48c4f37a6b2f34c111' };
  next();
});
jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({
  findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(),
}));
jest.mock('../../../models/InstallableInstallation', () => ({ findOne: jest.fn() }));
jest.mock('../../../utils/secret', () => ({ hash: jest.fn((value) => `hash:${value}`), randomSecret: jest.fn(() => 'nonce-value') }));
jest.mock('../../../services/telegramConnectCode', () => ({
  mintConnectCode: jest.fn(() => ({ connectCode: 'r'.repeat(32), connectCodeExpiresAt: new Date(Date.now() + 60_000) })),
}));
jest.mock('../../../services/connectorSecrets', () => ({ get: jest.fn(), put: jest.fn(), revoke: jest.fn() }));
jest.mock('../../../services/slackApi', () => jest.fn().mockImplementation(() => ({
  openConversation: jest.fn(),
})));
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
  },
};

const own = () => {
  InstallableInstallation.findOne.mockResolvedValue({ _id: 'install-1', targetId: ownerId, status: 'active' });
  Integration.findOne.mockResolvedValue({ ...integration, config: { ...integration.config } });
};

describe('Slack installable OAuth routes', () => {
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
      expect.objectContaining({ $set: expect.objectContaining({ 'config.oauthStateNonceHash': 'hash:nonce-value' }) }),
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
    expect(response.headers.location).toBe('https://commonly.me/v2/connectors?slack=error&code=invalid_state');
    expect(slackOAuth.exchangeCode).not.toHaveBeenCalled();
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
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
    expect(response.headers.location).toBe('https://commonly.me/v2/connectors?slack=pending');
    expect(slackOAuth.exchangeCode).toHaveBeenCalledWith('slack-code');
    expect(connectorSecrets.put).toHaveBeenCalledWith('integration-1', 'slack', 'xoxb-never-store-on-integration');
    const [, commit] = Integration.findOneAndUpdate.mock.calls[1];
    expect(commit.$set['config.pendingBind']).toMatchObject({ teamId: 'T1', chatId: 'D1', botTokenRef: 'secret-ref' });
    expect(JSON.stringify(commit)).not.toContain('xoxb-never-store-on-integration');
  });

  test('confirms only the owner binding and never serializes the secret reference', async () => {
    const pending = {
      teamId: 'T1', teamName: 'Example', slackUserId: 'U1', slackUserName: 'sam',
      chatId: 'D1', botTokenRef: 'secret-ref', expiresAt: new Date(Date.now() + 60_000),
    };
    Integration.findOne.mockResolvedValue({ ...integration, config: { pendingBind: pending } });
    Pod.findById
      .mockResolvedValueOnce({ createdBy: { toString: () => 'another' }, members: [ownerId] })
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Launch' }) }),
      });
    Integration.findOneAndUpdate.mockResolvedValue({
      ...integration,
      status: 'connected',
      config: { ...pending, botTokenRef: 'secret-ref', chatType: 'im' },
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
    expect(SlackApi.mock.results[0].value.postMessage).toHaveBeenCalledWith('D1', '[Launch] connected');
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
