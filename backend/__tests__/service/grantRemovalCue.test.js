/**
 * F181: after a person revokes their agent's connector grant, or takes the agent
 * off it, the agent's next mention carries one inline line saying the access
 * was removed and there is nothing to reconnect. Without it a seat that reloads
 * without the tool tells the person to reconnect the grant broker.
 *
 * Real mongod: the claims are about what the grant row carries between a
 * revoke and the mention builds that read it, including two builds racing for one
 * note, which a mocked model cannot show.
 */
process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

jest.mock('../../middleware/auth', () => (req, res, next) => {
  const id = req.get('x-test-user');
  if (!id) return res.status(401).json({ error: 'unauthorized' });
  req.user = { id };
  req.userId = id;
  return next();
});

const express = require('express');
const request = require('supertest');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');
const { GRANT_BROKER_ID } = require('../../services/installable/toolInstallables');

const model = (m) => m.default || m;
const User = model(require('../../models/User'));
const Pod = model(require('../../models/Pod'));
const RoomGrant = model(require('../../models/RoomGrant'));
const AgentEvent = model(require('../../models/AgentEvent'));
const AgentEventService = model(require('../../services/agentEventService'));
const grantRoutes = model(require('../../routes/grants'));
const { revokeConnectionGrants } = require('../../services/roomGrantService');

jest.setTimeout(60000);

const LINEAR_CUE = '[access: Linear access was removed by its owner. '
  + 'There is nothing to reconnect; ask them if you need it again.]';
const CUE = '[access: GitHub access was removed by its owner. '
  + 'There is nothing to reconnect; ask them if you need it again.]';

let app;
let seq = 0;

const makeUser = (extra = {}) => {
  seq += 1;
  return User.create({
    username: `u${seq}${Date.now() % 1e5}`, email: `u${seq}${Date.now()}@x.com`, password: 'x'.repeat(12), ...extra,
  });
};

const makeBot = (agentName) => makeUser({
  isBot: true, botType: 'agent', botMetadata: { agentName, instanceId: 'default' },
});

const seed = async () => {
  const owner = await makeUser();
  const seat = await makeBot('quill');
  const other = await makeBot('wren');
  const pod = await Pod.create({ name: `p${seq}`, createdBy: owner._id, members: [owner._id, seat._id, other._id] });
  return {
    owner, seat, other, pod,
  };
};

let grantSeq = 0;
const githubGrant = ({ owner, pod }, audience, extra = {}) => {
  grantSeq += 1;
  return RoomGrant.create({
    grantId: `grant_f181_${grantSeq}`,
    connectionId: 'conn-private-acme',
    installationId: 'gh-install-acme-secret-repo',
    brokerId: GRANT_BROKER_ID,
    target: { kind: 'pod', id: String(pod._id) },
    tools: ['github.list_issues'],
    writeMode: 'read',
    audience: audience.map(String),
    ownerId: String(owner._id),
    expiresAt: new Date(Date.now() + 3600000),
    revokedAt: null,
    ...extra,
  });
};

const named = (owner, agent) => ({
  byoAgents: [String(agent._id)],
  byoConsent: {
    by: String(owner._id),
    at: new Date(),
    version: 'byo-v1',
    agents: [{ userId: String(agent._id), sandbox: 'confined' }],
  },
});

const mention = async (agentName, pod, text = `@${agentName} can you check the issues?`, extra = {}) => {
  const event = await AgentEventService.enqueue({
    agentName, instanceId: 'default', podId: pod._id, type: 'chat.mention', payload: { content: text }, ...extra,
  });
  return (await AgentEvent.findById(event._id).lean()).payload.content;
};

const revoke = (grant, owner) => request(app)
  .post(`/api/grants/${grant.grantId}/revoke`).set('x-test-user', String(owner._id));

describe('F181: a removed connector is cued on the agent\'s next mention', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await RoomGrant.init();
    app = express();
    app.use(express.json());
    app.use('/api/grants', grantRoutes);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await clearMongoDb();
  });
  afterAll(closeMongoDb);

  test('revoke: the next mention carries the cue once, naming only the connector', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id]);
    expect((await revoke(grant, fixture.owner)).status).toBe(200);

    const first = await mention('quill', fixture.pod);
    expect(first.startsWith(`${CUE}\n\n`)).toBe(true);
    expect(first).not.toMatch(/acme|gh-install|conn-|grant_f181/);

    const second = await mention('quill', fixture.pod);
    expect(second).not.toContain('[access:');
  });

  test('DELETE /:grantId revokes and cues the same way', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id]);
    const res = await request(app).delete(`/api/grants/${grant.grantId}`).set('x-test-user', String(fixture.owner._id));
    expect(res.status).toBe(200);
    expect(await mention('quill', fixture.pod)).toContain(CUE);
  });

  test('an admin revoke does not claim the owner removed it', async () => {
    const fixture = await seed();
    const admin = await makeUser({ role: 'admin' });
    const grant = await githubGrant(fixture, [fixture.seat._id]);
    expect((await revoke(grant, admin)).status).toBe(200);

    const content = await mention('quill', fixture.pod);
    expect(content).toContain('[access: GitHub access was removed. There is nothing to reconnect;');
    expect(content).not.toContain('by its owner');
  });

  test('a grant that had already expired is not cued when revoked later', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id], { expiresAt: new Date(Date.now() - 1000) });
    expect((await revoke(grant, fixture.owner)).status).toBe(200);

    expect(await mention('quill', fixture.pod)).not.toContain('[access:');
  });

  test('a note older than 30 days is dropped unread', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id]);
    expect((await revoke(grant, fixture.owner)).status).toBe(200);
    await RoomGrant.updateOne(
      { grantId: grant.grantId },
      { $set: { 'removalCuePending.0.at': new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } },
    );

    expect(await mention('quill', fixture.pod)).not.toContain('[access:');
  });

  test('a reconnect revoke (cue: false) leaves no note; a plain connection revoke does', async () => {
    const fixture = await seed();
    const rowId = '6a8f6de2a1dccf2e02f31099';
    await githubGrant(fixture, [fixture.seat._id], { connectionId: rowId });
    // The OAuth account-change and key re-paste paths: the owner is reconnecting.
    const owner = String(fixture.owner._id);
    expect(await revokeConnectionGrants({ connection: { _id: rowId }, revokedBy: owner, cue: false })).toBe(1);
    expect(await RoomGrant.countDocuments({ 'removalCuePending.0': { $exists: true } })).toBe(0);
    expect(await mention('quill', fixture.pod)).not.toContain('[access:');

    await githubGrant(fixture, [fixture.seat._id], { connectionId: rowId });
    expect(await revokeConnectionGrants({ connection: { _id: rowId }, revokedBy: owner })).toBe(1);
    expect(await mention('quill', fixture.pod)).toContain(CUE);
  });

  test.each([
    ['already revoked', { revokedAt: new Date() }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ['on another broker', { brokerId: 'some-other-broker' }],
  ])('taking an agent off a grant that is %s writes no note', async (_label, extra) => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id], { ...named(fixture.owner, fixture.seat), ...extra });
    const res = await request(app)
      .delete(`/api/grants/${grant.grantId}/byo-agents/${fixture.seat._id}`)
      .set('x-test-user', String(fixture.owner._id));
    expect(res.status).toBe(200);
    expect(await RoomGrant.countDocuments({ 'removalCuePending.0': { $exists: true } })).toBe(0);
  });

  test('taking an agent off a grant already revoked writes no second note', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id], named(fixture.owner, fixture.seat));
    expect((await revoke(grant, fixture.owner)).status).toBe(200);
    expect(await mention('quill', fixture.pod)).toContain(CUE);

    const res = await request(app)
      .delete(`/api/grants/${grant.grantId}/byo-agents/${fixture.seat._id}`)
      .set('x-test-user', String(fixture.owner._id));
    expect(res.status).toBe(200);
    expect(await mention('quill', fixture.pod)).not.toContain('[access:');
  });

  test('writing a note also clears notes on that grant older than 30 days', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id], {
      removalCuePending: [{
        userId: 'stale-agent',
        seat: 'gone\u0000default',
        byOwner: true,
        at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      }],
    });
    expect((await revoke(grant, fixture.owner)).status).toBe(200);

    const row = await RoomGrant.findOne({ grantId: grant.grantId }).lean();
    expect(row.removalCuePending.map((entry) => entry.userId)).toEqual([String(fixture.seat._id)]);
  });

  test('a failed holds lookup still delivers the cue, and keeps lines already collected', async () => {
    const fixture = await seed();
    const github = await githubGrant(fixture, [fixture.seat._id]);
    const linear = await githubGrant(fixture, [fixture.seat._id], { tools: ['linear.list_issues'] });
    expect((await revoke(github, fixture.owner)).status).toBe(200);
    expect((await revoke(linear, fixture.owner)).status).toBe(200);
    // Only the "does it hold this connector again" lookup for Linear fails.
    const failsForLinear = (original) => function lookup(filter, ...rest) {
      if (String(filter?.tools?.$regex || '').startsWith('^linear')) throw new Error('lookup failed');
      return original.call(this, filter, ...rest);
    };
    const { exists, find } = RoomGrant;
    jest.spyOn(RoomGrant, 'exists').mockImplementation(failsForLinear(exists));
    jest.spyOn(RoomGrant, 'find').mockImplementation(failsForLinear(find));

    const content = await mention('quill', fixture.pod);
    expect(content).toContain(CUE);
    expect(content).toContain(LINEAR_CUE);
  });

  test('a live grant in a pod the agent has left does not hide the cue', async () => {
    const fixture = await seed();
    const elsewhere = await Pod.create({
      name: `left${seq}`, createdBy: fixture.owner._id, members: [fixture.owner._id],
    });
    // Grant B is live and its audience snapshot still lists quill, but quill left that pod.
    await githubGrant({ owner: fixture.owner, pod: elsewhere }, [fixture.seat._id]);
    const grant = await githubGrant(fixture, [fixture.seat._id]);
    expect((await revoke(grant, fixture.owner)).status).toBe(200);

    expect(await mention('quill', fixture.pod)).toContain(CUE);
  });

  test('a live seat-target grant on the connector still counts as holding it', async () => {
    const fixture = await seed();
    await githubGrant(fixture, [fixture.seat._id], { target: { kind: 'seat', id: String(fixture.seat._id) } });
    const grant = await githubGrant(fixture, [fixture.seat._id]);
    expect((await revoke(grant, fixture.owner)).status).toBe(200);

    expect(await mention('quill', fixture.pod)).not.toContain('[access:');
  });

  test('a digest mention leaves the note for the next wake mention', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id]);
    expect((await revoke(grant, fixture.owner)).status).toBe(200);

    expect(await mention('quill', fixture.pod, 'folded later', { deliveryMode: 'digest' })).not.toContain('[access:');
    expect(await RoomGrant.countDocuments({ 'removalCuePending.0': { $exists: true } })).toBe(1);
    expect(await mention('quill', fixture.pod)).toContain(CUE);
  });

  test('a thread mention carries the cue too', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id]);
    expect((await revoke(grant, fixture.owner)).status).toBe(200);

    const event = await AgentEventService.enqueue({
      agentName: 'quill',
      instanceId: 'default',
      podId: fixture.pod._id,
      type: 'thread.mention',
      payload: { content: 'in a thread' },
    });
    expect((await AgentEvent.findById(event._id).lean()).payload.content.startsWith(`${CUE}\n\n`)).toBe(true);
  });

  test('an audience agent that left the pod before the revoke gets no note', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id, fixture.other._id]);
    await Pod.updateOne({ _id: fixture.pod._id }, { $pull: { members: fixture.other._id } });
    expect((await revoke(grant, fixture.owner)).status).toBe(200);

    expect(await RoomGrant.countDocuments({ 'removalCuePending.userId': String(fixture.other._id) })).toBe(0);
    expect(await RoomGrant.countDocuments({ 'removalCuePending.userId': String(fixture.seat._id) })).toBe(1);
  });

  test('a failure writing the note does not fail the revoke', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id]);
    jest.spyOn(User, 'find').mockImplementation(() => { throw new Error('users unavailable'); });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    expect((await revoke(grant, fixture.owner)).status).toBe(200);
    expect((await RoomGrant.findOne({ grantId: grant.grantId }).lean()).revokedAt).toBeTruthy();
  });

  test('a failure writing the note does not fail taking the agent off a grant', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id], named(fixture.owner, fixture.seat));
    jest.spyOn(User, 'find').mockImplementation(() => { throw new Error('users unavailable'); });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app)
      .delete(`/api/grants/${grant.grantId}/byo-agents/${fixture.seat._id}`)
      .set('x-test-user', String(fixture.owner._id));
    expect(res.status).toBe(200);
    expect((await RoomGrant.findOne({ grantId: grant.grantId }).lean()).audience).toEqual([]);
  });

  test('the pending note is not part of a grant read', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id], named(fixture.owner, fixture.seat));
    await request(app)
      .delete(`/api/grants/${grant.grantId}/byo-agents/${fixture.seat._id}`)
      .set('x-test-user', String(fixture.owner._id));
    expect(await RoomGrant.countDocuments({ 'removalCuePending.0': { $exists: true } })).toBe(1);

    const res = await request(app).get(`/api/grants/${grant.grantId}`).set('x-test-user', String(fixture.owner._id));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('removalCuePending');
  });

  test('remove: taking the agent off a grant cues that agent once', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id], named(fixture.owner, fixture.seat));
    const res = await request(app)
      .delete(`/api/grants/${grant.grantId}/byo-agents/${fixture.seat._id}`)
      .set('x-test-user', String(fixture.owner._id));
    expect(res.status).toBe(200);

    expect(await mention('quill', fixture.pod)).toContain(CUE);
    expect(await mention('quill', fixture.pod)).not.toContain('[access:');
  });

  test('re-grant before the next mention: no cue', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id]);
    expect((await revoke(grant, fixture.owner)).status).toBe(200);
    await githubGrant(fixture, [fixture.seat._id]);

    expect(await mention('quill', fixture.pod)).not.toContain('[access:');
    // The note was consumed, not left to fire after the new grant ends.
    expect(await RoomGrant.countDocuments({ 'removalCuePending.0': { $exists: true } })).toBe(0);
  });

  test('a different agent gets no cue, in the same pod, for a grant it never held', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id]);
    expect((await revoke(grant, fixture.owner)).status).toBe(200);

    expect(await mention('wren', fixture.pod)).not.toContain('[access:');
    // And reading wren's mention did not consume quill's note.
    expect(await mention('quill', fixture.pod)).toContain(CUE);
  });

  test('removing one agent from a shared grant cues only that agent', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id, fixture.other._id], named(fixture.owner, fixture.seat));
    const res = await request(app)
      .delete(`/api/grants/${grant.grantId}/byo-agents/${fixture.seat._id}`)
      .set('x-test-user', String(fixture.owner._id));
    expect(res.status).toBe(200);

    // wren still holds the grant, so nothing was written for it at all.
    expect(await RoomGrant.countDocuments({ 'removalCuePending.userId': String(fixture.other._id) })).toBe(0);
    expect(await mention('wren', fixture.pod)).not.toContain('[access:');
    expect(await mention('quill', fixture.pod)).toContain(CUE);
  });

  test('revoking a grant two agents held cues each of them, once', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id, fixture.other._id]);
    expect((await revoke(grant, fixture.owner)).status).toBe(200);

    // quill's mention claims only quill's note, leaving wren's in place.
    expect(await mention('quill', fixture.pod)).toContain(CUE);
    expect(await mention('wren', fixture.pod)).toContain(CUE);
    expect(await mention('wren', fixture.pod)).not.toContain('[access:');
  });

  test('two concurrent mention builds produce exactly one cue', async () => {
    const fixture = await seed();
    const grant = await githubGrant(fixture, [fixture.seat._id]);
    expect((await revoke(grant, fixture.owner)).status).toBe(200);

    const contents = await Promise.all([
      mention('quill', fixture.pod, 'one'),
      mention('quill', fixture.pod, 'two'),
      mention('quill', fixture.pod, 'three'),
    ]);
    expect(contents.filter((content) => content.includes(CUE))).toHaveLength(1);
  });
});
