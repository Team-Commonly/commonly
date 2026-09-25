// The STATUS half of the manifest predicate (`requiredConfig`), which is the half
// the published contract must not be confused with (TASK-140, wren 74255/74256).
// All three tests are behaviours wren named as the cost of getting the predicate
// wrong; each one reddens if the predicate is "cleaned" to the caller-supplied
// subset or made to name fields nothing writes.
//
// Real Integration/Pod/User rows on memory Mongo: `isManifestComplete` runs
// inside the route, and the missing-field check runs against the model's config
// as stored, which a mocked row would not exercise.
const mongoose = require('mongoose');
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: req.header('x-test-user') };
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../../../services/dmService', () => ({ canViewPod: jest.fn() }));
jest.mock('../../../utils/isPodMember', () => jest.fn(() => true));
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));

const { MongoMemoryServer } = require('mongodb-memory-server');
const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const DMService = require('../../../services/dmService');
const integrationRoutes = require('../../../routes/integrations');

const app = express();
app.use(express.json());
app.use('/api/integrations', integrationRoutes);

// The shape the Slack OAuth commit leaves behind (`routes/installables.ts`):
// the DM it opened, the opaque credential ref, and no `channelId`/`botToken`.
const boundSlackConfig = () => ({
  chatId: 'D0SLACK',
  chatType: 'im',
  chatTitle: 'Slack DM',
  botTokenRef: 'ref-slack-1',
  teamId: 'T0TEAM',
  slackUserId: 'U0USER',
});

describe('manifest predicate drives status (TASK-140)', () => {
  let mongod;
  let pod;
  let user;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    user = await User.create({ username: 'status-owner', email: 'status@task140.test', password: 'placeholder' });
    pod = await Pod.create({ name: 'Status Pod', createdBy: user._id, members: [ user._id ] });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    await Integration.deleteMany({});
    DMService.canViewPod.mockResolvedValue(true);
  });

  it('leaves a bound Slack row connected when its config is patched', async () => {
    const row = await Integration.create({
      podId: pod._id,
      type: 'slack',
      config: boundSlackConfig(),
      status: 'connected',
      createdBy: user._id,
      isActive: true,
    });

    const res = await request(app)
      .patch(`/api/integrations/${row._id}`)
      .set('x-test-user', String(user._id))
      .send({ config: { channelName: 'slack-dm-renamed' } });

    expect(res.status).toBe(200);
    // The PATCH route echoes the projected row itself (not `{ integration }`).
    expect(res.body.status).toBe('connected');
    // The patch itself landed, so this is the predicate and not a no-op route.
    expect(res.body.config.channelName).toBe('slack-dm-renamed');
  });

  it('creates a Telegram row pending, because no chat is bound yet', async () => {
    const res = await request(app)
      .post('/api/integrations')
      .set('x-test-user', String(user._id))
      .send({ podId: String(pod._id), type: 'telegram', config: {} });

    expect(res.status).toBe(201);
    expect(res.body.integration.status).toBe('pending');
  });

  it('answers a tokenless Discord create with the 400, not a 500 after the save', async () => {
    delete process.env.DISCORD_BOT_TOKEN;

    const res = await request(app)
      .post('/api/integrations')
      .set('x-test-user', String(user._id))
      .send({
        podId: String(pod._id),
        type: 'discord',
        config: { serverId: '100000000000000001', channelId: '200000000000000002' },
      });

    expect(res.status).toBe(400);
    expect(res.body.missing).toEqual([ 'botToken' ]);
    // Nothing was saved: the 500-after-save is the failure this 400 prevents.
    expect(await Integration.countDocuments({ type: 'discord' })).toBe(0);
  });

  it('serves the filtered contract from the catalog route', async () => {
    const res = await request(app).get('/api/integrations/catalog').set('x-test-user', String(user._id));

    expect(res.status).toBe(200);
    const entries = res.body.entries;
    const byId = Object.fromEntries(entries.map((entry) => [ entry.id, entry ]));
    expect(byId.discord.requiredConfig).toEqual([ 'serverId', 'channelId' ]);
    expect(byId.slack.requiredConfig).toEqual([]);
    expect(byId.telegram.requiredConfig).toEqual([]);
    expect(byId.discord.configSchema.required).toEqual([ 'serverId', 'channelId' ]);
  });
});
