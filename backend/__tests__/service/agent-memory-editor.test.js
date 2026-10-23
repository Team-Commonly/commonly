const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentMemory = require('../../models/AgentMemory');
const { AgentInstallation } = require('../../models/AgentRegistry');
const memoryView = require('../../routes/agentMemoryView');

const SECRET = 'agent-memory-editor-test';
const token = (user) => jwt.sign({ id: String(user._id) }, SECRET);
const base = '/api/agent-memory/editor-agent/machine-1/editable';

describe('owner memory editor', () => {
  let app; let owner; let outsider; let admin; let pod;

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/agent-memory', memoryView);
    owner = await User.create({ username: 'memory-edit-owner', email: 'memory-edit-owner@test.com', password: 'password123' });
    outsider = await User.create({ username: 'memory-edit-outsider', email: 'memory-edit-outsider@test.com', password: 'password123' });
    admin = await User.create({ username: 'memory-edit-admin', email: 'memory-edit-admin@test.com', password: 'password123', role: 'admin' });
    pod = await Pod.create({ name: 'Editor pod', type: 'chat', createdBy: owner._id, members: [owner._id, outsider._id] });
  });

  afterAll(async () => closeMongoDb());

  beforeEach(async () => {
    await AgentInstallation.deleteMany({ agentName: 'editor-agent' });
    await AgentMemory.deleteMany({ agentName: 'editor-agent' });
    await AgentInstallation.create({ agentName: 'editor-agent', instanceId: 'machine-1', podId: pod._id,
      version: '1', installedBy: owner._id });
    await AgentMemory.create({ agentName: 'editor-agent', instanceId: 'machine-1',
      content: 'Old note', sections: {
        long_term: { content: 'Old note', visibility: 'private', updatedAt: new Date('2026-01-01'), byteSize: 8 },
        dedup_state: { content: 'internal key', visibility: 'private', byteSize: 12 },
      } });
  });

  it('shows editable documents only to the installer or admin', async () => {
    const ownerRead = await request(app).get(base).set('Authorization', `Bearer ${token(owner)}`);
    const adminRead = await request(app).get(base).set('Authorization', `Bearer ${token(admin)}`);
    const outsiderRead = await request(app).get(base).set('Authorization', `Bearer ${token(outsider)}`);
    expect(ownerRead.status).toBe(200);
    expect(adminRead.status).toBe(200);
    expect(outsiderRead.status).toBe(403);
    expect(ownerRead.body.sections.long_term.content).toBe('Old note');
    expect(JSON.stringify(ownerRead.body)).not.toContain('internal key');
  });

  it('preserves sibling memory and rejects a stale edit', async () => {
    const read = await request(app).get(base).set('Authorization', `Bearer ${token(owner)}`);
    const revision = read.body.sections.long_term.updatedAt;
    const saved = await request(app).patch(`${base}/long_term`).set('Authorization', `Bearer ${token(owner)}`)
      .send({ content: 'New note', expectedUpdatedAt: revision });
    expect(saved.status).toBe(200);
    const stale = await request(app).patch(`${base}/long_term`).set('Authorization', `Bearer ${token(owner)}`)
      .send({ content: 'Old edit', expectedUpdatedAt: revision });
    expect(stale.status).toBe(409);
    const record = await AgentMemory.findOne({ agentName: 'editor-agent', instanceId: 'machine-1' }).lean();
    expect(record.content).toBe('New note');
    expect(record.sections.long_term.content).toBe('New note');
    expect(record.sections.dedup_state.content).toBe('internal key');
    expect(record.sections.long_term.history[0].content).toBe('Old note');
  });

  it('creates the first memory document and rejects a stale second creation', async () => {
    await AgentMemory.deleteMany({ agentName: 'editor-agent' });
    const first = await request(app).patch(`${base}/long_term`).set('Authorization', `Bearer ${token(owner)}`)
      .send({ content: 'First note', expectedUpdatedAt: null });
    expect(first.status).toBe(200);
    const stale = await request(app).patch(`${base}/long_term`).set('Authorization', `Bearer ${token(owner)}`)
      .send({ content: 'Stale note', expectedUpdatedAt: null });
    expect(stale.status).toBe(409);
    const records = await AgentMemory.find({ agentName: 'editor-agent', instanceId: 'machine-1' }).lean();
    expect(records).toHaveLength(1);
    expect(records[0].content).toBe('First note');
  });

  it('blocks another member from editing and refuses unknown sections', async () => {
    const denied = await request(app).patch(`${base}/long_term`).set('Authorization', `Bearer ${token(outsider)}`)
      .send({ content: 'No', expectedUpdatedAt: null });
    const unknown = await request(app).patch(`${base}/dedup_state`).set('Authorization', `Bearer ${token(owner)}`)
      .send({ content: 'No', expectedUpdatedAt: null });
    expect(denied.status).toBe(403);
    expect(unknown.status).toBe(404);
  });

  it('keeps the editor available to the installer while the agent is paused', async () => {
    await AgentInstallation.updateMany({ agentName: 'editor-agent' }, { $set: { status: 'paused' } });
    const response = await request(app).get(base).set('Authorization', `Bearer ${token(owner)}`);
    expect(response.status).toBe(200);
    expect(response.body.sections.long_term.content).toBe('Old note');
  });
});
