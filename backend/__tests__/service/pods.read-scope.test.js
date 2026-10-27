process.env.PG_HOST = '';
process.env.JWT_SECRET = 'read-scope-test-secret';

jest.mock('jsonwebtoken', () => ({
  sign: ({ id }) => `test-token:${id}`,
  verify: (token) => ({ id: token.replace('test-token:', '') }),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const podInvitesRoutes = require('../../routes/podInvites');
const podRoutes = require('../../routes/pods');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../utils/testUtils');

// The typed listing (GET /api/pods/:type) and the by-id reads
// (GET /api/pods/:id, GET /api/pods/:type/:id) answer only for pods the caller
// may see: their own, a publicly readable one, or, by id, whatever canViewPod
// admits. Real Mongo, so the listing predicate runs in the database.
describe('pod reads by type and by id', () => {
  let app;
  let owner;
  let viewer;
  let admin;
  let pods;

  const makeUser = (name, extra = {}) => User.create({
    username: `${name}-${new mongoose.Types.ObjectId()}`,
    email: `${name}-${new mongoose.Types.ObjectId()}@test.com`,
    password: 'Password123!',
    verified: true,
    ...extra,
  });
  const tokenFor = (user) => jwt.sign({ id: user._id }, process.env.JWT_SECRET);
  const get = (path, user) => request(app).get(path).set('Authorization', `Bearer ${tokenFor(user)}`);
  const idsOf = (res) => res.body.map((pod) => String(pod._id)).sort();

  beforeAll(async () => {
    await setupMongoDb();
    app = express();
    app.use(express.json());
    // Production order: invite routes precede the pods catch-all (#712).
    app.use('/api', podInvitesRoutes);
    app.use('/api/pods', podRoutes);
  });

  beforeEach(async () => {
    await clearMongoDb();
    owner = await makeUser('owner');
    viewer = await makeUser('viewer');
    admin = await makeUser('admin', { role: 'admin' });
    const create = (name, overrides = {}) => Pod.create({
      name,
      type: 'team',
      createdBy: owner._id,
      members: [owner._id],
      ...overrides,
    });
    pods = {
      private: await create('private team'),
      listed: await create('listed team', { publicRead: true, communityListed: true }),
      readableUnlisted: await create('readable unlisted team', { publicRead: true }),
      shared: await create('shared team', { members: [owner._id, viewer._id] }),
      // A personal type with the public flags forced on must still read as private.
      forcedRoom: await create('forced room', {
        type: 'agent-room', publicRead: true, communityListed: true,
      }),
    };
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  it('lists the caller\'s own pods of a type plus the Community-listed ones', async () => {
    const res = await get('/api/pods/team', viewer).expect(200);

    expect(idsOf(res)).toEqual([String(pods.listed._id), String(pods.shared._id)].sort());
  });

  it('gives a global admin no membership bypass on the typed listing', async () => {
    const res = await get('/api/pods/team', admin).expect(200);

    expect(idsOf(res)).toEqual([String(pods.listed._id)]);
  });

  it('never lists a personal pod to a non-member, whatever its flags say', async () => {
    const res = await get('/api/pods/agent-room', viewer).expect(200);

    expect(res.body).toEqual([]);
  });

  it.each([
    ['/api/pods/:id', (pod) => `/api/pods/${pod._id}`],
    ['/api/pods/:type/:id', (pod) => `/api/pods/${pod.type}/${pod._id}`],
  ])('%s answers a non-member with the same 404 as a missing pod', async (_label, pathFor) => {
    const missing = { _id: new mongoose.Types.ObjectId(), type: 'team' };

    const refused = await get(pathFor(pods.private), viewer).expect(404);
    const absent = await get(pathFor(missing), viewer).expect(404);

    expect(refused.body).toEqual(absent.body);
    expect(refused.body).not.toHaveProperty('name');
  });

  it('answers a non-member who sends the wrong type with the same 404 as a missing pod', async () => {
    const refused = await get(`/api/pods/agent-room/${pods.private._id}`, viewer).expect(404);
    const absent = await get(`/api/pods/agent-room/${new mongoose.Types.ObjectId()}`, viewer).expect(404);

    expect(refused.body).toEqual(absent.body);
  });

  it('still tells a member that the pod is not of the requested type', async () => {
    const res = await get(`/api/pods/agent-room/${pods.private._id}`, owner).expect(404);

    expect(res.body).toEqual({ error: 'Pod not found or is not of specified type' });
  });

  it('serves a pod by id to a member, and a publicly readable pod to anyone signed in', async () => {
    await get(`/api/pods/${pods.shared._id}`, viewer).expect(200);
    await get(`/api/pods/${pods.listed._id}`, viewer).expect(200);
    const readable = await get(`/api/pods/${pods.readableUnlisted._id}`, viewer).expect(200);

    expect(readable.body.name).toBe('readable unlisted team');
  });

  it('serves a private pod by id to a global admin through canViewPod', async () => {
    const res = await get(`/api/pods/${pods.private._id}`, admin).expect(200);

    expect(res.body.name).toBe('private team');
  });

  it('keeps an agent-room membership-only by id, for admins too, whatever its flags say', async () => {
    await get(`/api/pods/${pods.forcedRoom._id}`, viewer).expect(404);
    await get(`/api/pods/${pods.forcedRoom._id}`, admin).expect(404);
    await get(`/api/pods/${pods.forcedRoom._id}`, owner).expect(200);
  });
});
