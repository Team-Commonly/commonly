/**
 * Regression test for /api/registry/install accepting a query operator as
 * `podId`.
 *
 * CodeQL flagged the `AgentInstallation.findOne` at install.ts and the alert
 * was first read as a false positive, on the premise that `Pod.findById(podId)`
 * + 404 above it already rejects anything that is not a real id. It does not.
 * Mongoose casts an operator object in a filter position rather than throwing,
 * so `Pod.findById({ $ne: null })` MATCHES the first pod in the collection and
 * the 404 never fires — the raw object then reaches four Mongoose filters on
 * this route, one of which (`AgentProfile.findOneAndUpdate`) is an upsert key.
 *
 * The first test is the positive control for that premise: it asserts the
 * upstream guard really does match, so a later refactor cannot quietly turn
 * this suite green for the wrong reason.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile').default || require('../../models/AgentProfile');

const registryRoutes = require('../../routes/registry');

const JWT_SECRET = 'test-jwt-secret-install-podid-operator';

jest.setTimeout(60000);

describe('Install endpoint rejects a query operator as podId', () => {
  let app;
  let installer;
  let installerToken;
  let pod;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);

    installer = await User.create({
      username: 'operator-installer',
      email: 'operator-installer@test.com',
      password: 'password123',
      entitlements: { cloudAgents: true },
    });
    installerToken = jwt.sign({ id: installer._id.toString() }, JWT_SECRET);

    pod = await Pod.create({
      name: 'Operator-Injection Test Pod',
      type: 'chat',
      createdBy: installer._id,
      members: [installer._id],
    });

    await AgentRegistry.create({
      agentName: 'openclaw',
      displayName: 'Cuz 🦞',
      description: 'OpenClaw test',
      manifest: {
        name: 'openclaw',
        version: '1.0.0',
        capabilities: [],
        context: { required: [], optional: [] },
      },
      latestVersion: '1.0.0',
      versions: [{ version: '1.0.0', manifest: { name: 'openclaw', version: '1.0.0', capabilities: [], context: { required: [], optional: [] } }, publishedAt: new Date() }],
      registry: 'private',
    });
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await AgentInstallation.deleteMany({});
    await AgentProfile.deleteMany({});
  });

  // Positive control for the premise the fix rests on. If this ever starts
  // throwing or returning null, the entry-point guard below is still correct
  // but this suite is no longer testing the thing it claims to.
  it('control: Pod.findById with an operator object matches rather than 404ing', async () => {
    const matched = await Pod.findById({ $ne: null }).lean();
    expect(matched).toBeTruthy();
    expect(String(matched._id)).toBe(String(pod._id));
  });

  it('400s on an operator object instead of letting it reach the Mongoose filters', async () => {
    const res = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${installerToken}`)
      .send({
        agentName: 'openclaw',
        instanceId: 'aria',
        podId: { $ne: null },
        version: '1.0.0',
        scopes: ['context:read'],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/podId must be a string/);

    // Nothing may have been written on the way to the rejection — the
    // AgentProfile write is an upsert keyed on podId, so a leak here would
    // create a row rather than merely read one.
    expect(await AgentInstallation.countDocuments({})).toBe(0);
    expect(await AgentProfile.countDocuments({})).toBe(0);
  });

  it('still installs normally when podId is the ordinary id string', async () => {
    const res = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${installerToken}`)
      .send({
        agentName: 'openclaw',
        instanceId: 'aria',
        podId: pod._id.toString(),
        version: '1.0.0',
        scopes: ['context:read'],
      });

    expect(res.status).toBe(200);
    expect(await AgentInstallation.countDocuments({ podId: pod._id })).toBe(1);
  });
});
