/**
 * F653: an install that names no instanceId derives one from its displayName,
 * and a display name the caller's agent never had mints a new permanent
 * identity (new bot User, empty memory). The pick is unchanged; the answer now
 * says a new identity was made and names the instance(s) the caller already
 * has, so the agent they meant is one `instanceId` away.
 *
 * Real Mongo and the real install route: the claim is about which identity
 * rows exist and whose they are, which a mocked model would only agree with.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../services/agentEventService', () => ({
  enqueue: jest.fn(async () => ({ _id: 'stub-event' })),
}));

// The real lookup, wrapped so one test can make it fail.
jest.mock('../../services/installInstanceId', () => {
  const actual = jest.requireActual('../../services/installInstanceId');
  return { ...actual, identityInUse: jest.fn(actual.identityInUse) };
});

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');
const registryRoutes = require('../../routes/registry');
const installInstanceId = require('../../services/installInstanceId');

const JWT_SECRET = 'f653-new-agent-identity';
const AGENT = 'f653-helper';

jest.setTimeout(60000);

describe('install says when it mints a new agent identity (F653)', () => {
  let app;
  let alice;
  let bob;
  let alicePod;
  let bobPod;
  const saved = {};

  const bearer = (user) => `Bearer ${jwt.sign({ id: String(user._id) }, JWT_SECRET)}`;
  const install = (user, podId, body) => request(app)
    .post('/api/registry/install')
    .set('Authorization', bearer(user))
    .send({ agentName: AGENT, podId: String(podId), scopes: ['context:read'], ...body });
  const identityWarning = (res) => (res.body.warnings || []).find((w) => w.code === 'new_agent_identity');
  // A row as another write path leaves it, bypassing the route.
  const rawRow = (user, pod, instanceId, extra = {}) => AgentInstallation.collection.insertOne({
    agentName: AGENT, instanceId, podId: pod._id, installedBy: user._id,
    version: '1.0.0', status: 'active', createdAt: new Date(),
    config: { heartbeat: { enabled: false } }, scopes: ['context:read'], displayName: AGENT,
    ...extra,
  });
  const botUser = (instanceId, owner) => User.create({
    username: AgentIdentityService.buildAgentUsername(AgentIdentityService.resolveAgentType(AGENT), instanceId),
    email: `${instanceId}@agents.test.invalid`,
    password: 'password123',
    isBot: true,
    botMetadata: {
      agentName: AgentIdentityService.resolveAgentType(AGENT), instanceId, ownerUserId: String(owner._id),
    },
  });

  beforeAll(async () => {
    ['JWT_SECRET', 'PG_HOST'].forEach((key) => { saved[key] = process.env[key]; });
    delete process.env.PG_HOST;
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
  });

  afterAll(async () => {
    Object.entries(saved).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    await closeMongoDb();
  });

  beforeEach(async () => {
    await Promise.all([
      AgentInstallation.deleteMany({}), AgentRegistry.deleteMany({}), Pod.deleteMany({}), User.deleteMany({}),
    ]);
    alice = await User.create({ username: 'f653-alice', email: 'f653-alice@test.invalid', password: 'password123' });
    bob = await User.create({ username: 'f653-bob', email: 'f653-bob@test.invalid', password: 'password123' });
    alicePod = await Pod.create({ name: 'Alice pod', type: 'chat', createdBy: alice._id, members: [alice._id] });
    bobPod = await Pod.create({ name: 'Bob pod', type: 'chat', createdBy: bob._id, members: [bob._id] });
    await AgentRegistry.create({
      agentName: AGENT,
      displayName: 'Helper',
      description: 'F653 test agent',
      registry: 'commonly-official',
      verified: true,
      manifest: {
        name: AGENT,
        version: '1.0.0',
        capabilities: [],
        context: { required: ['context:read'] },
        runtime: { type: 'standalone', connection: 'rest' },
      },
      latestVersion: '1.0.0',
      versions: [{ version: '1.0.0', publishedAt: new Date() }],
    });
  });

  it('a first-ever install says a new identity was made, with no reuse hint', async () => {
    const res = await install(alice, alicePod._id, { instanceId: 'default' });
    expect(res.status).toBe(200);
    const warning = identityWarning(res);
    expect(warning).toBeDefined();
    expect(warning.instanceId).toBe('default');
    expect(warning.existingInstanceIds).toBeUndefined();
    expect(warning.message).not.toMatch(/pass instanceId/);
  });

  it('a displayName-only install names the instance you have, and still picks the derived one', async () => {
    expect((await install(alice, alicePod._id, { instanceId: 'default' })).status).toBe(200);

    const res = await install(alice, alicePod._id, { displayName: 'Demo Take' });
    expect(res.status).toBe(200);
    // Which identity is chosen is unchanged: the slug of the display name.
    expect(res.body.installation.instanceId).toBe('demo-take');
    expect(await User.exists({ isBot: true, 'botMetadata.instanceId': 'demo-take' })).toBeTruthy();

    const warning = identityWarning(res);
    expect(warning).toBeDefined();
    expect(warning.instanceId).toBe('demo-take');
    expect(warning.existingInstanceIds).toEqual(['default']);
    expect(warning.message).toContain("pass instanceId 'default' to install the agent you already have");
  });

  it('an install that reuses an identity returns no warning', async () => {
    const first = await install(alice, alicePod._id, { instanceId: 'default' });
    expect(first.status).toBe(200);
    // The same call that minted it said so, so the silence below is earned.
    expect(identityWarning(first)).toBeDefined();
    const otherPod = await Pod.create({ name: 'Alice two', type: 'chat', createdBy: alice._id, members: [alice._id] });

    const res = await install(alice, otherPod._id, { instanceId: 'default' });
    expect(res.status).toBe(200);
    expect(res.body.sharedIdentity).toBe(true);
    expect(identityWarning(res)).toBeUndefined();
  });

  it("never names another person's instances in the hint", async () => {
    expect((await install(alice, alicePod._id, { instanceId: 'default' })).status).toBe(200);
    expect((await install(alice, alicePod._id, { displayName: 'Alice Secret' })).status).toBe(200);

    const res = await install(bob, bobPod._id, { displayName: 'Bravo' });
    expect(res.status).toBe(200);
    expect(res.body.installation.instanceId).toBe('bravo');
    const warning = identityWarning(res);
    expect(warning).toBeDefined();
    expect(warning.instanceId).toBe('bravo');
    expect(warning.existingInstanceIds).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('alice-secret');
    expect(warning.message).not.toMatch(/pass instanceId/);
  });

  it("leaves out an instance someone else owns, even when the caller's mention pulled it into their pod", async () => {
    expect((await install(alice, alicePod._id, { instanceId: 'alice-bot' })).status).toBe(200);
    // What agentMentionService writes when Bob @mentions helper:alice-bot in
    // his own pod: a row naming Bob as installedBy, and Bob as no owner.
    await AgentInstallation.collection.insertOne({
      agentName: AGENT, instanceId: 'alice-bot', podId: bobPod._id, installedBy: bob._id,
      version: '1.0.0', status: 'active', createdAt: new Date(),
      config: { heartbeat: { enabled: false }, autoJoinSource: 'mention-resolution' },
      scopes: ['context:read'], displayName: AGENT,
    });

    const res = await install(bob, bobPod._id, { displayName: 'Bravo' });
    expect(res.status).toBe(200);
    const warning = identityWarning(res);
    expect(warning).toBeDefined();
    expect(warning.instanceId).toBe('bravo');
    expect(warning.existingInstanceIds).toBeUndefined();
    expect(warning.message).not.toContain('alice-bot');
  });

  it('names a bot User the caller owns with no install row, never one another person owns', async () => {
    const type = AgentIdentityService.resolveAgentType(AGENT);
    const ownedBot = (instanceId, owner) => User.create({
      username: AgentIdentityService.buildAgentUsername(type, instanceId),
      email: `${instanceId}@agents.test.invalid`,
      password: 'password123',
      isBot: true,
      botMetadata: { agentName: type, instanceId, ownerUserId: String(owner._id) },
    });
    await ownedBot('alice-own', alice);
    await ownedBot('bob-own', bob);

    const res = await install(alice, alicePod._id, { displayName: 'Fresh' });
    expect(res.status).toBe(200);
    const warning = identityWarning(res);
    expect(warning).toBeDefined();
    expect(warning.instanceId).toBe('fresh');
    expect(warning.existingInstanceIds).toEqual(['alice-own']);
    expect(warning.message).toContain("pass instanceId 'alice-own'");
    expect(JSON.stringify(res.body)).not.toContain('bob-own');
  });

  // Each fixture below is dropped by exactly one filter in callerInstanceIds,
  // so removing that filter fails exactly that test. Alice's 'default' install
  // keeps the hint non-empty, so the toEqual is never vacuous.

  it('leaves out an instance the caller only reached by a mention, with no other owner', async () => {
    expect((await install(alice, alicePod._id, { instanceId: 'default' })).status).toBe(200);
    await rawRow(alice, alicePod, 'mention-only', {
      config: { heartbeat: { enabled: false }, autoJoinSource: 'mention-resolution' },
    });

    const res = await install(alice, alicePod._id, { displayName: 'Fresh' });
    expect(res.status).toBe(200);
    expect(identityWarning(res).existingInstanceIds).toEqual(['default']);
  });

  it("leaves out an instance another person's install row owns, with no bot User", async () => {
    expect((await install(alice, alicePod._id, { instanceId: 'default' })).status).toBe(200);
    await rawRow(alice, alicePod, 'foreign-row');
    await rawRow(bob, bobPod, 'foreign-row');

    const res = await install(alice, alicePod._id, { displayName: 'Fresh' });
    expect(res.status).toBe(200);
    expect(identityWarning(res).existingInstanceIds).toEqual(['default']);
  });

  it('leaves out an instance whose bot User another person owns, with no foreign row', async () => {
    expect((await install(alice, alicePod._id, { instanceId: 'default' })).status).toBe(200);
    await rawRow(alice, alicePod, 'foreign-bot');
    await botUser('foreign-bot', bob);

    const res = await install(alice, alicePod._id, { displayName: 'Fresh' });
    expect(res.status).toBe(200);
    expect(identityWarning(res).existingInstanceIds).toEqual(['default']);
  });

  it('never names an instance id equal to the agent name, which /install would turn into default', async () => {
    // The add-to-pod path can persist this id; an explicit one on /install is
    // rewritten to 'default', so following the hint would bind another agent.
    await rawRow(alice, alicePod, AGENT);

    const res = await install(alice, alicePod._id, { displayName: 'Fresh' });
    expect(res.status).toBe(200);
    const warning = identityWarning(res);
    expect(warning).toBeDefined();
    expect(warning.existingInstanceIds).toBeUndefined();
    expect(warning.message).not.toContain(`'${AGENT}'`);
  });

  it('a failed identity lookup still installs, and says only that it could not tell', async () => {
    expect((await install(alice, alicePod._id, { instanceId: 'default' })).status).toBe(200);
    installInstanceId.identityInUse.mockRejectedValueOnce(new Error('lookup down'));

    const res = await install(alice, alicePod._id, { displayName: 'Fresh' });
    expect(res.status).toBe(200);
    expect(res.body.installation.instanceId).toBe('fresh');
    // Never claims a new identity, and offers no unchecked reuse hint.
    expect(identityWarning(res)).toBeUndefined();
    const notice = (res.body.warnings || []).find((w) => w.code === 'agent_identity_unchecked');
    expect(notice).toBeDefined();
    expect(notice.instanceId).toBe('fresh');
    expect(notice.existingInstanceIds).toBeUndefined();
    expect(notice.message).toMatch(/could not confirm/i);
    expect(notice.message).not.toMatch(/created a new agent identity/);
    expect(notice.message).not.toMatch(/pass instanceId/);
  });
});
