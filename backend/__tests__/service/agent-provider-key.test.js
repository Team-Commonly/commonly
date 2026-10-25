const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
let User, Machine, Installation, Key, Secret, manageProviderKey, launchProviderKey;
const owner = new mongoose.Types.ObjectId();
const other = new mongoose.Types.ObjectId();
let bot, installation;
const material = 'sk-private-TEST-never-forward-to-tools';
const response = () => ({ statusCode: 200, headers: {},
  set(key, value) { this.headers[key] = value; return this; },
  status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const manage = async (method, body = {}, user = owner) => {
  const res = response();
  await manageProviderKey({ method, body, params: { name: 'key-seat' }, query: {}, user: { id: user } }, res);
  return res;
};
const launch = (extra = {}) => ({ body: { agentName: 'key-seat', instanceId: 'default', harness: 'opencode', providerId: 'test-provider', baseURL: 'https://api.example.com/v1' },
  machine: { ownerUserId: String(owner), machineId: 'machine-key' },
  agentUser: bot, agentInstallation: installation, ...extra });
beforeAll(async () => {
  process.env.CONNECTOR_SECRET_KEYS = `test:${Buffer.alloc(32, 7).toString('base64')}`;
  process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'test';
  await setupMongoDb();
  User = require('../../models/User'); Machine = require('../../models/Machine');
  Installation = require('../../models/AgentRegistry').AgentInstallation;
  Key = require('../../models/AgentProviderKey'); Secret = require('../../models/ConnectorSecret');
  ({ manageProviderKey, launchProviderKey } = require('../../services/agentProviderKey'));
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Machine.deleteMany({}), Installation.deleteMany({}), Key.deleteMany({}), Secret.deleteMany({})]);
  bot = await User.create({ username: 'key-seat', email: 'key-seat@test.invalid', password: 'pw', isBot: true,
    botMetadata: { agentName: 'key-seat', instanceId: 'default', machineId: 'machine-key' } });
  await Machine.create({ ownerUserId: owner, machineId: 'machine-key', name: 'test' });
  installation = await Installation.create({ agentName: 'key-seat', instanceId: 'default', podId: new mongoose.Types.ObjectId(),
    version: '1', installedBy: owner, status: 'active', config: new Map([
      ['runtime', { runtimeType: 'wrapper', adapter: 'opencode', host: 'byo' }],
      ['environment', { model: 'm', sandbox: { trust: 'public', mode: 'workspace' }, provider: {
        id: 'test-provider', baseURL: 'https://api.example.com/v1', keyFile: '/never/read' } }],
    ]) });
});
afterAll(async () => { await closeMongoDb(); });
it('owner reads only four metadata fields; encryption stays out of config and model output', async () => {
  expect((await manage('GET')).body).toEqual({ set: false, setAt: null, setBy: null, lastUsedAt: null });
  const set = await manage('PUT', { key: material });
  expect(set.statusCode).toBe(200);
  expect(Object.keys(set.body).sort()).toEqual(['lastUsedAt', 'set', 'setAt', 'setBy']);
  expect(set.body.set).toBe(true);
  expect(set.headers['Cache-Control']).toBe('no-store');
  expect(JSON.stringify(await Key.findOne().lean())).not.toContain(material);
  expect(JSON.stringify(await Secret.findOne().lean())).not.toContain(material);
  expect(JSON.stringify((await Installation.findById(installation._id)).toObject())).not.toContain(material);
  const res = response(); await launchProviderKey(launch(), res);
  expect(res.body).toEqual({ set: true, key: material });
  expect((await manage('GET')).body.lastUsedAt).toBeTruthy();
});
it.each(['child', 'owner', 'machine', 'identity'])('%s cannot resolve another seat key', async (kind) => {
  await manage('PUT', { key: material });
  const req = launch();
  if (kind === 'child') { delete req.machine; req.agentCredential = { scopes: ['spawn'] }; }
  if (kind === 'owner') req.machine.ownerUserId = String(other);
  if (kind === 'machine') req.machine.machineId = 'other';
  if (kind === 'identity') req.body.agentName = 'other';
  const res = response(); await launchProviderKey(req, res);
  expect(res.statusCode).toBe(403);
  expect(JSON.stringify(res.body)).not.toContain(material);
});
it('refuses unconfined, unmapped and hosted setters', async () => {
  for (const runtime of [{ runtimeType: 'wrapper', adapter: 'claude' }, { runtimeType: 'wrapper', adapter: 'codex' }, { runtimeType: 'hosted', adapter: 'hermes' }]) {
    await Installation.updateOne({ _id: installation._id }, { $set: { 'config.runtime': runtime } });
    expect((await manage('PUT', { key: material })).statusCode).toBe(422);
  }
  expect(await Secret.countDocuments()).toBe(0);
});
it('a destination change refuses before resolving or reusing the stored material', async () => {
  await manage('PUT', { key: material });
  await Installation.updateOne({ _id: installation._id }, { $set: { 'config.environment.provider.baseURL': 'https://other.example.com' } });
  const res = response(); await launchProviderKey(launch(), res);
  expect(res.statusCode).toBe(409);
  expect(JSON.stringify(res.body)).not.toContain(material);
  expect((await Key.findOne()).lastUsedAt).toBeNull();
});
it('another installer cannot read/set/remove the key and removal prevents later launch resolution', async () => {
  await manage('PUT', { key: material });
  for (const method of ['GET', 'PUT', 'DELETE']) expect((await manage(method, { key: material }, other)).statusCode).toBe(403);
  expect((await manage('DELETE')).body.set).toBe(false);
  expect(await Secret.countDocuments()).toBe(0);
  const res = response(); await launchProviderKey(launch(), res);
  expect(res.body).toEqual({ set: false });
});
it('a late set cannot undo a remove followed by a newer set', async () => {
  const store = require('../../services/connectorSecrets');
  const original = store.put;
  let reached, release;
  const atWrite = new Promise((resolve) => { reached = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  const spy = jest.spyOn(store, 'put').mockImplementation(async (...args) => {
    const ref = await original(...args);
    if (args[2] === 'older') { reached(); await paused; }
    return ref;
  });
  try {
    const older = manage('PUT', { key: 'older' }); await atWrite;
    await manage('DELETE');
    expect((await manage('PUT', { key: 'newer' })).statusCode).toBe(200);
    release(); expect((await older).statusCode).toBe(409);
    const res = response(); await launchProviderKey(launch(), res);
    expect(res.body.key).toBe('newer');
  } finally { release?.(); spy.mockRestore(); }
});
it('late removal cleanup cannot delete a newer key generation', async () => {
  await manage('PUT', { key: 'initial' });
  const original = Secret.deleteOne.bind(Secret);
  let reached, release;
  const atDelete = new Promise((resolve) => { reached = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  const spy = jest.spyOn(Secret, 'deleteOne').mockImplementation(async (...args) => {
    reached(); await paused; return original(...args);
  });
  try {
    const deleting = manage('DELETE'); await atDelete;
    expect((await manage('PUT', { key: 'newer' })).statusCode).toBe(200);
    release(); await deleting;
    const res = response(); await launchProviderKey(launch(), res);
    expect(res.body.key).toBe('newer');
  } finally { release?.(); spy.mockRestore(); }
});
it('a replacement never exposes its new material under the previous provider binding', async () => {
  await manage('PUT', { key: 'old-provider-key' });
  const store = require('../../services/connectorSecrets'); const original = store.put;
  let reached, release;
  const atWrite = new Promise((resolve) => { reached = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  const spy = jest.spyOn(store, 'put').mockImplementation(async (...args) => {
    const ref = await original(...args); reached(); await paused; return ref;
  });
  try {
    const replacing = manage('PUT', { key: 'new-provider-key' }); await atWrite;
    const during = response(); await launchProviderKey(launch(), during);
    expect(during.body.key).toBe('old-provider-key');
    release(); expect((await replacing).statusCode).toBe(200);
    const after = response(); await launchProviderKey(launch(), after);
    expect(after.body.key).toBe('new-provider-key');
    expect(await Secret.countDocuments()).toBe(1);
  } finally { release?.(); spy.mockRestore(); }
});
it('machine inventory rejects unsupported model/effort/harness choices and permits the explicit unknown-model fallback', async () => {
  const { runtimeControlRefusal } = require('../../services/runtimeControlValidation');
  const inventory = [{ harness: 'opencode', installed: true, models: ['supported'], efforts: ['high'], version: '1' }];
  await Machine.updateOne({ machineId: 'machine-key' }, { $set: { runtimeInventory: inventory, inventoryAt: new Date() } });
  const check = (config) => runtimeControlRefusal({ agentName: 'key-seat', instanceId: 'default', ownerUserId: String(owner), effectiveHarness: 'opencode', config });
  expect(await check({ environment: { model: 'unsupported' } })).toContain('model');
  expect(await check({ environment: { effort: 'max' } })).toContain('effort');
  expect(await check({ runtime: { adapter: 'hermes' } })).toContain('not installed');
  expect(await check({ environment: { model: 'supported', effort: 'high' } })).toBeNull();
  await Machine.updateOne({ machineId: 'machine-key' }, { $set: { runtimeInventory: [{ ...inventory[0], models: null, efforts: [] }] } });
  expect(await check({ environment: { model: 'unknown-model' } })).toBeNull();
  expect(await check({ environment: { effort: 'high' } })).toContain('effort');
  expect(await check({ environment: { effort: '' } })).toBeNull();
});
it.each(['pi', 'qwen', undefined])('inventory does not reject controls for unwalked/legacy adapter %s', async (effectiveHarness) => {
  const { runtimeControlRefusal } = require('../../services/runtimeControlValidation');
  const check = (config) => runtimeControlRefusal({ agentName: 'key-seat', instanceId: 'default',
    ownerUserId: String(owner), effectiveHarness, config });
  for (const reported of [false, true]) {
    await Machine.updateOne({ machineId: 'machine-key' }, { $set: { runtimeInventory: [], inventoryAt: reported ? new Date() : null } });
    expect(await check({ environment: { model: 'custom', effort: 'high' } })).toBeNull();
    expect(await check({ environment: { model: '' } })).toContain('Model must');
    expect(await check({ environment: { model: 5 } })).toContain('Model must');
  }
});
it('own-key capability requires explicit TLS destination and tool confinement', () => {
  const { ownKeyCapability } = require('../../services/agentProviderKey');
  const runtime = { runtimeType: 'wrapper', adapter: 'opencode' };
  const environment = { sandbox: { trust: 'public', mode: 'workspace' }, provider: { id: 'p', baseURL: 'https://api.example.com/v1' } };
  expect(ownKeyCapability(runtime, environment).available).toBe(true);
  for (const baseURL of ['http://api.example.com/v1','https://user:pass@api.example.com/v1','https://api.example.com/v1?key=hidden']) {
    expect(ownKeyCapability(runtime, { ...environment, provider: { id: 'p', baseURL } }).available).toBe(false);
  }
  expect(ownKeyCapability(runtime, { ...environment, sandbox: { trust: 'private', mode: 'none' } }).available).toBe(false);
});
it('the real secret sweep keeps a referenced own key and removes an abandoned encrypted generation', async () => {
  await manage('PUT', { key: material });
  const store = require('../../services/connectorSecrets');
  const { AGENT_PROVIDER_KEY } = require('../../services/connectorSecretKinds');
  const abandoned = await store.put(String(new mongoose.Types.ObjectId()), AGENT_PROVIDER_KEY, 'abandoned');
  const { sweep } = require('../../services/installable/installableReconciler');
  const result = await sweep(new Date(Date.now() + 11 * 60_000));
  expect(result.orphanedSecrets).toBe(1);
  expect(await Secret.findById(abandoned)).toBeNull();
  const res = response(); await launchProviderKey(launch(), res);
  expect(res.body.key).toBe(material);
});
it('real HTTP auth separates owner metadata, daemon resolution and fallback seat refusal, spawn children and revocation', async () => {
  const express = require('express'); const request = require('supertest'); const jwt = require('jsonwebtoken');
  const Credential = require('../../models/AgentCredential');
  const { issueDaemonCredential } = require('../../services/daemonCredentialService');
  const { issueRuntimeTokenForAgent } = require('../../routes/registry/tokens');
  const { mintSpawnCredential } = require('../../services/spawnCredentialService');
  const { hash } = require('../../utils/secret');
  process.env.JWT_SECRET = 'own-key-http-fixture';
  await User.create({ _id: owner, username: 'http-key-owner', email: 'http-key-owner@test.invalid', password: 'password123' });
  const daemon = await issueDaemonCredential({ ownerUserId: owner, machineId: 'machine-key', name: 'test' });
  const issued = await issueRuntimeTokenForAgent(bot, 'fixture', null, {
    ownerUserId: owner, machineId: 'machine-key', parentId: daemon.credential._id,
  });
  const root = await Credential.findOne({ tokenHash: hash(issued.token) });
  const child = await mintSpawnCredential({ seat: root, agentUserId: bot._id, spawnId: 'test' });
  expect(child.ok).toBe(true);
  const app = express(); app.use(express.json());
  app.use('/api/registry', require('../../routes/registry/provider-key'));
  app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
  const ownerToken = jwt.sign({ id: String(owner) }, process.env.JWT_SECRET);
  const url = '/api/registry/agents/key-seat/provider-key?instanceId=default';
  const saved = await request(app).put(url).set('Authorization', `Bearer ${ownerToken}`).send({ key: material });
  expect(saved.status).toBe(200);
  expect(Object.keys(saved.body).sort()).toEqual(['lastUsedAt','set','setAt','setBy']);
  expect(JSON.stringify(saved.body)).not.toContain(material);
  const body = launch().body;
  const metadataOnly = await request(app).post('/api/agents/runtime/provider-key/launch').set('Authorization', `Bearer ${daemon.token}`)
    .send({ ...body, metadataOnly: true });
  expect(metadataOnly.body).toEqual({ set: true });
  expect((await Key.findOne()).lastUsedAt).toBeNull();
  const resolved = await request(app).post('/api/agents/runtime/provider-key/launch').set('Authorization', `Bearer ${daemon.token}`).send(body);
  expect({ status: resolved.status, body: resolved.status === 200 ? null : resolved.body }).toEqual({ status: 200, body: null }); expect(resolved.body.key).toBe(material);
  const refused = await request(app).post('/api/agents/runtime/provider-key/launch').set('Authorization', `Bearer ${child.token}`).send(body);
  expect(refused.status).toBe(401); expect(JSON.stringify(refused.body)).not.toContain(material);
  const fallbackChild = await request(app).post('/api/agents/runtime/provider-key/launch').set('Authorization', `Bearer ${issued.token}`).send(body);
  expect(fallbackChild.status).toBe(401); expect(JSON.stringify(fallbackChild.body)).not.toContain(material);
  const observed = await request(app).post('/api/agents/runtime/observation').set('Authorization', `Bearer ${daemon.token}`)
    .send({ agentName: 'key-seat', instanceId: 'default', event: 'spawn', harness: 'opencode', version: '1.19.0', model: 'test-provider/m', effort: null });
  expect(observed.status).toBe(200);
  const forged = await request(app).post('/api/agents/runtime/observation').set('Authorization', `Bearer ${child.token}`)
    .send({ agentName: 'key-seat', instanceId: 'default', event: 'spawn', harness: 'opencode', version: '1.19.0', model: 'forged', effort: null });
  const fallbackReceipt = await request(app).post('/api/agents/runtime/observation').set('Authorization', `Bearer ${issued.token}`)
    .send({ agentName: 'key-seat', event: 'connected' });
  expect(fallbackReceipt.status).toBe(401);
  expect(forged.status).toBe(401);
  await Credential.revokeCascade(daemon.credential._id);
  const revoked = await request(app).post('/api/agents/runtime/provider-key/launch').set('Authorization', `Bearer ${daemon.token}`).send(body);
  expect(revoked.status).toBe(401); expect(JSON.stringify(revoked.body)).not.toContain(material);
});
