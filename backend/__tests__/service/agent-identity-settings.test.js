const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentProfile = require('../../models/AgentProfile');
const { AgentInstallation } = require('../../models/AgentRegistry');
const agentConfig = require('../../routes/registry/agent-config');

const SECRET = 'agent-identity-settings-test';
const bearer = (user) => `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`;

describe('agent identity settings with stored installations', () => {
  let app; let installer; let other; let admin; let podA; let podB; let identity;

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', agentConfig);
    installer = await User.create({ username: 'identity-installer', email: 'identity-installer@test.com', password: 'password123' });
    other = await User.create({ username: 'identity-other', email: 'identity-other@test.com', password: 'password123' });
    admin = await User.create({
      username: 'identity-admin', email: 'identity-admin@test.com', password: 'password123', role: 'admin', 
    });
    podA = await Pod.create({
      name: 'Identity A', type: 'chat', createdBy: installer._id, members: [installer._id, other._id], 
    });
    podB = await Pod.create({
      name: 'Identity B', type: 'chat', createdBy: other._id, members: [installer._id, other._id], 
    });
  });

  afterAll(async () => closeMongoDb());

  beforeEach(async () => {
    await AgentInstallation.deleteMany({ agentName: 'identity-agent' });
    await AgentProfile.deleteMany({ agentName: 'identity-agent' });
    await User.deleteMany({ username: 'identity-agent-seat' });
    identity = await User.create({
      username: 'identity-agent-seat',
      email: 'identity-agent-seat@test.com',
      password: 'password123',
      isBot: true,
      botType: 'agent',
      botMetadata: { agentName: 'identity-agent', instanceId: 'seat', displayName: 'Old name' },
    });
    await AgentInstallation.create([
      {
        agentName: 'identity-agent', instanceId: 'seat', podId: podA._id, version: '1', installedBy: installer._id, displayName: 'Old name', 
      },
      {
        agentName: 'identity-agent', instanceId: 'seat', podId: podB._id, version: '1', installedBy: other._id, displayName: 'Old name', 
      },
    ]);
    await AgentProfile.create([
      {
        agentId: 'identity-agent:seat',
        agentName: 'identity-agent',
        instanceId: 'seat',
        podId: podA._id,
        name: 'Old name',
        purpose: 'Test',
        createdBy: installer._id, 
      },
      {
        agentId: 'identity-agent:seat',
        agentName: 'identity-agent',
        instanceId: 'seat',
        podId: podB._id,
        name: 'Old name',
        purpose: 'Test',
        createdBy: other._id, 
      },
    ]);
  });

  const url = (podId) => `/api/registry/pods/${podId}/agents/identity-agent`;

  it('refuses a pod member who did not install the agent', async () => {
    const response = await request(app).patch(url(podA._id)).set('Authorization', bearer(other))
      .send({ instanceId: 'seat', instructions: 'Replace the owner instructions' });
    expect(response.status).toBe(403);
    expect((await AgentProfile.findOne({ podId: podA._id, agentName: 'identity-agent' })).instructions).toBe('');
  });

  it('saves installer instructions and persona only to the installer-owned pod', async () => {
    const persona = {
      tone: 'technical', specialties: ['research'], boundaries: ['no secrets'], customInstructions: 'Be concise', 
    };
    const response = await request(app).patch(url(podA._id)).set('Authorization', bearer(installer))
      .send({ instanceId: 'seat', instructions: 'Help with research', persona });
    expect(response.status).toBe(200);
    const [a, b] = await Promise.all([
      AgentProfile.findOne({ podId: podA._id, agentName: 'identity-agent' }),
      AgentProfile.findOne({ podId: podB._id, agentName: 'identity-agent' }),
    ]);
    expect(a.instructions).toBe('Help with research');
    expect(a.persona.specialties).toEqual(['research']);
    expect(b.instructions).toBe('');
    expect(b.persona.specialties).toEqual([]);
  });

  it('refuses a partial installer rename before changing the portable identity', async () => {
    const response = await request(app).patch(url(podA._id)).set('Authorization', bearer(installer))
      .send({ instanceId: 'seat', displayName: 'New name' });
    expect([403, 409]).toContain(response.status);
    expect((await User.findById(identity._id)).botMetadata.displayName).toBe('Old name');
    expect((await AgentInstallation.findOne({ podId: podA._id, agentName: 'identity-agent' })).displayName).toBe('Old name');
  });

  it('lets an admin rename the portable identity and both pod projections', async () => {
    const response = await request(app).patch(url(podA._id)).set('Authorization', bearer(admin))
      .send({ instanceId: 'seat', displayName: 'New name' });
    expect(response.status).toBe(200);
    expect((await User.findById(identity._id)).botMetadata).toEqual(expect.objectContaining({
      displayName: 'New name', agentName: 'identity-agent', instanceId: 'seat',
    }));
    const installations = await AgentInstallation.find({ agentName: 'identity-agent', instanceId: 'seat' });
    expect(installations.map((row) => row.displayName)).toEqual(['New name', 'New name']);
    const profiles = await AgentProfile.find({ agentName: 'identity-agent', instanceId: 'seat' });
    expect(profiles.map((row) => row.name)).toEqual(['New name', 'New name']);
  });
});
