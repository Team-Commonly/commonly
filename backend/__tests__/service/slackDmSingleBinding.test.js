// TASK-262 (C5): one Slack DM is one attention surface, so it can be bound to
// one Commonly account at a time. A second account that confirms the same DM
// is refused by name, and the first binding is left exactly as it was.
//
// This is a real mongod (Tier 1, INTEGRATION_TEST=true): the claim is about the
// unique partial index `unique_active_slack_dm`, and a mocked model cannot say
// which documents that index refuses. The route's own preflight is the first
// refusal; the index is asserted separately so the second arm is not just the
// preflight passing by accident.
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

// A literal, because a `jest.mock` factory may not close over an out-of-scope
// binding: the id has to be the same string on both sides of the seam.
const SECOND_ACCOUNT_ID = '6a8f6de2a1dccf2e02f31500';

jest.mock('../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: '6a8f6de2a1dccf2e02f31500' };
  next();
});
jest.mock('../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
  ingestIngressRateLimit: (_req, _res, next) => next(),
  ingestIntegrationsRateLimit: (_req, _res, next) => next(),
}));
// Confirm refuses before it touches Slack or the secret store, so neither is
// reached. Stubbed so the route module loads without live credentials.
jest.mock('../../services/connectorSecrets', () => ({ get: jest.fn(), put: jest.fn(), revoke: jest.fn() }));

const Integration = require('../../models/Integration');
const InstallableInstallation = require('../../models/InstallableInstallation');
const Pod = require('../../models/Pod');
const User = require('../../models/User');

const FIRST_OWNER = new mongoose.Types.ObjectId();
const SECOND_OWNER = new mongoose.Types.ObjectId(SECOND_ACCOUNT_ID);
const TEAM_ID = 'T-TASK262';
const CHAT_ID = 'D-TASK262';

const inFiveMinutes = () => new Date(Date.now() + 5 * 60_000);

const app = express();
app.use(express.json());
app.use('/api/installables', require('../../routes/installables'));

const seedInstallation = async (owner) => {
  const { insertedId } = await InstallableInstallation.collection.insertOne({
    installableId: 'slack',
    installableVersion: '1.0.0',
    targetType: 'user',
    targetId: owner,
    status: 'active',
    installedBy: owner,
    config: {},
  });
  return insertedId;
};

describe('TASK-262: one Slack DM binds to one Commonly account', () => {
  let pod;
  let firstInstallationId;
  let secondInstallationId;
  let firstRowId;
  let secondRowId;

  beforeAll(async () => {
    await setupMongoDb();
    await Integration.init();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
    await Integration.init();
    await User.collection.insertMany([
      { _id: FIRST_OWNER, username: 'lily-shen', email: 'first@test.invalid' },
      { _id: SECOND_OWNER, username: 'sam-xu', email: 'second@test.invalid' },
    ]);
    const createdPod = await Pod.collection.insertOne({
      name: 'Connector walk', type: 'chat', members: [SECOND_OWNER], createdBy: SECOND_OWNER,
    });
    pod = createdPod.insertedId;
    firstInstallationId = await seedInstallation(FIRST_OWNER);
    secondInstallationId = await seedInstallation(SECOND_OWNER);

    // The first account's bind is already confirmed: an active row on this DM.
    const first = await Integration.collection.insertOne({
      scope: 'user',
      type: 'slack',
      status: 'connected',
      isActive: true,
      createdBy: FIRST_OWNER,
      installationId: String(firstInstallationId),
      config: {
        teamId: TEAM_ID,
        chatId: CHAT_ID,
        chatType: 'im',
        slackUserId: 'U-TASK262',
        slackUserName: 'lily',
        botTokenRef: 'ref-first',
      },
    });
    firstRowId = first.insertedId;

    // The second account's OAuth callback has parked a pending bind for the
    // same DM and is waiting for its owner to confirm.
    const second = await Integration.collection.insertOne({
      scope: 'user',
      type: 'slack',
      status: 'pending',
      isActive: true,
      createdBy: SECOND_OWNER,
      podId: pod,
      installationId: String(secondInstallationId),
      config: {
        pendingBind: {
          teamId: TEAM_ID,
          teamName: 'Walk team',
          chatId: CHAT_ID,
          slackUserId: 'U-TASK262',
          slackUserName: 'sam',
          botTokenRef: 'ref-second',
          expiresAt: inFiveMinutes(),
        },
      },
    });
    secondRowId = second.insertedId;
  });

  test('the unique index that backs the refusal exists on the real collection', async () => {
    expect(await Integration.collection.indexExists('unique_active_slack_dm')).toBe(true);
  });

  test('a second account confirming the same DM is refused by name, not a 500', async () => {
    const res = await request(app).post('/api/installables/slack/confirm').send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('slack_dm_already_bound');
    expect(res.body.error).toContain('@lily-shen');
  });

  test('the first binding stays intact after the refusal', async () => {
    await request(app).post('/api/installables/slack/confirm').send({});

    const first = await Integration.findById(firstRowId).lean();
    expect(first.isActive).toBe(true);
    expect(first.status).toBe('connected');
    expect(String(first.createdBy)).toBe(String(FIRST_OWNER));
    expect(first.config.chatId).toBe(CHAT_ID);
    expect(first.config.botTokenRef).toBe('ref-first');
  });

  test('the refused account keeps its pending bind and never reaches connected', async () => {
    await request(app).post('/api/installables/slack/confirm').send({});

    const second = await Integration.findById(secondRowId).lean();
    expect(second.status).not.toBe('connected');
    expect(second.config.chatId).toBeUndefined();
    expect(second.config.pendingBind.botTokenRef).toBe('ref-second');
  });

  test('exactly one active row exists for the DM after the refusal', async () => {
    await request(app).post('/api/installables/slack/confirm').send({});

    const active = await Integration.countDocuments({
      type: 'slack', isActive: true, 'config.teamId': TEAM_ID, 'config.chatId': CHAT_ID, 'config.chatType': 'im',
    });
    expect(active).toBe(1);
  });

  test('the index refuses a second active row for the DM even without the preflight', async () => {
    await expect(Integration.collection.insertOne({
      scope: 'user',
      type: 'slack',
      status: 'connected',
      isActive: true,
      createdBy: SECOND_OWNER,
      config: { teamId: TEAM_ID, chatId: CHAT_ID, chatType: 'im' },
    })).rejects.toMatchObject({ code: 11000 });
  });
});
