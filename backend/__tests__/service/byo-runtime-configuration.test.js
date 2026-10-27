const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { promisify } = require('util');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentCredential = require('../../models/AgentCredential');
const { AgentInstallation } = require('../../models/AgentRegistry');
const tokenRoutes = require('../../routes/registry/agent-tokens');
const runtimeRoutes = require('../../routes/agentsRuntime');
const { hash } = require('../../utils/secret');
const execute = promisify(execFile);
const SECRET = 'byo-model-owner-test';

describe('page-issued key model configuration', () => {
  let owner; let other; let pod; let ownInstall; let foreignInstall; let key; let server; let base;
  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    owner = await User.create({ username: 'byo-config-owner', email: 'config-owner@test.com', password: 'password123' });
    other = await User.create({ username: 'byo-config-other', email: 'config-other@test.com', password: 'password123' });
    pod = await Pod.create({ name: 'BYO configuration', type: 'chat', createdBy: owner._id, members: [owner._id, other._id] });
    const app = express(); app.use(express.json());
    app.use('/api/registry', tokenRoutes); app.use('/api/agents/runtime', runtimeRoutes);
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); await closeMongoDb(); });
  beforeEach(async () => {
    await AgentInstallation.deleteMany({}); await AgentCredential.deleteMany({});
    await User.deleteMany({ isBot: true });
    ownInstall = await AgentInstallation.create({ agentName: 'byo-config', instanceId: 'default', podId: pod._id,
      version: '1', installedBy: owner._id, config: { runtime: { runtimeType: 'webhook', host: 'byo' },
        environment: { model: 'old-model', sandbox: { trust: 'public', mode: 'workspace' } } } });
    foreignInstall = await AgentInstallation.create({ agentName: 'foreign-config', instanceId: 'default', podId: pod._id,
      version: '1', installedBy: other._id, config: { runtime: { runtimeType: 'webhook', host: 'byo' }, environment: { model: 'foreign-model' } } });
    const minted = await request(base).post(`/api/registry/pods/${pod._id}/agents/byo-config/runtime-tokens`)
      .set('Authorization', `Bearer ${jwt.sign({ id: String(owner._id) }, SECRET)}`).send({ instanceId: 'default' });
    expect(minted.status).toBe(200);
    key = minted.body.token;
    expect(key).toMatch(/^cm_agent_/);
  });
  const patch = (body, bearer = key) => request(base).patch('/api/agents/runtime/configuration')
    .set('Authorization', `Bearer ${bearer}`).send({ agentName: 'byo-config', instanceId: 'default', ...body });
  const stored = async (row) => (await AgentInstallation.findById(row._id).lean()).config;
  const command = async (agentName = 'byo-config', extra = []) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-config-cli-'));
    try {
      fs.mkdirSync(path.join(home, '.commonly/tokens'), { recursive: true });
      const file = path.join(home, '.commonly/tokens/local.json');
      fs.writeFileSync(file, JSON.stringify({ agentName, instanceId: 'default', instanceUrl: base,
        runtimeToken: key, podId: String(pod._id), environment: { sandbox: { trust: 'public', mode: 'workspace' }, model: 'old-model' } }));
      const env = { ...process.env, HOME: home };
      delete env.COMMONLY_TOKEN; delete env.COMMONLY_AGENT_TOKEN;
      const result = await execute(process.execPath, [path.resolve(__dirname, '../../../cli/src/index.js'),
        'agent', 'config', 'local', '--model', 'new-model', '--effort', 'high', ...extra], { env });
      return { ...result, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  };
  it('runs the actual CLI with only the page key, saving server controls and the local next-run declaration', async () => {
    const result = await command();
    expect(result.stdout).toContain('Updated byo-config');
    expect(result.record.environment).toEqual({ model: 'new-model', effort: 'high', sandbox: { trust: 'public', mode: 'workspace' } });
    expect(await stored(ownInstall)).toMatchObject({ environment: result.record.environment, runtime: { model: 'new-model', effort: 'high', host: 'byo' } });
    expect((await stored(foreignInstall)).environment.model).toBe('foreign-model');
  });
  it('refuses using that key for another user even when the local token record names their agent', async () => {
    await expect(command('foreign-config')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Key does not belong') });
    expect((await stored(foreignInstall)).environment.model).toBe('foreign-model');
    expect((await stored(ownInstall)).environment.model).toBe('old-model');
  });
  it('never sends a request or the page key to a mismatched --instance', async () => {
    const received = [];
    const app = express();
    app.use((req, res) => { received.push(req.headers.authorization); res.json({ podId: 'wrong-instance' }); });
    const foreign = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      await expect(command('byo-config', ['--instance', `http://127.0.0.1:${foreign.address().port}`]))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('requires an owner login') });
      expect(received).toEqual([]);
      expect((await stored(ownInstall)).environment.model).toBe('old-model');
    } finally { await new Promise((resolve) => foreign.close(resolve)); }
  });
  it('accepts an explicit matching instance URL with a trailing slash', async () => {
    expect((await command('byo-config', ['--instance', `${base}/`])).stdout).toContain('Updated byo-config');
  });
  it.each([
    { instanceId: 'other' }, { environment: { mcp: [{ command: ['sh'] }] } },
    { adapter: 'claude' }, { model: '' }, { effort: 'ultra' },
  ])('refuses broader or invalid controls: %j', async (body) => {
    expect((await patch({ model: 'new-model', ...body })).status).toBeGreaterThanOrEqual(400);
    expect((await stored(ownInstall)).environment.model).toBe('old-model');
  });
  it('refuses a credential whose owner no longer owns the installation', async () => {
    await AgentInstallation.updateOne({ _id: ownInstall._id }, { $set: { installedBy: other._id } });
    expect((await patch({ model: 'new-model' })).status).toBe(403);
    expect((await stored(ownInstall)).environment.model).toBe('old-model');
  });
  it('refuses a shared identity with another installer', async () => {
    const anotherPod = await Pod.create({ name: 'Other config pod', createdBy: other._id, members: [other._id] });
    await AgentInstallation.create({ agentName: 'byo-config', instanceId: 'default', podId: anotherPod._id,
      version: '1', installedBy: other._id, config: { runtime: { host: 'byo' } } });
    expect((await patch({ model: 'new-model' })).status).toBe(403);
  });
  it('refuses model-turn spawn keys', async () => {
    const root = await AgentCredential.findOne({ tokenHash: hash(key) });
    const childKey = 'cm_agent_config_child';
    await AgentCredential.create({ tokenHash: hash(childKey), kind: 'runtime', ownerUserId: owner._id,
      agentUserId: root.agentUserId, parentId: root._id, scopes: ['spawn'] });
    expect((await patch({ model: 'new-model' }, childKey)).status).toBe(403);
  });
  it('refuses spawn scope independently of parent lineage', async () => {
    await AgentCredential.updateOne({ tokenHash: hash(key) }, { $set: { scopes: ['spawn'], parentId: null } });
    expect((await patch({ model: 'new-model' })).status).toBe(403);
    expect((await stored(ownInstall)).environment.model).toBe('old-model');
  });
  it.each(['native', 'hosted'])('refuses hosted controls even with a stale BYO host: %s', async (runtimeType) => {
    await AgentInstallation.updateOne({ _id: ownInstall._id }, { $set: { 'config.runtime.runtimeType': runtimeType } });
    expect((await patch({ model: 'new-model' })).status).toBe(403);
  });
  it('refuses machine-managed identities', async () => {
    await User.updateOne({ 'agentRuntimeTokens.tokenHash': hash(key) }, { $set: { 'botMetadata.machineId': 'machine-config' } });
    expect((await patch({ model: 'new-model' })).status).toBe(403);
  });
  it('requires owner login for adapter edits', async () => {
    await expect(command('byo-config', ['--adapter', 'claude'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Not logged in') });
  });
});
