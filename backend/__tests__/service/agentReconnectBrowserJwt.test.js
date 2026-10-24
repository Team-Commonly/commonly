const request = require('supertest');
const express = require('express');
const User = require('../../models/User');
const Machine = require('../../models/Machine');
const AgentCredential = require('../../models/AgentCredential');
const agentBindingRoutes = require('../../routes/agentBinding');
const { hash } = require('../../utils/secret');
const {
  setupMongoDb, closeMongoDb, clearMongoDb, generateTestToken,
} = require('../utils/testUtils');

// Exercise the browser JWT through the real auth middleware. A fabricated
// req.user would miss a dropped role field and make the admin path look green.
describe('agent reconnect with a browser JWT', () => {
  let app;
  let seq = 0;

  beforeAll(async () => {
    await setupMongoDb();
    process.env.JWT_SECRET = 'agent-reconnect-browser-jwt-test-secret';
    app = express();
    app.use(express.json());
    app.use('/api/agent-binding', agentBindingRoutes);
  });

  afterAll(async () => { await closeMongoDb(); });
  afterEach(async () => { await clearMongoDb(); });

  const user = async (role, isBot = false) => {
    seq += 1;
    return User.create({
      username: `reconnect-jwt-${seq}`,
      email: `reconnect-jwt-${seq}@example.com`,
      password: 'hashed-pass',
      role,
      isBot,
      ...(isBot ? { botMetadata: { agentName: 'local', instanceId: 'alpha', machineId: 'machine-owner' } } : {}),
    });
  };

  it('allows an admin to request a bound agent rekey and refuses a non-owner', async () => {
    const owner = await user('user');
    const admin = await user('admin');
    const stranger = await user('user');
    const bot = await user('user', true);
    await Machine.create({ ownerUserId: owner._id, machineId: 'machine-owner', name: 'Owner computer' });
    await AgentCredential.create({
      tokenHash: hash(`cm_daemon_${'a'.repeat(32)}`), kind: 'daemon', ownerUserId: owner._id,
      machineId: 'machine-owner', scopes: ['agents:adopt'],
    });

    const call = (actor) => request(app)
      .post('/api/agent-binding/reconnect')
      .set('Authorization', `Bearer ${generateTestToken(String(actor._id))}`)
      .send({ agentName: 'local', instanceId: 'alpha' });

    const allowed = await call(admin);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual(expect.objectContaining({
      requested: true, agentName: 'local', instanceId: 'alpha', machineId: 'machine-owner',
    }));
    expect((await User.findById(bot._id)).botMetadata.reconnectRequestedAt).toBeTruthy();

    const denied = await call(stranger);
    expect(denied.status).toBe(403);
  });
});
