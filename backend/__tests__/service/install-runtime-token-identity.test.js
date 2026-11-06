/**
 * The token issuer refuses an identity with an in-process installation
 * (routes/registry/tokens.ts). Installing has to hold the same line from the
 * other side: an identity that already holds a runtime token can't take an
 * in-process installation, or pod checks that read "in-process, so no channel
 * outside the backend" would be reading a row that isn't true of the identity.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile').default || require('../../models/AgentProfile');
const { outsiderGrantPodRefusal } = require('../../services/outsiderGrantPodEligibility');

const registryRoutes = require('../../routes/registry');

const JWT_SECRET = 'test-jwt-secret-install-token-identity';

jest.setTimeout(60000);

describe('installing an in-process runtime on an identity that holds a token', () => {
  let app;
  let owner;
  let ownerToken;
  let firstPod;
  let privatePod;
  const previousEngine = process.env.HOSTED_ENGINE;

  const install = (body) => request(app)
    .post('/api/registry/install')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(body);

  const byoSeat = async (agentName) => {
    const res = await install({
      agentName,
      podId: firstPod._id.toString(),
      config: { runtime: { runtimeType: 'webhook' } },
      scopes: [],
    });
    expect(res.status).toBe(200);
    return AgentInstallation.findOne({ agentName, podId: firstPod._id });
  };

  const giveUserToken = async (agentName, instanceId = 'default') => {
    const updated = await User.updateOne(
      { isBot: true, 'botMetadata.instanceId': instanceId, username: new RegExp(agentName) },
      { $push: { agentRuntimeTokens: { tokenHash: `hash-${agentName}`, label: 'test', createdAt: new Date() } } },
    );
    expect(updated.modifiedCount).toBe(1);
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
  });

  afterAll(async () => {
    if (previousEngine === undefined) delete process.env.HOSTED_ENGINE;
    else process.env.HOSTED_ENGINE = previousEngine;
    await closeMongoDb();
  });

  beforeEach(async () => {
    process.env.HOSTED_ENGINE = 'native';
    await AgentInstallation.deleteMany({});
    await AgentRegistry.deleteMany({});
    await AgentProfile.deleteMany({});
    await Pod.deleteMany({});
    await User.deleteMany({});
    owner = await User.create({
      username: 'token-identity-owner',
      email: 'token-identity-owner@test.com',
      password: 'password123',
      entitlements: { cloudAgents: true },
    });
    ownerToken = jwt.sign({ id: owner._id.toString() }, JWT_SECRET);
    firstPod = await Pod.create({
      name: 'First', type: 'chat', createdBy: owner._id, members: [owner._id],
    });
    privatePod = await Pod.create({
      name: 'Private',
      type: 'chat',
      createdBy: owner._id,
      members: [owner._id],
      publicRead: false,
      joinPolicy: 'invite-only',
    });
  });

  it.each(['hosted', 'native', ' Native '])('refuses runtimeType %j when the bot user holds a token', async (runtimeType) => {
    await byoSeat('token-seat');
    await giveUserToken('token-seat');

    const res = await install({
      agentName: 'token-seat',
      podId: privatePod._id.toString(),
      config: { runtime: { runtimeType } },
      scopes: [],
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('runtime_token_held');
    expect(await AgentInstallation.findOne({ agentName: 'token-seat', podId: privatePod._id })).toBeNull();
  });

  it('refuses when only a sibling installation holds the token', async () => {
    const seat = await byoSeat('legacy-seat');
    await AgentInstallation.updateOne(
      { _id: seat._id },
      { $push: { runtimeTokens: { tokenHash: 'hash-legacy', label: 'test', createdAt: new Date() } } },
    );

    const res = await install({
      agentName: 'legacy-seat',
      podId: privatePod._id.toString(),
      config: { runtime: { runtimeType: 'hosted' } },
      scopes: [],
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('runtime_token_held');
  });

  it('adds no row, so the pod stays free of that agent', async () => {
    await byoSeat('token-seat');
    await giveUserToken('token-seat');
    await install({
      agentName: 'token-seat',
      podId: privatePod._id.toString(),
      config: { runtime: { runtimeType: 'hosted' } },
      scopes: [],
    });

    const installed = await AgentInstallation.countDocuments({ podId: privatePod._id, agentName: 'token-seat' });
    expect(installed).toBe(0);
    expect(await outsiderGrantPodRefusal({ kind: 'pod', id: privatePod._id })).toBeNull();
  });

  it('still installs an identity with no token in process', async () => {
    await byoSeat('tokenless-seat');

    const res = await install({
      agentName: 'tokenless-seat',
      podId: privatePod._id.toString(),
      config: { runtime: { runtimeType: 'hosted' } },
      scopes: [],
    });

    expect(res.status).toBe(200);
  });

  it('leaves the Durable Object engine alone: that row polls with a token by design', async () => {
    process.env.HOSTED_ENGINE = '';
    await byoSeat('polling-seat');
    await giveUserToken('polling-seat');

    const res = await install({
      agentName: 'polling-seat',
      podId: privatePod._id.toString(),
      config: { runtime: { runtimeType: 'hosted' } },
      scopes: [],
    });

    expect(res.status).toBe(200);
  });

  it('leaves another bring-your-own install of the same identity alone', async () => {
    await byoSeat('second-pod-seat');
    await giveUserToken('second-pod-seat');

    const res = await install({
      agentName: 'second-pod-seat',
      podId: privatePod._id.toString(),
      config: { runtime: { runtimeType: 'webhook' } },
      scopes: [],
    });

    expect(res.status).toBe(200);
  });
});
