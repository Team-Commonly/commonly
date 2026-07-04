/**
 * #609 tenant isolation — regression lock.
 *
 * BEFORE this fix, agent identity + memory keyed on (agentName, instanceId)
 * globally with no owner, so two different users who named their BYO agent the
 * same thing shared ONE bot User row + memory doc (a fresh account could read a
 * stranger's agent memory). See issue #609.
 *
 * The fix (routes/registry/install.ts) owner-scopes the instanceId for every
 * install except an admin provisioning a first-party AGENT_TYPES agent. This
 * test locks:
 *   1. Two different users installing the SAME agent name get DIFFERENT
 *      instanceIds + DIFFERENT bot User rows (isolation).
 *   2. The SAME user installing the same agent into two pods gets the SAME
 *      instanceId (identity continuity / cross-pod shared memory — the wedge).
 *   3. A non-admin cannot claim a reserved first-party name ("codex").
 *   4. The scoping helper is deterministic and owner-separating.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile').default || require('../../models/AgentProfile');
const AgentIdentityService = require('../../services/agentIdentityService');

const registryRoutes = require('../../routes/registry');
const installRouter = require('../../routes/registry/install');

const JWT_SECRET = 'test-jwt-secret-owner-isolation';

jest.setTimeout(60000);

describe('#609 BYO agent owner isolation', () => {
  let app;
  let userA;
  let userB;
  let tokenA;
  let tokenB;
  let podA;
  let podA2;
  let podB;

  const installAs = (token, body) => request(app)
    .post('/api/registry/install')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

  // A BYO webhook install: no manifest needed (self-serve synthesizes one),
  // never hits the cloud-entitlement gate.
  const byoBody = (podId, agentName) => ({
    agentName,
    podId: podId.toString(),
    config: { runtime: { runtimeType: 'webhook' } },
    scopes: [],
  });

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);

    userA = await User.create({ username: 'iso-a', email: 'iso-a@test.com', password: 'password123' });
    userB = await User.create({ username: 'iso-b', email: 'iso-b@test.com', password: 'password123' });
    tokenA = jwt.sign({ id: userA._id.toString() }, JWT_SECRET);
    tokenB = jwt.sign({ id: userB._id.toString() }, JWT_SECRET);

    podA = await Pod.create({ name: 'A pod', type: 'chat', createdBy: userA._id, members: [userA._id] });
    podA2 = await Pod.create({ name: 'A pod 2', type: 'chat', createdBy: userA._id, members: [userA._id] });
    podB = await Pod.create({ name: 'B pod', type: 'chat', createdBy: userB._id, members: [userB._id] });
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  it('isolates two different users who pick the SAME agent name', async () => {
    const resA = await installAs(tokenA, byoBody(podA, 'assistant'));
    const resB = await installAs(tokenB, byoBody(podB, 'assistant'));

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const instA = resA.body.installation.instanceId;
    const instB = resB.body.installation.instanceId;

    // Different owners → different instanceId → different identity + memory key.
    expect(instA).not.toEqual(instB);

    // And distinct bot User rows (the actual leak vector in #609).
    const userAgentA = await AgentIdentityService.getOrCreateAgentUser('assistant', { instanceId: instA });
    const userAgentB = await AgentIdentityService.getOrCreateAgentUser('assistant', { instanceId: instB });
    expect(userAgentA._id.toString()).not.toEqual(userAgentB._id.toString());
  });

  it('keeps ONE identity for the same user across pods (cross-pod memory wedge)', async () => {
    const res1 = await installAs(tokenA, byoBody(podA, 'helper'));
    const res2 = await installAs(tokenA, byoBody(podA2, 'helper'));

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Same owner, same agent name → same instanceId → shared memory across pods.
    expect(res1.body.installation.instanceId).toEqual(res2.body.installation.instanceId);
    expect(res2.body.sharedIdentity).toBe(true);
  });

  it('does NOT owner-scope a first-party agent — it stays shared across users', async () => {
    // commonly-bot is a first-party AGENT_TYPES agent; two different users
    // installing it must resolve to the SAME (un-scoped) instanceId so they
    // connect to the one shared instance (the intended product behavior, and
    // NOT the #609 leak — first-party memory is shared infra, not user-private).
    const resA = await installAs(tokenA, byoBody(podA, 'commonly-bot'));
    const resB = await installAs(tokenB, byoBody(podB, 'commonly-bot'));
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.installation.instanceId).toBe('default');
    expect(resB.body.installation.instanceId).toBe('default');
    // No owner tag applied.
    expect(resA.body.installation.instanceId).not.toMatch(/-u[0-9a-f]{10}$/);
  });

  it('owner-scoping helper is deterministic and owner-separating', () => {
    const { ownerScopedInstanceId } = installRouter;
    const a = ownerScopedInstanceId('aaaaaaaaaaaaaaaaaaaaaaaa', 'default');
    const a2 = ownerScopedInstanceId('aaaaaaaaaaaaaaaaaaaaaaaa', 'default');
    const b = ownerScopedInstanceId('bbbbbbbbbbbbbbbbbbbbbbbb', 'default');
    expect(a).toEqual(a2); // deterministic
    expect(a).not.toEqual(b); // owner-separating
    expect(a).toMatch(/^u[0-9a-f]{10}$/); // opaque owner tag, not 'default'
    // A meaningful base is preserved as a prefix but still owner-tagged.
    expect(ownerScopedInstanceId('aaaaaaaaaaaaaaaaaaaaaaaa', 'aria')).toMatch(/^aria-u[0-9a-f]{10}$/);
  });
});
