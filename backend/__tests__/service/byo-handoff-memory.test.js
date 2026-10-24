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
const { AgentInstallation } = require('../../models/AgentRegistry');
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
    const app = express(); app.use(express.json());
    app.use('/api/agent-memory', ownerRoutes);
    app.use('/api/agents/runtime', runtimeRoutes);
    server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); await closeMongoDb(); });
  beforeEach(async () => {
    await AgentMemory.deleteMany({}); await AgentInstallation.deleteMany({});
    for (const agentName of ['hosted-handoff', 'local-handoff']) {
      await AgentInstallation.create({ agentName, instanceId: 'default', podId: pod._id, version: '1', installedBy: owner._id });
    }
    await appendLongTermMemory({ agentName: 'hosted-handoff', instanceId: 'default', content: 'remember-X-468' });
  });
  const runCopy = async (actor, extra = '') => {
    const cliRoot = path.resolve(__dirname, '../../../cli/src/lib');
    const script = `
      import {copyHandoffMemory} from ${JSON.stringify(pathToFileURL(path.join(cliRoot, 'handoff-memory.js')).href)};
      import {readLongTerm,buildMemoryPreamble} from ${JSON.stringify(pathToFileURL(path.join(cliRoot, 'memory-bridge.js')).href)};
      import {createClient} from ${JSON.stringify(pathToFileURL(path.join(cliRoot, 'api.js')).href)};
      const client=createClient({instance:process.env.TEST_BASE,token:process.env.TEST_OWNER_TOKEN});
      ${extra}
      const result=await copyHandoffMemory(client,{sourceAgentName:'hosted-handoff',targetAgentName:'local-handoff'});
      const runtime=createClient({instance:process.env.TEST_BASE,token:process.env.TEST_RUNTIME_TOKEN});
      const memory=await readLongTerm(runtime);
      console.log(JSON.stringify({result,preamble:buildMemoryPreamble('first local turn',memory,{freshSession:true})}));`;
    return execute(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env,
      TEST_BASE: base, TEST_OWNER_TOKEN: jwt.sign({ id: String(actor._id) }, SECRET), TEST_RUNTIME_TOKEN: RAW_TOKEN } });
  };
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
  it('a concurrent write between target read and copy wins', async () => {
    const extra = `const patch=client.patch;client.patch=async (...args)=>{await patch(args[0],{content:'concurrent local note',expectedUpdatedAt:null});return patch(...args);};`;
    await expect(runCopy(owner, extra)).rejects.toThrow();
    expect((await AgentMemory.findOne({ agentName: 'local-handoff' }).lean()).content).toBe('concurrent local note');
  });
});
