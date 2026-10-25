const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { promisify } = require('util');
const { execFile } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentMemory = require('../../models/AgentMemory');
const AgentCredential = require('../../models/AgentCredential');
const AgentMessageService = require('../../services/agentMessageService');
const { AgentInstallation, AgentRegistry } = require('../../models/AgentRegistry');
const registryRoutes = require('../../routes/registry');
const { appendLongTermMemory } = require('../../services/agentMemoryService');
const { hash } = require('../../utils/secret');
const ownerRoutes = require('../../routes/agentMemoryView');
const runtimeRoutes = require('../../routes/agentsRuntime');
const execute = promisify(execFile);
const SECRET = 'handoff-memory-test';
const RAW_TOKEN = 'cm_agent_handoff_local_test';
jest.setTimeout(60000);

describe('hosted memory copied into a local agent', () => {
  let owner; let outsider; let pod; let server; let base;
  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    owner = await User.create({ username: 'handoff-owner', email: 'handoff-owner@test.com', password: 'password123' });
    outsider = await User.create({ username: 'handoff-outsider', email: 'handoff-outsider@test.com', password: 'password123' });
    pod = await Pod.create({ name: 'Handoff test', type: 'chat', createdBy: owner._id, members: [owner._id, outsider._id] });
    await User.create({ username: 'local-handoff', email: 'local-handoff@test.com', password: 'password123', isBot: true,
      botType: 'agent', botMetadata: { agentName: 'local-handoff', instanceId: 'default', ownerUserId: owner._id },
      agentRuntimeTokens: [{ tokenHash: hash(RAW_TOKEN), label: 'test', createdAt: new Date() }] });
    await AgentRegistry.create({ agentName: 'local-handoff', displayName: 'local-handoff', description: 'Handoff fixture',
      manifest: { name: 'local-handoff', version: '1.0.0', context: { required: [] } },
      latestVersion: '1.0.0', registry: 'private', publisher: { userId: owner._id, name: owner.username } });
    const app = express(); app.use(express.json());
    app.use('/api/agent-memory', ownerRoutes);
    app.use('/api/agents/runtime', runtimeRoutes);
    app.use('/api/registry', registryRoutes);
    server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { if (server) await new Promise((resolve) => server.close(resolve)); await closeMongoDb(); });
  beforeEach(async () => {
    await AgentMemory.deleteMany({}); await AgentInstallation.deleteMany({});
    await AgentCredential.deleteMany({ tokenHash: hash(RAW_TOKEN) });
    await User.updateOne({ username: 'local-handoff' }, { $set: { agentRuntimeTokens: [{ tokenHash: hash(RAW_TOKEN), label: 'test', createdAt: new Date() }] } });
    for (const agentName of ['hosted-handoff', 'local-handoff']) {
      await AgentInstallation.create({ agentName, instanceId: 'default', podId: pod._id, version: '1', installedBy: owner._id,
        config: agentName === 'local-handoff' ? { runtime: { host: 'byo', runtimeType: 'stub', adapter: 'stub' } } : {} });
    }
    await appendLongTermMemory({ agentName: 'hosted-handoff', instanceId: 'default', content: 'remember-X-468' });
  });
  const runCopy = async (actor, extra = '') => {
    const cliRoot = path.resolve(__dirname, '../../../cli/src/lib');
    const script = `
      import {copyOwnerMemory} from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, '../utils/memoryOwnerCopy.mjs')).href)};
      import {readLongTerm,buildMemoryPreamble} from ${JSON.stringify(pathToFileURL(path.join(cliRoot, 'memory-bridge.js')).href)};
      import {createClient} from ${JSON.stringify(pathToFileURL(path.join(cliRoot, 'api.js')).href)};
      const client=createClient({instance:process.env.TEST_BASE,token:process.env.TEST_OWNER_TOKEN});
      ${extra}
      const result=await copyOwnerMemory(client,{sourceAgentName:'hosted-handoff',targetAgentName:'local-handoff'});
      const runtime=createClient({instance:process.env.TEST_BASE,token:process.env.TEST_RUNTIME_TOKEN});
      const memory=await readLongTerm(runtime);
      console.log(JSON.stringify({result,preamble:buildMemoryPreamble('first local turn',memory,{freshSession:true})}));`;
    return execute(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env,
      TEST_BASE: base, TEST_OWNER_TOKEN: jwt.sign({ id: String(actor._id) }, SECRET), TEST_RUNTIME_TOKEN: RAW_TOKEN } });
  };
  const runAttach = () => {
    const cliRoot = path.resolve(__dirname, '../../../cli/src');
    const script = `
      import {performAttach} from ${JSON.stringify(pathToFileURL(path.join(cliRoot, 'commands/agent.js')).href)};
      import {createClient} from ${JSON.stringify(pathToFileURL(path.join(cliRoot, 'lib/api.js')).href)};
      const client=createClient({instance:process.env.TEST_BASE,token:process.env.TEST_OWNER_TOKEN});
      const get=client.get;client.get=(route)=>route.startsWith('/api/pods/')?Promise.resolve({publicRead:false,communityListed:false}):get(route);
      await performAttach({client,adapterName:'stub',agentName:'local-handoff',podId:process.env.TEST_POD,
        memoryFrom:'hosted-handoff',adapterRegistry:{getAdapter:()=>({name:'stub',runtimeType:'stub',detect:async()=>({version:'1'})}),listAdapterNames:()=>['stub']}});`;
    return execute(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env,
      TEST_BASE: base, TEST_POD: String(pod._id), TEST_OWNER_TOKEN: jwt.sign({ id: String(owner._id) }, SECRET) } });
  };
  const attach = (actor = owner, memoryFrom = { agentName: 'hosted-handoff', instanceId: 'default' }) => request(base)
    .post('/api/registry/install')
    .set('Authorization', `Bearer ${jwt.sign({ id: String(actor._id) }, SECRET)}`)
    .send({ agentName: 'local-handoff', podId: String(pod._id), resumeExisting: true, memoryFrom,
      config: { runtime: { host: 'byo', runtimeType: 'stub', adapter: 'stub' } }, scopes: [] });

  it.each([
    { memoryFrom: null },
    { memoryFrom: {} },
    { memoryFrom: { agentName: 'hosted-handoff' } },
    { memoryFrom: { agentName: { $ne: null }, instanceId: 'default' } },
    { runtime: { host: 'cloud', runtimeType: 'stub', adapter: 'stub' } },
    { runtime: { host: 'byo', runtimeType: 'stub' } },
  ])('refuses malformed or unsupported handoff before effects: %j', async (override) => {
    await AgentInstallation.deleteOne({ agentName: 'local-handoff' });
    const result = await request(base).post('/api/registry/install')
      .set('Authorization', `Bearer ${jwt.sign({ id: String(owner._id) }, SECRET)}`)
      .send({ agentName: 'local-handoff', podId: String(pod._id),
        memoryFrom: { agentName: 'hosted-handoff', instanceId: 'default' },
        ...('memoryFrom' in override ? { memoryFrom: override.memoryFrom } : {}),
        config: { runtime: override.runtime || { host: 'byo', runtimeType: 'stub', adapter: 'stub' } } });
    expect(result.status).toBe(400);
    expect(await AgentInstallation.countDocuments({ agentName: 'local-handoff' })).toBe(0);
    expect(await AgentMemory.findOne({ agentName: 'local-handoff' })).toBeNull();
  });

  it('refuses a fresh target whose registry publisher is someone else', async () => {
    await AgentInstallation.deleteOne({ agentName: 'local-handoff' });
    await AgentRegistry.updateOne({ agentName: 'local-handoff' }, { $set: { 'publisher.userId': outsider._id } });
    try {
      const result = await attach();
      expect(result.status).toBe(403);
      expect(result.body.error).toMatch(/ownership of the source and target/);
      expect(await AgentInstallation.countDocuments({ agentName: 'local-handoff' })).toBe(0);
      expect(await AgentMemory.findOne({ agentName: 'local-handoff' })).toBeNull();
    } finally {
      await AgentRegistry.updateOne({ agentName: 'local-handoff' }, { $set: { 'publisher.userId': owner._id } });
    }
  });

  it('does not expose the capability to an unauthenticated request', async () => {
    const result = await request(base).get('/api/registry/install/memory-handoff');
    expect(result.status).toBe(401);
    expect(result.body.installTimeMemoryHandoff).not.toBe(true);
  });

  it('a refused self-serve handoff creates no registry row', async () => {
    const name = 'refused-selfserve-handoff';
    await AgentMemory.create({ agentName: name, instanceId: 'default', content: 'independent local memory' });
    const result = await request(base).post('/api/registry/install')
      .set('Authorization', `Bearer ${jwt.sign({ id: String(owner._id) }, SECRET)}`)
      .send({ agentName: name, podId: String(pod._id), memoryFrom: { agentName: 'hosted-handoff', instanceId: 'default' },
        config: { runtime: { host: 'byo', runtimeType: 'wrapper', adapter: 'stub' } } });
    expect(result.status).toBe(409);
    expect(await AgentRegistry.countDocuments({ agentName: name })).toBe(0);
    expect(await AgentInstallation.countDocuments({ agentName: name })).toBe(0);
  });

  it('persists a new self-serve registry only after a successful handoff', async () => {
    const name = 'fresh-selfserve-handoff';
    jest.spyOn(AgentMessageService, 'postMessage').mockResolvedValue({ id: 'fixture-greeting' });
    const result = await request(base).post('/api/registry/install')
      .set('Authorization', `Bearer ${jwt.sign({ id: String(owner._id) }, SECRET)}`)
      .send({ agentName: name, podId: String(pod._id), memoryFrom: { agentName: 'hosted-handoff', instanceId: 'default' },
        config: { runtime: { host: 'byo', runtimeType: 'wrapper', adapter: 'stub' } } });
    expect(result.status).toBe(200);
    expect(result.body.memoryCopy.copied).toBe(true);
    expect(await AgentRegistry.countDocuments({ agentName: name })).toBe(1);
    expect(await AgentInstallation.countDocuments({ agentName: name })).toBe(1);
    expect((await AgentMemory.findOne({ agentName: name }).lean()).content).toContain('remember-X-468');
  });

  it('records the residual memory when a real human username blocks identity creation', async () => {
    const name = 'identity-refusal-handoff';
    await User.create({ username: name, email: `${name}@test.com`, password: 'password123' });
    await AgentRegistry.create({ agentName: name, displayName: name, description: 'Identity refusal fixture',
      manifest: { name, version: '1.0.0', context: { required: [] } },
      latestVersion: '1.0.0', registry: 'private', publisher: { userId: owner._id, name: owner.username } });
    const post = jest.spyOn(AgentMessageService, 'postMessage');
    const result = await request(base).post('/api/registry/install')
      .set('Authorization', `Bearer ${jwt.sign({ id: String(owner._id) }, SECRET)}`)
      .send({ agentName: name, podId: String(pod._id), memoryFrom: { agentName: 'hosted-handoff', instanceId: 'default' },
        config: { runtime: { host: 'byo', runtimeType: 'stub', adapter: 'stub' } } });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('agent_username_conflict');
    expect(await AgentInstallation.countDocuments({ agentName: name })).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect((await AgentMemory.findOne({ agentName: name }).lean()).content).toContain('remember-X-468');
    expect((await User.findOne({ username: name }).lean()).isBot).toBe(false);
  });

  it('a memory collision leaves no installation, pod join or greeting', async () => {
    await AgentInstallation.deleteOne({ agentName: 'local-handoff' });
    await appendLongTermMemory({ agentName: 'local-handoff', instanceId: 'default', content: 'local note' });
    const post = jest.spyOn(AgentMessageService, 'postMessage');
    const members = (await Pod.findById(pod._id).lean()).members;
    const refusal = await runAttach().catch((error) => error);
    expect(await AgentInstallation.countDocuments({ agentName: 'local-handoff' })).toBe(0);
    expect((await Pod.findById(pod._id).lean()).members).toEqual(members);
    expect(post).not.toHaveBeenCalled();
    expect(refusal.message).toMatch(/different memory/);
    expect((await AgentMemory.findOne({ agentName: 'local-handoff' }).lean()).content).toContain('local note');
  });

  it('foreign source authorization fails before installation or greeting', async () => {
    await AgentInstallation.deleteOne({ agentName: 'local-handoff' });
    await AgentInstallation.updateOne({ agentName: 'hosted-handoff' }, { $set: { installedBy: outsider._id } });
    const post = jest.spyOn(AgentMessageService, 'postMessage');
    expect((await attach()).status).toBe(403);
    expect(await AgentInstallation.countDocuments({ agentName: 'local-handoff' })).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect(await AgentMemory.findOne({ agentName: 'local-handoff' })).toBeNull();
  });

  it('a concurrent local memory write wins before any installation or greeting', async () => {
    await AgentInstallation.deleteOne({ agentName: 'local-handoff' });
    await AgentMemory.create({ agentName: 'local-handoff', instanceId: 'default', content: '' });
    const update = AgentMemory.findOneAndUpdate.bind(AgentMemory);
    jest.spyOn(AgentMemory, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
      await AgentMemory.updateOne({ agentName: 'local-handoff' }, { $set: { content: 'late note' } });
      return update(...args);
    });
    const post = jest.spyOn(AgentMessageService, 'postMessage');
    expect((await attach()).status).toBe(409);
    expect(await AgentInstallation.countDocuments({ agentName: 'local-handoff' })).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect((await AgentMemory.findOne({ agentName: 'local-handoff' }).lean()).content).toBe('late note');
  });

  it.each([
    { visibility: 'pod', content: '' },
    { visibility: 'private', content: 'independent note' },
  ])('install refuses unsafe target memory: %j', async (section) => {
    await AgentInstallation.deleteOne({ agentName: 'local-handoff' });
    await AgentMemory.create({ agentName: 'local-handoff', instanceId: 'default', sections: { long_term: section } });
    const post = jest.spyOn(AgentMessageService, 'postMessage');
    expect((await attach()).status).toBe(409);
    expect(await AgentInstallation.countDocuments({ agentName: 'local-handoff' })).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it('does not put hosted memory into a foreign principal behind an owned registry', async () => {
    await AgentInstallation.deleteOne({ agentName: 'local-handoff' });
    await User.updateOne({ username: 'local-handoff' }, { $set: { 'botMetadata.ownerUserId': outsider._id } });
    try {
      expect((await attach()).status).toBe(403);
      expect(await AgentMemory.findOne({ agentName: 'local-handoff' })).toBeNull();
      expect(await AgentInstallation.countDocuments({ agentName: 'local-handoff' })).toBe(0);
    } finally {
      await User.updateOne({ username: 'local-handoff' }, { $set: { 'botMetadata.ownerUserId': owner._id } });
    }
  });

  it('handoff checks all source owners, even while resuming an existing install', async () => {
    const otherPod = await Pod.create({ name: 'Other owner', type: 'chat', createdBy: outsider._id });
    await AgentInstallation.create({ agentName: 'hosted-handoff', instanceId: 'default', podId: otherPod._id,
      version: '1', installedBy: outsider._id });
    expect((await attach()).status).toBe(403);
    expect(await AgentMemory.findOne({ agentName: 'local-handoff' })).toBeNull();
  });

  it('a new installation receives copied memory before its greeting', async () => {
    await AgentInstallation.deleteOne({ agentName: 'local-handoff' });
    const post = jest.spyOn(AgentMessageService, 'postMessage').mockImplementation(async () => {
      expect((await AgentMemory.findOne({ agentName: 'local-handoff' }).lean()).content).toContain('remember-X-468');
      return { id: 'fixture-greeting' };
    });
    const result = await attach();
    expect(result.status).toBe(200);
    expect(result.body.memoryCopy.copied).toBe(true);
    expect(await AgentInstallation.countDocuments({ agentName: 'local-handoff' })).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('an existing BYO handoff resumes with memory copied and retries idempotently', async () => {
    const post = jest.spyOn(AgentMessageService, 'postMessage');
    const first = await attach();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ resumed: true, memoryCopy: { copied: true } });
    expect((await AgentMemory.findOne({ agentName: 'local-handoff' }).lean()).content).toContain('remember-X-468');
    expect((await attach()).body.memoryCopy.reason).toBe('already-copied');
    expect(post).not.toHaveBeenCalled();
  });

  it('a hosted atomic write reaches the first local turn via owner HTTP copy, real Mongo, and runtime HTTP read', async () => {
    const output = JSON.parse((await runCopy(owner)).stdout);
    expect(output.result.copied).toBe(true);
    expect(output.preamble).toContain('remember-X-468');
    expect(output.preamble.indexOf('remember-X-468')).toBeLessThan(output.preamble.indexOf('first local turn'));
    const repeat = JSON.parse((await runCopy(owner)).stdout);
    expect(repeat.result.reason).toBe('already-copied');
  });
  it('copies hosted memory larger than the editor write limit without truncation', async () => {
    const large = '记住'.repeat(12000);
    await appendLongTermMemory({ agentName: 'hosted-handoff', instanceId: 'default', content: large });
    const output = JSON.parse((await runCopy(owner)).stdout);
    expect(output.result.copied).toBe(true);
    const source = await AgentMemory.findOne({ agentName: 'hosted-handoff' }).lean();
    const target = await AgentMemory.findOne({ agentName: 'local-handoff' }).lean();
    expect(Buffer.byteLength(source.content)).toBeGreaterThan(64 * 1024);
    expect(target.sections.long_term.content).toBe(source.sections.long_term.content);
    expect(output.preamble).toContain(large);
  });
  it('the server independently refuses foreign source copy and nonempty targets', async () => {
    await AgentInstallation.updateOne({ agentName: 'hosted-handoff' }, { $set: { installedBy: outsider._id } });
    const auth = `Bearer ${jwt.sign({ id: String(owner._id) }, SECRET)}`;
    const foreign = await request(base).patch('/api/agent-memory/local-handoff/default/editable/long_term')
      .set('Authorization', auth).send({ copyFrom: { agentName: 'hosted-handoff', instanceId: 'default' }, expectedUpdatedAt: null });
    expect(foreign.status).toBe(403);
    expect(await AgentMemory.findOne({ agentName: 'local-handoff' })).toBeNull();
    await AgentInstallation.updateOne({ agentName: 'hosted-handoff' }, { $set: { installedBy: owner._id } });
    await appendLongTermMemory({ agentName: 'local-handoff', instanceId: 'default', content: 'independent' });
    const denied = await request(base).patch('/api/agent-memory/local-handoff/default/editable/long_term')
      .set('Authorization', auth).send({ copyFrom: { agentName: 'hosted-handoff', instanceId: 'default' }, expectedUpdatedAt: null });
    expect(denied.status).toBe(409);
    expect((await AgentMemory.findOne({ agentName: 'local-handoff' }).lean()).content).toContain('independent');
  });
  it('actual CLI attach leaves no partial install after refusal and can retry', async () => {
    const cliRoot = path.resolve(__dirname, '../../../cli/src');
    const script = `
      import {performAttach} from ${JSON.stringify(pathToFileURL(path.join(cliRoot, 'commands/agent.js')).href)};
      import {createClient} from ${JSON.stringify(pathToFileURL(path.join(cliRoot, 'lib/api.js')).href)};
      import {readLongTerm,buildMemoryPreamble} from ${JSON.stringify(pathToFileURL(path.join(cliRoot, 'lib/memory-bridge.js')).href)};
      const client=createClient({instance:process.env.TEST_BASE,token:process.env.TEST_OWNER_TOKEN});
      const result=await performAttach({client,adapterName:'stub',agentName:'local-handoff',podId:process.env.TEST_POD,memoryFrom:'hosted-handoff'});
      const runtime=createClient({instance:process.env.TEST_BASE,token:result.runtimeToken});
      console.log(JSON.stringify({preamble:buildMemoryPreamble('first local turn',await readLongTerm(runtime))}));`;
    const invoke = () => execute(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env,
      TEST_BASE: base, TEST_POD: String(pod._id), TEST_OWNER_TOKEN: jwt.sign({ id: String(owner._id) }, SECRET) } });
    await AgentInstallation.deleteOne({ agentName: 'local-handoff' });
    await AgentInstallation.updateOne({ agentName: 'hosted-handoff' }, { $set: { installedBy: outsider._id } });
    await expect(invoke()).rejects.toThrow();
    expect(await AgentInstallation.countDocuments({ agentName: 'local-handoff', status: 'active' })).toBe(0);
    await AgentInstallation.updateOne({ agentName: 'hosted-handoff' }, { $set: { installedBy: owner._id } });
    const output = JSON.parse((await invoke()).stdout);
    expect(output.preamble).toContain('remember-X-468');
    expect(await AgentInstallation.countDocuments({ agentName: 'local-handoff', status: 'active' })).toBe(1);
  });
  it('resume does not adopt a foreign installation or change the runtime binding', async () => {
    const body = { agentName: 'local-handoff', podId: String(pod._id), resumeExisting: true,
      config: { runtime: { host: 'byo', runtimeType: 'stub', adapter: 'stub' } } };
    const auth = `Bearer ${jwt.sign({ id: String(owner._id) }, SECRET)}`;
    await AgentInstallation.updateOne({ agentName: 'local-handoff' }, { $set: { installedBy: outsider._id } });
    expect((await request(base).post('/api/registry/install').set('Authorization', auth).send(body)).status).toBe(409);
    await AgentInstallation.updateOne({ agentName: 'local-handoff' }, { $set: { installedBy: owner._id } });
    body.config.runtime.adapter = 'codex';
    expect((await request(base).post('/api/registry/install').set('Authorization', auth).send(body)).status).toBe(409);
    const installation = await AgentInstallation.findOne({ agentName: 'local-handoff' }).lean();
    expect(installation.config.runtime.adapter).toBe('stub');
    body.config.runtime.adapter = 'stub'; body.config.runtime.host = 'cloud';
    expect((await request(base).post('/api/registry/install').set('Authorization', auth).send(body)).status).toBe(409);
    body.config.runtime.host = 'byo'; body.resumeExisting = false;
    expect((await request(base).post('/api/registry/install').set('Authorization', auth).send(body)).status).toBe(400);
  });
  it('does not resurrect stale legacy content when canonical source memory is explicitly empty', async () => {
    await AgentMemory.updateOne({ agentName: 'hosted-handoff' }, { $set: {
      content: 'stale legacy secret', 'sections.long_term.content': '',
    } });
    const output = JSON.parse((await runCopy(owner)).stdout);
    expect(output.result.reason).toBe('source-empty');
    expect(output.preamble).not.toContain('stale legacy secret');
    expect(await AgentMemory.findOne({ agentName: 'local-handoff' })).toBeNull();
  });
  it('refuses an empty shared target without leaking the hosted private note', async () => {
    await AgentMemory.create({ agentName: 'local-handoff', instanceId: 'default', sections: {
      long_term: { content: '', visibility: 'pod', updatedAt: new Date(), byteSize: 0 },
    } });
    await expect(runCopy(owner)).rejects.toThrow(/must be private/);
    expect((await AgentMemory.findOne({ agentName: 'local-handoff' }).lean()).sections.long_term.content).toBe('');
  });
  it('refuses an unrelated human even when they belong to the same pod', async () => {
    await expect(runCopy(outsider)).rejects.toThrow();
    expect(await AgentMemory.findOne({ agentName: 'local-handoff' })).toBeNull();
  });
  it('refuses a source with mixed installation ownership', async () => {
    const otherPod = await Pod.create({ name: 'Other owner', type: 'chat', createdBy: outsider._id, members: [outsider._id] });
    await AgentInstallation.create({ agentName: 'hosted-handoff', instanceId: 'default', podId: otherPod._id, version: '1', installedBy: outsider._id });
    await expect(runCopy(owner)).rejects.toThrow();
    expect(await AgentMemory.findOne({ agentName: 'local-handoff' })).toBeNull();
  });
  it('does not overwrite independent target memory', async () => {
    await appendLongTermMemory({ agentName: 'local-handoff', instanceId: 'default', content: 'local-existing' });
    await expect(runCopy(owner)).rejects.toThrow(/different memory/);
    expect((await AgentMemory.findOne({ agentName: 'local-handoff' }).lean()).content).toContain('local-existing');
  });
  it('refuses a stored runtime legacy note even when canonical long-term content is empty', async () => {
    await AgentMemory.create({ agentName: 'local-handoff', instanceId: 'default', content: '', sections: {
      long_term: { content: '', visibility: 'private', updatedAt: new Date(), byteSize: 0 },
    } });
    const written = await request(base).put('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${RAW_TOKEN}`).send({ content: 'existing legacy local note' });
    expect(written.status).toBe(200);
    await expect(runCopy(owner)).rejects.toThrow(/empty private target/);
    const local = await AgentMemory.findOne({ agentName: 'local-handoff' }).lean();
    expect(local.content).toBe('existing legacy local note');
    expect(local.sections.long_term.content).toBe('');
  });
  it('preserves an actual runtime content-only write after server preflight', async () => {
    await AgentMemory.create({ agentName: 'local-handoff', instanceId: 'default', content: '', sections: {
      long_term: { content: '', visibility: 'private', updatedAt: new Date(), byteSize: 0 },
    } });
    const original = AgentMemory.findOneAndUpdate.bind(AgentMemory);
    const save = jest.spyOn(AgentMemory, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
      const lateWrite = await request(base).put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${RAW_TOKEN}`).send({ content: 'late legacy local note' });
      expect(lateWrite.status).toBe(200);
      return original(...args);
    });
    try {
      await expect(runCopy(owner)).rejects.toThrow();
      const local = await AgentMemory.findOne({ agentName: 'local-handoff' }).lean();
      expect(local.content).toBe('late legacy local note');
      expect(local.sections.long_term.content).toBe('');
    } finally { save.mockRestore(); }
  });
  it('a concurrent write between target read and copy wins', async () => {
    const extra = `const patch=client.patch;client.patch=async (...args)=>{await patch(args[0],{content:'concurrent local note',expectedUpdatedAt:null});return patch(...args);};`;
    await expect(runCopy(owner, extra)).rejects.toThrow();
    expect((await AgentMemory.findOne({ agentName: 'local-handoff' }).lean()).content).toBe('concurrent local note');
  });
});
