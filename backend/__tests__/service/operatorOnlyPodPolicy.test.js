const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const express = require('express');
const request = require('supertest');
const { hash } = require('../../utils/secret');
const { AgentInstallation } = require('../../models/AgentRegistry');
const app = express();
app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Integration = require('../../models/Integration');
const { operatorOnlyPodAllowed } = require('../../services/operatorOnlyPodPolicy');
let owner; let bot; let pod; let installations;
beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb();
  owner = await User.create({ username: 'native-owner', email: 'native-owner@test.com', password: 'password123' });
  bot = await User.create({ username: 'native-fixture', email: 'native-fixture@test.com', password: 'password123', isBot: true, botMetadata: { agentName: 'native-fixture', instanceId: 'default' }, agentRuntimeTokens: [{ tokenHash: hash('cm_agent_fixture'), label: 'fixture', createdAt: new Date(), lastUsedAt: new Date() }] });
  pod = await Pod.create({ name: 'Private', type: 'chat', createdBy: owner._id,
    members: [owner._id, bot._id], joinPolicy: 'invite-only', publicRead: false, communityListed: false });
  installations = [{ agentName: 'native-fixture', instanceId: 'default', podId: pod._id, installedBy: owner._id }];
});
const allowed = () => operatorOnlyPodAllowed(String(pod._id), installations, bot);
test('only private operator and exact listener are allowed', async () => {
  expect(await allowed()).toBe(true);
  expect(await operatorOnlyPodAllowed(String(pod._id), installations, null)).toBe(true);
  expect(await operatorOnlyPodAllowed('invalid', installations, bot)).toBe(false);
  expect(await operatorOnlyPodAllowed(String(pod._id), [], bot)).toBe(false);
});
test.each([false, true])('added human/bot (%s) revokes eligibility', async (isBot) => {
  const peer = await User.create({ username: 'peer', email: 'peer@test.com', password: 'password123', isBot });
  await Pod.updateOne({ _id: pod._id }, { $push: { members: peer._id } });
  expect(await allowed()).toBe(false);
});
test.each([{ type: 'agent-dm' }, { type: 'agent-room' }, { type: 'agent-admin' }, { publicRead: true }, { communityListed: true }, { joinPolicy: 'open' },
  { createdBy: new mongoose.Types.ObjectId() }, { members: [] }])('unsafe pod %j is refused', async (change) => {
  await Pod.updateOne({ _id: pod._id }, { $set: change });
  expect(await allowed()).toBe(false);
});
test('missing listener, mixed owners and other identity tokens are refused', async () => {
  expect(await operatorOnlyPodAllowed(String(pod._id), installations, { _id: owner._id })).toBe(false);
  installations.push({ ...installations[0], installedBy: new mongoose.Types.ObjectId() });
  expect(await allowed()).toBe(false);
  installations.pop();
  await User.deleteOne({ _id: bot._id });
  expect(await allowed()).toBe(false);
});
test('active bridge revokes private audience', async () => {
  await Integration.create({ podId: pod._id, scope: 'pod', type: 'slack', status: 'connected',
    isActive: true, createdBy: owner._id, config: {} });
  expect(await allowed()).toBe(false);
});

test('actual runtime-token route checks current Mongo audience and denies unknown credentials', async () => {
  await AgentInstallation.create({ ...installations[0], version: '1.0.0', status: 'active', scopes: ['context:read'] });
  const get = (token) => request(app).get(`/api/agents/runtime/pods/${pod._id}/operator-only`).set('Authorization', `Bearer ${token}`);
  expect((await get('cm_agent_invalid')).status).toBe(401);
  const good = await get('cm_agent_fixture');
  expect(good.status).toBe(200);
  expect(good.body).toEqual({ allowed: true, podId: String(pod._id), agentName: 'native-fixture', instanceId: 'default' });
  await Pod.updateOne({ _id: pod._id }, { $push: { members: new mongoose.Types.ObjectId() } });
  expect((await get('cm_agent_fixture')).status).toBe(403);
});
