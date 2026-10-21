const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../../middleware/auth', () => (req, _res, next) => { req.user = { id: 'bbbbbbbbbbbbbbbbbbbbbbbb' }; next(); });
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => (
  req.get('x-admin') === 'yes' ? next() : res.status(403).end()
));

let mongod;
let app;
let Pod;
let Integration;
let GithubGigBinding;
let GithubGigDelivery;
const podId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb');

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  Pod = require('../../../models/Pod');
  Integration = require('../../../models/Integration');
  GithubGigBinding = require('../../../models/GithubGigBinding');
  GithubGigDelivery = require('../../../models/GithubGigDelivery');
  app = express();
  app.use(express.json());
  app.use('/api/integrations', require('../../../routes/integrations'));
  await Pod.create({ _id: podId, name: 'Build', createdBy: adminId, members: [adminId] });
});
afterAll(async () => { await mongoose.disconnect(); if (mongod) await mongod.stop(); });

test('only an admin can bind and unbind a connected App repository to a real pod', async () => {
  const row = await Integration.create({
    installationId: '7654321', type: 'github-app', scope: 'user', status: 'connected',
    config: { installationId: '7654321', owner: 'Team-Commonly', repo: 'commonly' },
    createdBy: adminId, isActive: true,
  });
  const path = `/api/integrations/github-app/${row._id}/gig-pod`;
  const denied = await request(app).put(path).send({ podId: String(podId) });
  expect(denied.status).toBe(403);
  expect(await GithubGigBinding.countDocuments()).toBe(0);

  const missing = await request(app).put(path).set('x-admin', 'yes').send({ podId: String(new mongoose.Types.ObjectId()) });
  expect(missing.status).toBe(404);
  const dm = await Pod.create({ name: 'DM', type: 'agent-dm', createdBy: adminId, members: [adminId] });
  const dmBinding = await request(app).put(path).set('x-admin', 'yes').send({ podId: String(dm._id) });
  expect(dmBinding.status).toBe(400);
  const adminPod = await Pod.create({ name: 'Agent admin', type: 'agent-admin', createdBy: adminId, members: [adminId] });
  const adminPodBinding = await request(app).put(path).set('x-admin', 'yes').send({ podId: String(adminPod._id) });
  expect(adminPodBinding.status).toBe(400);
  const otherUser = new mongoose.Types.ObjectId();
  const otherPod = await Pod.create({ name: 'Private chat', type: 'chat', createdBy: otherUser, members: [otherUser] });
  const nonMemberBinding = await request(app).put(path).set('x-admin', 'yes').send({ podId: String(otherPod._id) });
  expect(nonMemberBinding.status).toBe(403);
  expect(await GithubGigBinding.countDocuments()).toBe(0);
  const bound = await request(app).put(path).set('x-admin', 'yes').send({ podId: String(podId) });
  expect(bound.status).toBe(200);
  expect(String((await GithubGigBinding.findOne({ installationId: '7654321' })).podId)).toBe(String(podId));

  const secondRepo = await request(app).put(path).set('x-admin', 'yes')
    .send({ podId: String(podId), owner: 'TEAM-COMMONLY', repo: 'ANOTHER-REPO' });
  expect(secondRepo.status).toBe(200);
  expect(await GithubGigBinding.countDocuments({ installationId: '7654321' })).toBe(2);
  expect(await GithubGigBinding.countDocuments({ installationId: '7654321', owner: 'team-commonly', repo: 'commonly' })).toBe(1);
  expect(await GithubGigBinding.countDocuments({ installationId: '7654321', owner: 'team-commonly', repo: 'another-repo' })).toBe(1);

  const unbound = await request(app).delete(path).set('x-admin', 'yes');
  expect(unbound.status).toBe(204);
  expect(await GithubGigBinding.countDocuments()).toBe(1);
});

test('a new delivery id cannot replay the same signed body', async () => {
  await GithubGigDelivery.init();
  const bodyHash = 'a'.repeat(64);
  await GithubGigDelivery.create({ deliveryId: 'delivery-1', bodyHash });
  await expect(GithubGigDelivery.create({ deliveryId: 'delivery-2', bodyHash })).rejects.toMatchObject({ code: 11000 });
});
