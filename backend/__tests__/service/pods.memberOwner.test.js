process.env.PG_HOST = '';
process.env.JWT_SECRET = 'member-owner-test-secret';

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
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

// F402: the board names who holds a task, and for an agent whose it is. A pod
// read gives each member its display name, and a member reader also gets each
// agent's owner by name: never the owner's id or email, and nothing to a
// reader who is not a member.
describe('pod read: member names and agent owners', () => {
  let app;
  let owner;
  let teammate;
  let outsider;
  let agent;
  let pod;

  const makeUser = (name, extra = {}) => User.create({
    username: `${name}-${new mongoose.Types.ObjectId()}`,
    email: `${name}-${new mongoose.Types.ObjectId()}@test.com`,
    password: 'Password123!',
    verified: true,
    ...extra,
  });
  const get = (path, user) => request(app).get(path)
    .set('Authorization', `Bearer ${jwt.sign({ id: user._id }, process.env.JWT_SECRET)}`);
  const memberById = (res, user) => res.body.members.find((member) => String(member._id) === String(user._id));

  beforeAll(async () => {
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api', podInvitesRoutes);
    app.use('/api/pods', podRoutes);
  });

  beforeEach(async () => {
    await clearMongoDb();
    owner = await makeUser('owner', { displayName: 'Priya Rao' });
    teammate = await makeUser('teammate');
    outsider = await makeUser('outsider');
    agent = await makeUser('priya-claude', {
      isBot: true,
      botType: 'agent',
      botMetadata: { agentName: 'claude-code', instanceId: 'priya-claude', displayName: 'Priya Claude', ownerUserId: String(owner._id) },
    });
    pod = await Pod.create({
      name: 'race', type: 'team', createdBy: owner._id, members: [owner._id, teammate._id, agent._id], publicRead: true,
    });
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  it("names a member agent's owner by display name to a member, and sends no owner id or email", async () => {
    const res = await get(`/api/pods/${pod._id}`, teammate);
    expect(res.status).toBe(200);
    expect(memberById(res, agent)).toMatchObject({ isBot: true, ownerName: 'Priya Rao' });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('ownerUserId');
    expect(text).not.toContain(owner.email);
    // Only agents carry an owner.
    expect(memberById(res, teammate).ownerName).toBeUndefined();
  });

  it("falls back to the owner's username when they have no display name", async () => {
    await User.updateOne({ _id: owner._id }, { $unset: { displayName: '' } });
    const res = await get(`/api/pods/${pod._id}`, teammate);
    expect(memberById(res, agent).ownerName).toBe(owner.username);
  });

  it('gives a person their display name', async () => {
    const res = await get(`/api/pods/${pod._id}`, teammate);
    expect(memberById(res, owner)).toMatchObject({ username: owner.username, displayName: 'Priya Rao' });
  });

  it('names no owner to a reader of a public pod who is not a member', async () => {
    const res = await get(`/api/pods/${pod._id}`, outsider);
    expect(res.status).toBe(200);
    expect(memberById(res, agent).ownerName).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('ownerUserId');
  });

  it('sends no owner id for a member row that is not flagged a bot', async () => {
    await User.updateOne({ _id: teammate._id }, { $set: { 'botMetadata.ownerUserId': String(owner._id) } });
    const res = await get(`/api/pods/${pod._id}`, teammate);
    expect(JSON.stringify(res.body)).not.toContain('ownerUserId');
    expect(memberById(res, teammate).ownerName).toBeUndefined();
  });

  it('leaves the owner out when that account is gone', async () => {
    await User.deleteOne({ _id: owner._id });
    await Pod.updateOne({ _id: pod._id }, { $pull: { members: owner._id } });
    const res = await get(`/api/pods/${pod._id}`, teammate);
    expect(memberById(res, agent).ownerName).toBeUndefined();
  });
});
