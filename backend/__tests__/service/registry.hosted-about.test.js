// TASK-780: an owner edits a hosted agent's description after install. The
// description is config.hosted.about, the persona line the hosted system
// prompt carries, and the card's botMetadata.description. Before this, the
// only way to change it was an ops-runner write.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const agentConfig = require('../../routes/registry/agent-config');
const podAgents = require('../../routes/registry/pod-agents');
const { hostedNativeRunConfig } = require('../../services/hostedEngine');

const SECRET = 'hosted-about-test';
const token = (user) => jwt.sign({ id: String(user._id) }, SECRET);
const AGENT = 'hosted-about-agent';
const hostedOf = (installation) => {
  const config = installation.config instanceof Map ? Object.fromEntries(installation.config) : installation.config;
  return config.hosted instanceof Map ? Object.fromEntries(config.hosted) : config.hosted;
};

describe('editing a hosted agent description after install', () => {
  let app; let owner; let other; let admin; let podA; let podB;
  const provisionedAt = new Date('2026-11-01T00:00:00Z');

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', agentConfig);
    app.use('/api/registry', podAgents);
    owner = await User.create({ username: 'about-owner', email: 'about-owner@test.com', password: 'password123' });
    other = await User.create({ username: 'about-other', email: 'about-other@test.com', password: 'password123' });
    admin = await User.create({ username: 'about-admin', email: 'about-admin@test.com', password: 'password123', role: 'admin' });
    podA = await Pod.create({ name: 'About A', type: 'chat', createdBy: owner._id, members: [owner._id, other._id] });
    podB = await Pod.create({ name: 'About B', type: 'chat', createdBy: other._id, members: [owner._id, other._id] });
  });

  afterAll(async () => closeMongoDb());

  beforeEach(async () => {
    await AgentInstallation.deleteMany({ agentName: AGENT });
    await User.deleteMany({ isBot: true, 'botMetadata.agentName': AGENT });
    await AgentInstallation.create({
      agentName: AGENT, instanceId: 'default', podId: podA._id, version: '1', installedBy: owner._id,
      config: new Map([
        ['runtime', { runtimeType: 'hosted' }],
        ['hosted', { engine: 'native', provisionedAt, about: 'Watches errors.' }],
      ]),
    });
    await User.create({
      username: `${AGENT}-bot`, email: `${AGENT}-bot@test.com`, password: 'password123', isBot: true,
      botMetadata: { agentName: AGENT, instanceId: 'default', displayName: 'Triage', description: 'Watches errors.' },
    });
  });

  const patch = (user, body, podId = podA._id) => request(app)
    .patch(`/api/registry/pods/${podId}/agents/${AGENT}`)
    .set('Authorization', `Bearer ${token(user)}`)
    .send({ instanceId: 'default', ...body });

  it('writes the new description into the hosted prompt and the card, keeping the engine record', async () => {
    const response = await patch(owner, { about: '  Posts   findings and never files rows.  ' });
    expect(response.status).toBe(200);

    const saved = await AgentInstallation.findOne({ agentName: AGENT, podId: podA._id });
    expect(hostedOf(saved)).toEqual(expect.objectContaining({
      engine: 'native', about: 'Posts findings and never files rows.',
    }));
    expect(new Date(hostedOf(saved).provisionedAt).toISOString()).toBe(provisionedAt.toISOString());
    const run = hostedNativeRunConfig(saved, 30, { searches: 3, pages: 3 });
    expect(run.systemPrompt).toContain('Posts findings and never files rows.');
    expect(run.systemPrompt).not.toContain('Watches errors.');

    const bot = await User.findOne({ isBot: true, 'botMetadata.agentName': AGENT }).lean();
    expect(bot.botMetadata.description).toBe('Posts findings and never files rows.');

    const read = await request(app).get(`/api/registry/pods/${podA._id}/agents/${AGENT}?instanceId=default`)
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(read.body.agent.about).toBe('Posts findings and never files rows.');
  });

  it('clears the description when it is saved empty', async () => {
    const response = await patch(owner, { about: '   ' });
    expect(response.status).toBe(200);
    const saved = await AgentInstallation.findOne({ agentName: AGENT, podId: podA._id });
    expect(hostedOf(saved).about).toBeUndefined();
    expect(hostedOf(saved).engine).toBe('native');
    const bot = await User.findOne({ isBot: true, 'botMetadata.agentName': AGENT }).lean();
    expect(bot.botMetadata.description).toBe('');
  });

  it('refuses a description over 160 characters and writes nothing', async () => {
    const response = await patch(owner, { about: 'x'.repeat(161) });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_about');
    const saved = await AgentInstallation.findOne({ agentName: AGENT, podId: podA._id });
    expect(hostedOf(saved).about).toBe('Watches errors.');
  });

  it('refuses a description on an agent that is not hosted', async () => {
    await AgentInstallation.updateOne({ agentName: AGENT, podId: podA._id },
      { $set: { config: new Map([['runtime', { runtimeType: 'wrapper' }]]) } });
    const response = await patch(owner, { about: 'Anything.' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('about_hosted_only');
    const saved = await AgentInstallation.findOne({ agentName: AGENT, podId: podA._id });
    expect(hostedOf(saved)).toBeUndefined();
  });

  it('refuses a pod member who did not install the agent', async () => {
    const response = await patch(other, { about: 'Hijacked.' });
    expect(response.status).toBe(403);
    const saved = await AgentInstallation.findOne({ agentName: AGENT, podId: podA._id });
    expect(hostedOf(saved).about).toBe('Watches errors.');
  });

  it('leaves another installer\'s row and the shared card alone', async () => {
    await AgentInstallation.create({
      agentName: AGENT, instanceId: 'default', podId: podB._id, version: '1', installedBy: other._id,
      config: new Map([
        ['runtime', { runtimeType: 'hosted' }],
        ['hosted', { engine: 'native', provisionedAt, about: 'Watches errors.' }],
      ]),
    });
    const response = await patch(owner, { about: 'Mine only.' });
    expect(response.status).toBe(200);
    const mine = await AgentInstallation.findOne({ agentName: AGENT, podId: podA._id });
    const theirs = await AgentInstallation.findOne({ agentName: AGENT, podId: podB._id });
    expect(hostedOf(mine).about).toBe('Mine only.');
    expect(hostedOf(theirs).about).toBe('Watches errors.');
    const bot = await User.findOne({ isBot: true, 'botMetadata.agentName': AGENT }).lean();
    expect(bot.botMetadata.description).toBe('Watches errors.');
  });

  it('refuses a hosted row still on the Durable Object, which never reads it', async () => {
    await AgentInstallation.updateOne({ agentName: AGENT, podId: podA._id }, { $set: { config: new Map([
      ['runtime', { runtimeType: 'hosted' }], ['hosted', { engine: 'durable-object', provisionedAt, about: 'Watches errors.' }],
    ]) } });
    const response = await patch(owner, { about: 'Unused.' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('about_hosted_only');
    const read = await request(app).get(`/api/registry/pods/${podA._id}/agents/${AGENT}?instanceId=default`)
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(read.body.agent).not.toHaveProperty('about');
  });

  it('keeps migration fields and applies a config change sent alongside', async () => {
    const migratedFrom = { engine: 'durable-object', at: new Date('2026-10-20T00:00:00Z') };
    await AgentInstallation.updateOne({ agentName: AGENT, podId: podA._id }, { $set: { config: new Map([
      ['runtime', { runtimeType: 'hosted' }],
      ['hosted', { engine: 'native', provisionedAt, about: 'Watches errors.', migratedFrom }],
    ]) } });
    const response = await patch(owner, { about: 'New line.', config: { heartbeatChecklist: 'check sentry' } });
    expect(response.status).toBe(200);
    const saved = await AgentInstallation.findOne({ agentName: AGENT, podId: podA._id });
    expect(hostedOf(saved)).toEqual(expect.objectContaining({ engine: 'native', about: 'New line.' }));
    expect(hostedOf(saved).migratedFrom.engine).toBe('durable-object');
    expect(Object.fromEntries(saved.config).heartbeatChecklist).toBe('check sentry');
  });

  it('an instance admin edits every installation, so the card follows', async () => {
    await AgentInstallation.create({
      agentName: AGENT, instanceId: 'default', podId: podB._id, version: '1', installedBy: other._id,
      config: new Map([['runtime', { runtimeType: 'hosted' }], ['hosted', { engine: 'native', provisionedAt, about: 'Watches errors.' }]]),
    });
    const response = await patch(admin, { about: 'Admin set.' });
    expect(response.status).toBe(200);
    const rows = await AgentInstallation.find({ agentName: AGENT });
    expect(rows.map((row) => hostedOf(row).about)).toEqual(['Admin set.', 'Admin set.']);
    const bot = await User.findOne({ isBot: true, 'botMetadata.agentName': AGENT }).lean();
    expect(bot.botMetadata.description).toBe('Admin set.');
  });

  it('refuses the whole write when a row it reaches is on another engine, and changes nothing', async () => {
    await AgentInstallation.create({
      agentName: AGENT, instanceId: 'default', podId: podB._id, version: '1', installedBy: other._id,
      config: new Map([['runtime', { runtimeType: 'hosted' }], ['hosted', { engine: 'durable-object', provisionedAt, about: 'Watches errors.' }]]),
    });
    const response = await patch(admin, { about: 'Admin set.' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('about_hosted_only');
    const rows = await AgentInstallation.find({ agentName: AGENT });
    expect(rows.map((row) => hostedOf(row).about)).toEqual(['Watches errors.', 'Watches errors.']);
    const bot = await User.findOne({ isBot: true, 'botMetadata.agentName': AGENT }).lean();
    expect(bot.botMetadata.description).toBe('Watches errors.');
  });

  it('still refuses a client-written config.hosted', async () => {
    const response = await patch(owner, { config: { hosted: { engine: 'durable-object', about: 'Sneaky.' } } });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const saved = await AgentInstallation.findOne({ agentName: AGENT, podId: podA._id });
    expect(hostedOf(saved)).toEqual(expect.objectContaining({ engine: 'native', about: 'Watches errors.' }));
  });
});
