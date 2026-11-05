/**
 * F164 (TASK-781, D244): installing a seat into a pod an outsider-writable
 * grant reaches confines its writes everywhere else (agentRuntimeAuth, 403
 * outsider_grant_runtime_narrowed). The install now says so first, naming only
 * the pods the installer can see, and the owner's settings carry the same fact.
 *
 * Real Pod, RoomGrant, Integration, AgentInstallation and User rows on memory
 * Mongo, the real install route, and the real runtime guard: the claim under
 * test is that the warning and the guard agree, and a mocked census would only
 * agree with itself.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const RoomGrant = require('../../models/RoomGrant');
const Integration = require('../../models/Integration');
const { GRANT_BROKER_ID } = require('../../services/installable/toolInstallables');
const { previewInstallNarrowing } = require('../../services/outsiderGrantNarrowingPreview');

const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');

const JWT_SECRET = 'test-jwt-secret';
const model = (m) => m.default || m;
const SEAT = 'my-lead';

jest.setTimeout(60000);

describe('install-time warning for the outsider-grant narrowing', () => {
  let app;
  let owner;
  let stranger;
  let ownerToken;
  let hq;
  let secret;
  let target;
  let plain;
  let connection;

  const install = (podId, extra = {}) => request(app)
    .post('/api/registry/install')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      agentName: SEAT,
      instanceId: 'default',
      podId: String(podId),
      config: { runtime: { runtimeType: 'webhook' } },
      scopes: ['context:read', 'messages:write'],
      ...extra,
    });

  const seatUser = () => User.findOne({ isBot: true, 'botMetadata.agentName': SEAT }).lean();

  // A live hosted-MCP grant on `pod` whose audience is the seat alone: the pod
  // is reached only once the seat joins, so the join policy lets it in.
  const grantReachingSeatIn = async (pod) => {
    const bot = await seatUser();
    return model(RoomGrant).create({
      grantId: `f164-${String(new mongoose.Types.ObjectId())}`,
      connectionId: String(connection._id),
      installationId: 'f164',
      target: { kind: 'pod', id: String(pod._id) },
      audience: [String(bot._id)],
      tools: ['linear.list_issues'],
      writeMode: 'read',
      expiresAt: new Date(Date.now() + 86400000),
      brokerId: GRANT_BROKER_ID,
    });
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);
    owner = await User.create({ username: 'f164-owner', email: 'f164-owner@test.com', password: 'password123' });
    stranger = await User.create({ username: 'f164-stranger', email: 'f164-stranger@test.com', password: 'password123' });
    ownerToken = jwt.sign({ id: String(owner._id) }, JWT_SECRET);
  });

  afterAll(closeMongoDb);

  beforeEach(async () => {
    await Promise.all([
      AgentInstallation.deleteMany({}), AgentRegistry.deleteMany({ ephemeral: true }),
      model(RoomGrant).deleteMany({}), model(Integration).deleteMany({}),
      Pod.deleteMany({}), User.deleteMany({ isBot: true }),
    ]);
    const pod = (name, members) => Pod.create({
      name, type: 'chat', createdBy: members[0], members, 
    });
    hq = await pod('Team HQ', [owner._id]);
    secret = await pod('Secret Plans', [owner._id, stranger._id]);
    target = await pod('Sentry Triage', [owner._id]);
    plain = await pod('Plain Pod', [owner._id]);
    connection = await model(Integration).create({
      type: 'hosted-mcp',
      scope: 'user',
      status: 'connected',
      createdBy: owner._id,
      config: { entryId: 'linear', intake: 'oauth', credentialRef: 'f164-ref' },
    });
    // The seat writes in Team HQ and Secret Plans today. The owner then leaves
    // Secret Plans, so that pod is one the installer can no longer see.
    expect((await install(hq._id)).status).toBe(200);
    expect((await install(secret._id)).status).toBe(200);
    await Pod.updateOne({ _id: secret._id }, { $pull: { members: owner._id } });
  });

  it('names the visible pods the seat would lose writes in, counts the hidden one, and writes nothing', async () => {
    await grantReachingSeatIn(target);

    const res = await install(target._id);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('outsider_grant_narrowing_confirm_required');
    expect(res.body.narrowing).toEqual({
      code: 'outsider_grant_runtime_narrowed',
      losesWrites: [{ podId: String(hq._id), name: 'Team HQ' }],
      hiddenLosesWritesCount: 1,
      targetWritable: true,
    });
    expect(res.body.message).toContain('Team HQ');
    expect(res.body.message).toContain('1 other pod');
    // A pod the installer cannot see is a count, never a name or an id.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Secret Plans');
    expect(body).not.toContain(String(secret._id));
    // The refusal came before any write.
    expect(await AgentInstallation.countDocuments({ podId: target._id })).toBe(0);
    const bot = await seatUser();
    expect((await Pod.findById(target._id).lean()).members.map(String)).not.toContain(String(bot._id));
  });

  it('agrees with the runtime guard: after a confirmed install, the named pod refuses the seat\'s writes', async () => {
    const tokenRes = await request(app)
      .post(`/api/registry/pods/${hq._id}/agents/${SEAT}/runtime-tokens`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ label: 'f164' });
    const runtimeToken = tokenRes.body.token;
    expect(runtimeToken).toMatch(/^cm_agent_/);
    const typing = (pod) => request(app)
      .post(`/api/agents/runtime/pods/${pod._id}/typing`)
      .set('Authorization', `Bearer ${runtimeToken}`)
      .send({ action: 'stop' });

    expect((await typing(hq)).status).toBe(200);
    await grantReachingSeatIn(target);

    const confirmed = await install(target._id, { confirmNarrowing: true });
    expect(confirmed.status).toBe(200);

    const refused = await typing(hq);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('outsider_grant_runtime_narrowed');
    expect((await typing(target)).status).toBe(200);

    // The owner's settings read the same fact in a form they can act on.
    const settings = await request(app)
      .get(`/api/registry/agents/${SEAT}/manage-settings?instanceId=default`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(settings.status).toBe(200);
    expect(settings.body.runtimeNarrowing).toEqual({
      code: 'outsider_grant_runtime_narrowed',
      narrowedPodCount: 1,
      writablePod: { podId: String(target._id), name: 'Sentry Triage' },
      writablePodHidden: false,
    });
  });

  it('installs without a warning when no outsider-writable grant reaches the target', async () => {
    const res = await install(plain._id);
    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
    const settings = await request(app)
      .get(`/api/registry/agents/${SEAT}/manage-settings?instanceId=default`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(settings.body.runtimeNarrowing).toBeNull();
  });

  it('warns when a seat-targeted grant would leave the seat writing nowhere, the target included', async () => {
    // A grant on the seat itself reaches every pod it is in. In one pod it
    // writes there; in two it writes in neither.
    await Pod.updateOne({ _id: secret._id }, { $addToSet: { members: owner._id } });
    await AgentInstallation.deleteMany({ podId: secret._id });
    const bot = await seatUser();
    await model(RoomGrant).create({
      grantId: 'f164-seat-grant',
      connectionId: String(connection._id),
      installationId: 'f164',
      target: { kind: 'seat', id: String(bot._id) },
      audience: [String(bot._id)],
      tools: ['linear.list_issues'],
      writeMode: 'read',
      expiresAt: new Date(Date.now() + 86400000),
      brokerId: GRANT_BROKER_ID,
    });

    const res = await install(plain._id);

    expect(res.status).toBe(409);
    expect(res.body.narrowing).toEqual({
      code: 'outsider_grant_runtime_narrowed',
      losesWrites: [{ podId: String(hq._id), name: 'Team HQ' }],
      hiddenLosesWritesCount: 0,
      targetWritable: false,
    });
  });

  it('reports unavailable, not clear, when the grant lookup fails, since the guard refuses every write then', async () => {
    // Through the route the join policy reads grants first and fails closed
    // on the same outage, so the preview's own failure path is checked here.
    await grantReachingSeatIn(target);
    const spy = jest.spyOn(model(RoomGrant), 'find').mockImplementation(() => { throw new Error('census down'); });
    try {
      const result = await previewInstallNarrowing({
        agentName: SEAT, instanceId: 'default', targetPodId: String(target._id), viewerId: owner._id, runtimeType: 'webhook',
      });
      expect(result).toEqual({ status: 'unavailable' });
    } finally {
      spy.mockRestore();
    }
  });

  it('still loads the owner\'s settings when the pod-name lookup fails, naming no pod', async () => {
    await grantReachingSeatIn(target);
    expect((await install(target._id, { confirmNarrowing: true })).status).toBe(200);
    // Fail only the narrowing notice's name lookup, not the page's own reads.
    const realFind = Pod.find.bind(Pod);
    const spy = jest.spyOn(Pod, 'find').mockImplementation((query, ...rest) => {
      const q = realFind(query, ...rest);
      const realSelect = q.select.bind(q);
      q.select = (fields) => {
        if (String(fields) === '_id name type members') throw new Error('pod lookup down');
        return realSelect(fields);
      };
      return q;
    });
    try {
      const settings = await request(app)
        .get(`/api/registry/agents/${SEAT}/manage-settings?instanceId=default`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(settings.status).toBe(200);
      expect(settings.body.runtimeNarrowing).toEqual({
        code: 'outsider_grant_runtime_narrowed',
        narrowedPodCount: 1,
        writablePod: null,
        writablePodHidden: true,
      });
    } finally {
      spy.mockRestore();
    }
  });

  const previewNative = () => previewInstallNarrowing({
    agentName: SEAT,
    instanceId: 'default',
    targetPodId: String(target._id),
    viewerId: owner._id,
    runtimeType: 'native',
  });

  it('still warns for an in-process install when the identity\'s other installs hold a runtime token', async () => {
    // The guard takes its census over every active install of the identity, so
    // a token held by the webhook installs is narrowed whatever runs the new one.
    await grantReachingSeatIn(target);
    const result = await previewNative();
    expect(result.status).toBe('warn');
    expect(result.preview.losesWrites).toEqual([{ podId: String(hq._id), name: 'Team HQ' }]);
  });

  it('still warns when every install runs in-process but the identity kept a runtime token', async () => {
    // Uninstalling the last webhook install leaves the token while a native
    // install remains; that token still authenticates and meets the guard.
    const tokenRes = await request(app)
      .post(`/api/registry/pods/${hq._id}/agents/${SEAT}/runtime-tokens`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ label: 'f164-kept' });
    expect(tokenRes.body.token).toMatch(/^cm_agent_/);
    await grantReachingSeatIn(target);
    await AgentInstallation.updateMany({}, { $set: { 'config.runtime.runtimeType': 'native' } });

    const result = await previewNative();
    expect(result.status).toBe('warn');

    // Once joined, the owner's settings still show the narrowing that token meets.
    await AgentInstallation.updateMany({}, { $set: { 'config.runtime.runtimeType': 'webhook' } });
    expect((await install(target._id, { confirmNarrowing: true })).status).toBe(200);
    await AgentInstallation.updateMany({}, { $set: { 'config.runtime.runtimeType': 'native' } });
    const settings = await request(app)
      .get(`/api/registry/agents/${SEAT}/manage-settings?instanceId=default`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(settings.body.runtimeNarrowing).toMatchObject({ code: 'outsider_grant_runtime_narrowed' });
  });

  it('is clear when the new install and every current one run in Commonly\'s process, which holds no token', async () => {
    await grantReachingSeatIn(target);
    await AgentInstallation.updateMany({}, { $set: { 'config.runtime.runtimeType': 'native' } });
    expect(await previewNative()).toEqual({ status: 'clear' });
  });
});
