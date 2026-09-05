const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  next();
});

jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/DiscordIntegration', () => function DiscordIntegration(data) {
  Object.assign(this, data);
  this.save = jest.fn().mockResolvedValue(this);
});

jest.mock('../../../services/discordService', () => jest.fn().mockImplementation(() => ({
  initialize: jest.fn().mockResolvedValue(true),
  connect: jest.fn().mockResolvedValue(true),
  disconnect: jest.fn().mockResolvedValue(true),
  fetchMessages: jest.fn().mockResolvedValue([]),
  sendMessage: jest.fn().mockResolvedValue({ ok: true }),
})));

jest.mock('../../../models/Integration', () => {
  let lastInstance = null;

  function Integration(data) {
    Object.assign(this, data);
    this._id = data._id || 'integration-1';
    this.save = jest.fn().mockResolvedValue(this);
    lastInstance = this;
  }

  Integration.findById = jest.fn();
  Integration.findByIdAndUpdate = jest.fn();
  Integration.aggregate = jest.fn().mockResolvedValue([]);
  Integration.__getLastInstance = () => lastInstance;

  return Integration;
});

const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const Integration = require('../../../models/Integration');
const integrationRoutes = require('../../../routes/integrations');

const INTEGRATION_ID = '64b64c7f8a9e2f0012345678';

const app = express();
app.use(express.json());
app.use('/api/integrations', integrationRoutes);

describe('integration manifest validation', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    Pod.findById.mockResolvedValue({ _id: 'pod-1', createdBy: { toString: () => 'user-1' } });
    User.findById.mockResolvedValue({ _id: 'user-1' });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('allows draft creation for groupme with pending status', async () => {
    const res = await request(app)
      .post('/api/integrations')
      .send({
        podId: 'pod-1',
        type: 'groupme',
        config: { webhookListenerEnabled: true },
      });

    expect(res.status).toBe(201);
    const instance = Integration.__getLastInstance();
    expect(instance).toBeTruthy();
    expect(instance.status).toBe('pending');
    expect(instance.save).toHaveBeenCalled();
  });

  it('rejects setting groupme to connected when required fields are missing', async () => {
    Integration.findById.mockResolvedValue({
      _id: INTEGRATION_ID,
      type: 'groupme',
      podId: 'pod-1',
      createdBy: { toString: () => 'user-1' },
      config: {
        webhookListenerEnabled: true,
        toObject() {
          return { webhookListenerEnabled: true };
        },
      },
    });

    const res = await request(app)
      .patch(`/api/integrations/${INTEGRATION_ID}`)
      .send({ status: 'connected', config: { webhookListenerEnabled: true } });

    if (res.status !== 400) {
      const loggedError = consoleErrorSpy.mock.calls[0]?.[1];
      throw new Error(`unexpected status ${res.status}: ${JSON.stringify(res.body)}; logged=${loggedError?.message}`);
    }
    expect(res.status).toBe(400);
    expect(res.body.missing).toEqual(expect.arrayContaining(['botId', 'groupId']));
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('marks groupme connected when manifest requirements are satisfied', async () => {
    Integration.findById.mockResolvedValue({
      _id: INTEGRATION_ID,
      type: 'groupme',
      podId: 'pod-1',
      createdBy: { toString: () => 'user-1' },
      config: {
        webhookListenerEnabled: true,
        toObject() {
          return { webhookListenerEnabled: true };
        },
      },
    });

    Integration.findByIdAndUpdate.mockResolvedValue({
      _id: INTEGRATION_ID,
      type: 'groupme',
      status: 'connected',
      config: { botId: 'bot-1', groupId: 'group-1' },
    });

    const res = await request(app)
      .patch(`/api/integrations/${INTEGRATION_ID}`)
      .send({
        config: { botId: 'bot-1', groupId: 'group-1' },
      });

    if (res.status !== 200) {
      const loggedError = consoleErrorSpy.mock.calls[0]?.[1];
      throw new Error(`unexpected status ${res.status}: ${JSON.stringify(res.body)}; logged=${loggedError?.message}`);
    }
    expect(res.status).toBe(200);
    const [selector, update, options] = Integration.findByIdAndUpdate.mock.calls[0];
    expect(selector.toHexString()).toBe(INTEGRATION_ID);
    expect(update).toEqual(expect.objectContaining({ status: 'connected' }));
    expect(options).toEqual({ new: true });
  });

  it('rejects discord creation when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/integrations')
      .send({
        podId: 'pod-1',
        type: 'discord',
        config: { serverId: 'server-1' },
      });

    expect(res.status).toBe(400);
    expect(res.body.missing).toEqual(expect.arrayContaining(['channelId']));
  });
});
