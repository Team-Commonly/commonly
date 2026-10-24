const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentProfile = require('../../models/AgentProfile');
const { AgentInstallation } = require('../../models/AgentRegistry');
const agentConfig = require('../../routes/registry/agent-config');
const podAgents = require('../../routes/registry/pod-agents');

const SECRET = 'agent-policy-settings-test';
const token = (user) => jwt.sign({ id: String(user._id) }, SECRET);

describe('per-agent policy settings', () => {
  let app; let owner; let outsider; let pod; let url;

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', agentConfig);
    app.use('/api/registry', podAgents);
    owner = await User.create({ username: 'policy-owner', email: 'policy-owner@test.com', password: 'password123' });
    outsider = await User.create({ username: 'policy-outsider', email: 'policy-outsider@test.com', password: 'password123' });
    pod = await Pod.create({ name: 'Policy pod', type: 'chat', createdBy: owner._id, members: [owner._id, outsider._id] });
    url = `/api/registry/pods/${pod._id}/agents/policy-agent`;
  });

  afterAll(async () => closeMongoDb());

  beforeEach(async () => {
    await AgentInstallation.deleteMany({ agentName: 'policy-agent' });
    await AgentProfile.deleteMany({ agentName: 'policy-agent' });
    await AgentInstallation.create({ agentName: 'policy-agent', instanceId: 'machine-1',
      podId: pod._id, version: '1', installedBy: owner._id,
      config: new Map([['runtime', { runtimeType: 'wrapper', adapter: 'claude' }],
        ['environment', { adapter: 'claude', workspace: { path: '/repo' },
          sandbox: { mode: 'read-only', network: { policy: 'restricted' } },
          mcp: [{ name: 'safe', transport: 'stdio', command: ['node', 'mcp.js'] }] }]]) });
    await AgentProfile.create({ agentId: 'policy-agent:machine-1', agentName: 'policy-agent',
      instanceId: 'machine-1', podId: pod._id, name: 'Policy agent', purpose: 'Test', createdBy: owner._id });
  });

  it('writes approvals and context for the installer, then projects them', async () => {
    const response = await request(app).patch(url).set('Authorization', `Bearer ${token(owner)}`)
      .send({ instanceId: 'machine-1', toolPolicy: { allowed: ['commonly'], blocked: ['Bash'], requireApproval: ['Write'] },
        contextPolicy: { maxTokens: 8000, compactionThreshold: 6000, summaryHours: 24,
          includeMemory: true, includeSkills: false, includeSummaries: true } });
    expect(response.status).toBe(200);
    const profile = await AgentProfile.findOne({ agentName: 'policy-agent' }).lean();
    expect(profile.toolPolicy.allowed).toEqual(['commonly']);
    expect(profile.contextPolicy.includeSkills).toBe(false);
    const listed = await request(app).get(`/api/registry/pods/${pod._id}/agents/policy-agent?instanceId=machine-1`)
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(listed.status).toBe(200);
    expect(listed.body.agent.profile.toolPolicy.requireApproval).toEqual(['Write']);
  });

  it('updates trust mode without dropping workspace, network or MCP declarations', async () => {
    const response = await request(app).patch(url).set('Authorization', `Bearer ${token(owner)}`)
      .send({ instanceId: 'machine-1', config: { environment: { sandbox: { mode: 'workspace' } } } });
    expect(response.status).toBe(200);
    const installation = await AgentInstallation.findOne({ agentName: 'policy-agent' });
    const environment = installation.config.get('environment');
    expect(environment.sandbox).toEqual({ mode: 'workspace', network: { policy: 'restricted' } });
    expect(environment.workspace).toEqual({ path: '/repo' });
    expect(environment.mcp).toHaveLength(1);
    const listed = await request(app).get(`/api/registry/pods/${pod._id}/agents/policy-agent?instanceId=machine-1`)
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(listed.body.agent.config.environment.sandbox).toEqual({ mode: 'workspace' });
    expect(JSON.stringify(listed.body)).not.toContain('mcp.js');
  });

  it('refuses a pod member and invalid context before changing policy', async () => {
    const denied = await request(app).patch(url).set('Authorization', `Bearer ${token(outsider)}`)
      .send({ instanceId: 'machine-1', toolPolicy: { allowed: ['Bash'] } });
    const invalid = await request(app).patch(url).set('Authorization', `Bearer ${token(owner)}`)
      .send({ instanceId: 'machine-1', contextPolicy: { maxTokens: 100, compactionThreshold: 200 } });
    expect(denied.status).toBe(403);
    expect(invalid.status).toBe(400);
    const profile = await AgentProfile.findOne({ agentName: 'policy-agent' }).lean();
    expect(profile.toolPolicy.allowed).not.toContain('Bash');
  });
});
