// F44 (A): an agent has three names, and the pod roster showed two of them
// (agentName and instanceId) but not the one a person types to reach it. The
// roster now carries the handle mention routing resolves for each agent.
process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const mockOwner = { id: new mongoose.Types.ObjectId().toString() };
jest.mock('../../middleware/auth', () => {
  const auth = (req, _res, next) => {
    req.userId = mockOwner.id;
    req.user = { id: mockOwner.id };
    next();
  };
  auth.touchLastActive = () => {};
  return auth;
});

const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');

const app = express();
app.use(express.json());
app.use('/api/registry', require('../../routes/registry/pod-agents'));

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(clearMongoDb);

test('each agent row carries the handle its @mentions route to', async () => {
  const agents = [['cto-walk-1016', 'cto-walk'], ['rivet', 'default']];
  const users = await Promise.all(agents.map(([agentName, instanceId]) => (
    AgentIdentityService.getOrCreateAgentUser(agentName, { instanceId })
  )));
  const pod = await Pod.create({
    name: 'Roster pod', type: 'chat', createdBy: mockOwner.id, members: [mockOwner.id, ...users.map((u) => u._id)],
  });
  await Promise.all(agents.map(([agentName, instanceId]) => AgentInstallation.create({
    agentName, instanceId, podId: pod._id, installedBy: mockOwner.id, status: 'active', version: '1.0.0',
  })));

  const res = await request(app).get(`/api/registry/pods/${pod._id}/agents`).expect(200);

  const byInstance = Object.fromEntries(res.body.agents.map((a) => [a.instanceId, a.mention]));
  expect(byInstance).toEqual({ 'cto-walk': 'cto-walk-1016-cto-walk', default: 'rivet' });
});

test('a mention map that fails to load leaves every row in place, with no handle', async () => {
  const agents = [['cto-walk-1016', 'cto-walk'], ['rivet', 'default']];
  const users = await Promise.all(agents.map(([agentName, instanceId]) => (
    AgentIdentityService.getOrCreateAgentUser(agentName, { instanceId })
  )));
  const pod = await Pod.create({
    name: 'Roster pod', type: 'chat', createdBy: mockOwner.id, members: [mockOwner.id, ...users.map((u) => u._id)],
  });
  await Promise.all(agents.map(([agentName, instanceId]) => AgentInstallation.create({
    agentName, instanceId, podId: pod._id, installedBy: mockOwner.id, status: 'active', version: '1.0.0',
  })));
  const mentions = require('../../services/agentMentionService');
  const load = jest.spyOn(mentions, 'loadPodMentionMap').mockRejectedValueOnce(new Error('mongo blip'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  try {
    const res = await request(app).get(`/api/registry/pods/${pod._id}/agents`).expect(200);

    expect(load).toHaveBeenCalled();
    const byInstance = Object.fromEntries(res.body.agents.map((a) => [a.instanceId, a.mention]));
    expect(byInstance).toEqual({ 'cto-walk': '', default: '' });
  } finally {
    load.mockRestore();
    warn.mockRestore();
  }
});

test('an active install whose bot row is missing still carries its routed handle', async () => {
  const pod = await Pod.create({
    name: 'Roster pod', type: 'chat', createdBy: mockOwner.id, members: [mockOwner.id],
  });
  await AgentInstallation.create({
    agentName: 'cto-walk-1016', instanceId: 'cto-walk', podId: pod._id, installedBy: mockOwner.id, status: 'active', version: '1.0.0',
  });

  const res = await request(app).get(`/api/registry/pods/${pod._id}/agents`).expect(200);

  // Mention routing reads the install, so the roster names the same handle.
  expect(res.body.agents.map((a) => [a.instanceId, a.mention])).toEqual([['cto-walk', 'cto-walk-1016-cto-walk']]);
});
