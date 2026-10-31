// A real Mongo row catches gate updates that a mocked findOneAndUpdate cannot.
jest.mock('jsonwebtoken', () => ({}));
jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: '64b64c48c4f37a6b2f34c111' };
  next();
});
jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../../../models/InstallableInstallation', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/connectorSecrets', () => ({ get: jest.fn() }));
jest.mock('../../../services/slackOAuthService', () => ({
  SlackOAuthConfigurationError: class extends Error {},
  SlackOAuthExchangeError: class extends Error {},
}));
jest.mock('../../../services/installable/installableInstallationService', () => ({
  install: jest.fn(), uninstall: jest.fn(),
  InstallLockLostError: class extends Error {},
  InstallableAlreadyInstalledError: class extends Error {},
  InstallableNotFoundError: class extends Error {},
  InstallableProjectionError: class extends Error {},
  InstallInProgressError: class extends Error {},
  InstallationPausedError: class extends Error {},
}));
jest.mock('../../../services/connectorDeliveryFailureService', () => ({
  noteBoundChatDeliveryFailure: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../services/slackApi', () => {
  const actual = jest.requireActual('../../../services/slackApi');
  const postMessage = jest.fn().mockResolvedValue({ ok: true, ts: '1.1' });
  const SlackApi = jest.fn().mockImplementation(() => ({ postMessage }));
  SlackApi.escapeSlackMrkdwn = actual.escapeSlackMrkdwn;
  SlackApi.postMessage = postMessage;
  return SlackApi;
});

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const InstallableInstallation = require('../../../models/InstallableInstallation');
const connectorSecrets = require('../../../services/connectorSecrets');
const SlackApi = require('../../../services/slackApi');
const { relayAgentMessageToSlack } = require('../../../services/slackBridgeService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const routes = require('../../../routes/installables');

const app = express();
app.use(express.json());
app.use('/api/installables', routes);

const ownerId = new mongoose.Types.ObjectId('64b64c48c4f37a6b2f34c111');
const botId = new mongoose.Types.ObjectId();

describe('Slack lead confirmation gate race', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await Integration.syncIndexes();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    SlackApi.postMessage.mockClear();
    await clearMongoDb();
  });
  afterAll(async () => closeMongoDb());

  const setup = async (gate) => {
    await User.create([
      { _id: ownerId, username: 'owner', email: 'owner@example.test', password: 'Password123!' },
      { _id: botId, username: 'kai', email: 'kai@example.test', password: 'Password123!', isBot: true },
    ]);
    const pod = await Pod.create({
      name: 'Team', type: 'team', createdBy: ownerId, members: [ownerId, botId],
    });
    const installationId = new mongoose.Types.ObjectId().toString();
    InstallableInstallation.findOne.mockResolvedValue({ _id: installationId });
    connectorSecrets.get.mockResolvedValue('xoxb-test');
    const integration = await Integration.create({
      installationId, type: 'slack', scope: 'user', status: 'pending',
      podId: pod._id, createdBy: ownerId, isActive: true,
      config: {
        liveRelay: true,
        pendingBind: {
          teamId: 'T1', chatId: 'D1', slackUserId: 'U1',
          botTokenRef: 'secret-ref', expiresAt: new Date(Date.now() + 60_000),
        },
        ...(gate ? { gates: { [String(pod._id)]: gate } } : {}),
      },
    });
    return { pod, integration };
  };

  it.each([
    [{ enabled: false, mode: 'attention' }],
    [{ enabled: true, mode: 'attention' }],
  ])('preserves a concurrent owner gate change and does not relay an ordinary message', async (ownerGate) => {
    const { pod, integration } = await setup({
      enabled: true, mode: 'mirror', since: new Date('2026-10-01'),
    });
    const write = Integration.findOneAndUpdate.bind(Integration);
    jest.spyOn(Integration, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
      await Integration.updateOne(
        { _id: integration._id },
        { $set: {
          [`config.gates.${pod._id}.enabled`]: ownerGate.enabled,
          [`config.gates.${pod._id}.mode`]: ownerGate.mode,
        } },
      );
      return write(...args);
    });

    const response = await request(app).post('/api/installables/slack/confirm')
      .send({ leadAgentUsername: 'kai' });
    expect(response.status).toBe(200);
    const stored = await Integration.findById(integration._id).lean();
    expect(stored.config.gates[String(pod._id)]).toMatchObject({ ...ownerGate, lead: 'kai' });

    SlackApi.postMessage.mockClear(); // Ignore the intentional connect marker.
    await relayAgentMessageToSlack({
      podId: String(pod._id), agentUsername: 'other', displayName: 'Other',
      content: 'ordinary pod message', integration: stored,
    });
    expect(SlackApi.postMessage).not.toHaveBeenCalled();
  });

  it('does not overwrite a gate created while the bind was being confirmed', async () => {
    const { pod, integration } = await setup(null);
    const write = Integration.findOneAndUpdate.bind(Integration);
    jest.spyOn(Integration, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
      await Integration.updateOne(
        { _id: integration._id },
        { $set: {
          [`config.gates.${pod._id}`]: {
            enabled: false, mode: 'attention', since: new Date(),
          },
        } },
      );
      return write(...args);
    });

    const response = await request(app).post('/api/installables/slack/confirm')
      .send({ leadAgentUsername: 'kai' });
    expect(response.status).toBe(409);
    const stored = await Integration.findById(integration._id).lean();
    expect(stored.config.gates[String(pod._id)]).toMatchObject({
      enabled: false, mode: 'attention',
    });
    expect(stored.config.chatId).toBeUndefined();
  });

  it('initializes a missing gate when nobody changed it during confirmation', async () => {
    const { pod, integration } = await setup(null);
    const response = await request(app).post('/api/installables/slack/confirm')
      .send({ leadAgentUsername: 'kai' });
    expect(response.status).toBe(200);
    const stored = await Integration.findById(integration._id).lean();
    expect(stored.config.gates[String(pod._id)]).toMatchObject({
      enabled: true, lead: 'kai', since: expect.any(Date),
    });
  });
});
