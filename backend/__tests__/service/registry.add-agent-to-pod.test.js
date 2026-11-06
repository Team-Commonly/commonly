// POST /api/registry/agents/:name/pods/:podId: an owner puts an agent they
// already run into another pod they belong to. Real mongod, because every claim
// here is about which rows a query reaches and what the shared install path
// writes. PG is unset, so the mirror write is observed at its seam.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../services/outsiderGrantNarrowingPreview', () => {
  const actual = jest.requireActual('../../services/outsiderGrantNarrowingPreview');
  return { ...actual, previewInstallNarrowing: jest.fn(actual.previewInstallNarrowing) };
});
jest.mock('../../services/outsiderGrantAgentJoinPolicy', () => {
  const actual = jest.requireActual('../../services/outsiderGrantAgentJoinPolicy');
  return { ...actual, assertAgentRuntimeMayJoinPod: jest.fn(actual.assertAgentRuntimeMayJoinPod) };
});

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentMemory = require('../../models/AgentMemory').default || require('../../models/AgentMemory');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');
const DMService = require('../../services/dmService');
const pgMirrorWrite = require('../../services/pgMirrorWrite');
const { previewInstallNarrowing } = require('../../services/outsiderGrantNarrowingPreview');
const { assertAgentRuntimeMayJoinPod } = require('../../services/outsiderGrantAgentJoinPolicy');
const registryRoutes = require('../../routes/registry');

const SECRET = 'add-agent-to-pod-test';
// A fresh name per test: an install's best-effort tail (intro post, first
// contact) can outlive its test and write the bot row back after the cleanup.
let NAME;
let nameSeq = 0;

jest.setTimeout(60000);

describe('adding an existing agent to another pod', () => {
  let app; let owner; let stranger; let admin; let home; let target;
  let userSeq = 0;
  const saved = {};

  const person = (extra = {}) => {
    userSeq += 1;
    return User.create({
      username: `add-pod-user-${userSeq}`, email: `add-pod-${userSeq}@test.invalid`, password: 'password123', ...extra,
    });
  };
  const bearer = (user) => `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`;
  const pod = (name, members, extra = {}) => Pod.create({
    name, type: 'chat', createdBy: members[0], members, ...extra,
  });
  const add = (user, podId, { name = NAME, instanceId, body } = {}) => {
    const req = request(app).post(`/api/registry/agents/${name}/pods/${podId}`)
      .set('Authorization', bearer(user));
    if (instanceId) req.query({ instanceId });
    return body ? req.send(body) : req.send();
  };
  const install = (user, podId, config, extra = {}) => request(app).post('/api/registry/install')
    .set('Authorization', bearer(user))
    .send({ agentName: NAME, podId: String(podId), config, scopes: [], ...extra });
  const installByo = async (config = {}, extra = {}) => {
    const res = await install(owner, home._id, { runtime: { runtimeType: 'webhook' }, ...config }, extra);
    expect(res.status).toBe(200);
  };
  const row = (podId, name = NAME, instanceId = 'default') => AgentInstallation.findOne({ agentName: name, podId, instanceId }).lean();
  const bot = (name = NAME, instanceId = 'default') => User.findOne({
    username: AgentIdentityService.buildAgentUsername(name, instanceId), isBot: true,
  }).lean();
  const seedRow = (installedBy, podId, overrides = {}) => AgentInstallation.collection.insertOne({
    agentName: NAME,
    instanceId: 'default',
    podId,
    installedBy,
    version: '1.0.0',
    status: 'active',
    displayName: 'Pod hopper',
    createdAt: new Date(),
    config: { runtime: { runtimeType: 'webhook', host: 'byo' } },
    ...overrides,
  });

  beforeAll(async () => {
    ['JWT_SECRET', 'HOSTED_ENGINE', 'HOSTED_AGENTS_PER_USER', 'PG_HOST'].forEach((key) => { saved[key] = process.env[key]; });
    delete process.env.PG_HOST;
    process.env.JWT_SECRET = SECRET;
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
    nameSeq += 1;
    NAME = `pod-hopper-${nameSeq}`;
    process.env.HOSTED_ENGINE = 'native';
    process.env.HOSTED_AGENTS_PER_USER = '1';
    previewInstallNarrowing.mockClear();
    assertAgentRuntimeMayJoinPod.mockClear();
    await Promise.all([
      AgentInstallation.deleteMany({}), AgentRegistry.deleteMany({}), AgentMemory.deleteMany({}),
      Pod.deleteMany({}), User.deleteMany({}),
    ]);
    owner = await person();
    stranger = await person();
    admin = await person({ role: 'admin' });
    home = await pod('Home', [owner._id]);
    target = await pod('Target', [owner._id, stranger._id, admin._id]);
  });

  describe('the owner adds their agent', () => {
    it('copies what belongs to the agent and keeps the same identity', async () => {
      await installByo({
        autonomy: { enabled: false },
        tools: { allow: ['read'] },
        wakeOnMessage: { enabled: false },
        boardWake: { enabled: true },
        welcomeWake: { enabled: true },
        digestWake: { afterMinutes: 90 },
        heartbeat: { enabled: true, everyMinutes: 30 },
      }, { displayName: 'Pod Hopper', instanceId: 'default', version: '2.3.4' });
      const identity = await bot();
      await User.updateOne({ _id: identity._id }, {
        $push: { agentRuntimeTokens: { tokenHash: 'kept-hash', label: 'seat', createdAt: new Date() } },
      });
      const envelope = await AgentMemory.create({
        agentName: NAME, instanceId: 'default', content: 'something it remembers',
      });
      const memoryBefore = await AgentMemory.collection.findOne({ _id: envelope._id });
      const mirror = jest.spyOn(pgMirrorWrite, 'mirrorMemberAdded');

      const res = await add(owner, target._id);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        sharedIdentity: true,
        otherPods: [String(home._id)],
        installation: {
          agentName: NAME, instanceId: 'default', displayName: 'Pod Hopper', version: '2.3.4', status: 'active',
        },
      });
      const added = await row(target._id);
      const source = await row(home._id);
      expect(added.installedBy).toEqual(owner._id);
      expect(added.version).toBe(source.version);
      expect(added.scopes).toEqual(source.scopes);
      expect(added.config.runtime).toEqual(source.config.runtime);
      expect(added.config.autonomy).toEqual({ enabled: false });
      expect(added.config.tools).toEqual({ allow: ['read'] });
      // A pod's own settings stay in the pod they were set in.
      expect(added.config.heartbeat).toBeUndefined();
      expect(added.config.welcomeWake).toBeUndefined();
      expect(added.config.digestWake).toBeUndefined();
      // Not the source's `enabled: false`: this pod gets a person-brought agent's default.
      expect(added.config.wakeOnMessage).toEqual(expect.objectContaining({ enabled: true, humanOnly: true }));
      expect(added.config.boardWake).toEqual({ enabled: false });

      const after = await bot();
      expect(after._id).toEqual(identity._id);
      expect(after.botMetadata).toEqual({ ...identity.botMetadata, runtimeId: after.botMetadata.runtimeId });
      expect(after.profilePicture).toBe(identity.profilePicture);
      expect(after.username).toBe(identity.username);
      expect(after.agentRuntimeTokens.map((token) => token.tokenHash)).toEqual(['kept-hash']);
      expect(await User.countDocuments({ isBot: true })).toBe(1);
      expect(await AgentMemory.collection.findOne({ _id: envelope._id })).toEqual(memoryBefore);

      const members = (await Pod.findById(target._id).lean()).members.map(String);
      expect(members).toContain(String(identity._id));
      expect(mirror).toHaveBeenCalledWith(String(target._id), String(identity._id));
      mirror.mockRestore();
    });

    it('reads instanceId from the query and leaves other instances alone', async () => {
      await installByo({}, { instanceId: 'second' });
      expect((await add(owner, target._id)).status).toBe(403);
      const res = await add(owner, target._id, { instanceId: 'second' });
      expect(res.status).toBe(200);
      expect(res.body.installation.instanceId).toBe('second');
      expect(await row(target._id, NAME, 'second')).toBeTruthy();
    });

    it('keeps an instance named after its agent, which install maps to default', async () => {
      const seeded = await AgentRegistry.create({
        agentName: NAME,
        displayName: 'Pod hopper',
        description: 'x',
        manifest: {
          name: NAME, version: '1.0.0', description: 'x', capabilities: [], context: { required: [], optional: [] },
          runtime: { type: 'standalone', connection: 'rest' },
        },
        latestVersion: '1.0.0',
        versions: [],
        registry: 'private',
        publisher: { userId: owner._id, name: 'o' },
        ephemeral: true,
      });
      expect(seeded).toBeTruthy();
      await seedRow(owner._id, home._id, { instanceId: NAME });
      const res = await add(owner, target._id, { instanceId: NAME });
      expect(res.status).toBe(200);
      expect(res.body.installation.instanceId).toBe(NAME);
      expect(await row(target._id, NAME, NAME)).toBeTruthy();
      expect(await row(target._id, NAME, 'default')).toBeNull();
    });

    it('lets a pod creator who is not in members add', async () => {
      await installByo();
      const created = await Pod.create({
        name: 'Mine', type: 'chat', createdBy: owner._id, members: [stranger._id],
      });
      expect((await add(owner, created._id)).status).toBe(200);
    });

    it('prefers a row that is not a DM, whichever is older', async () => {
      const room = await pod('Room', [owner._id], { type: 'agent-room' });
      await installByo({ model: 'from-the-pod' });
      await AgentInstallation.collection.insertOne({
        agentName: NAME,
        instanceId: 'default',
        podId: room._id,
        installedBy: owner._id,
        version: '1.0.0',
        status: 'active',
        createdAt: new Date(0),
        config: { runtime: { runtimeType: 'webhook' }, model: 'from-the-dm', autoJoinSource: 'agent-room-create' },
      });
      expect((await add(owner, target._id)).status).toBe(200);
      expect((await row(target._id)).config.model).toBe('from-the-pod');
    });

    it('copies from a DM row only for the publisher, and without what belongs to the DM', async () => {
      await installByo();
      const room = await pod('Room', [owner._id], { type: 'agent-room' });
      await seedRow(owner._id, room._id, {
        config: {
          runtime: { runtimeType: 'webhook', host: 'byo' },
          model: 'kept',
          heartbeat: { enabled: false },
          autoJoinSource: 'agent-room-create',
        },
      });
      await AgentInstallation.deleteOne({ podId: home._id });

      const res = await add(owner, target._id);

      expect(res.status).toBe(200);
      const added = await row(target._id);
      expect(added.config.model).toBe('kept');
      expect(added.config.heartbeat).toBeUndefined();
      expect(added.config.autoJoinSource).toBeUndefined();
    });

    it('refuses a DM-only source with no runtime to copy', async () => {
      await installByo();
      const room = await pod('Room', [owner._id], { type: 'agent-dm' });
      await seedRow(owner._id, room._id, { config: { heartbeat: { enabled: false }, autoJoinSource: 'agent-dm-create' } });
      await AgentInstallation.deleteOne({ podId: home._id });

      const res = await add(owner, target._id);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('agent_source_has_no_runtime');
    });
  });

  describe('who may add', () => {
    beforeEach(() => installByo());

    it('refuses someone with no row of the agent', async () => {
      const res = await add(stranger, target._id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_agent_owner');
      expect(await row(target._id)).toBeNull();
    });

    it('refuses a guest whose only row is their DM with the agent', async () => {
      await DMService.getOrCreateAgentRoom((await bot())._id, stranger._id, { agentName: NAME, instanceId: 'default' });
      const guestRow = await AgentInstallation.findOne({ agentName: NAME, installedBy: stranger._id }).lean();
      expect(guestRow).toBeTruthy();

      const res = await add(stranger, target._id);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_agent_owner');
      expect(await row(target._id)).toBeNull();
    });

    it('refuses someone who only mentioned the agent into a pod', async () => {
      const elsewhere = await pod('Elsewhere', [stranger._id]);
      await seedRow(stranger._id, elsewhere._id, {
        config: { heartbeat: { enabled: false }, autoJoinSource: 'mention-resolution' },
      });
      const res = await add(stranger, target._id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_agent_owner');
    });

    it('gives a global admin nothing beyond an owner: the row would be stamped theirs', async () => {
      const res = await add(admin, target._id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_agent_owner');
      expect(await row(target._id)).toBeNull();
    });

    it('refuses a non-member, and does not say what kind of pod it is', async () => {
      const outside = await pod('Outside', [stranger._id]);
      const room = await pod('Their room', [stranger._id], { type: 'agent-room' });
      const res = await add(owner, outside._id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('pod_membership_required');
      expect(await row(outside._id)).toBeNull();
      expect((await add(owner, room._id)).body.code).toBe('pod_membership_required');
    });

    it('refuses an unknown pod and a malformed pod id with a 404', async () => {
      expect((await add(owner, '507f1f77bcf86cd799439011')).status).toBe(404);
      expect((await add(owner, 'not-an-id')).status).toBe(404);
    });

    it('refuses an agent no row of which is active', async () => {
      await AgentInstallation.updateOne({ podId: home._id }, { status: 'paused' });
      const res = await add(owner, target._id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('agent_not_active');
    });

    it('treats an uninstalled row as no row', async () => {
      await AgentInstallation.updateOne({ podId: home._id }, { status: 'uninstalled' });
      expect((await add(owner, target._id)).body.code).toBe('not_agent_owner');
    });
  });

  describe('where it may go', () => {
    beforeEach(() => installByo());

    it.each(['agent-room', 'agent-dm'])('refuses a %s pod, with no row and no member written', async (type) => {
      const dm = await pod('A DM', [owner._id, stranger._id], { type });
      const res = await add(owner, dm._id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('dm_membership_refused');
      expect(await row(dm._id)).toBeNull();
      expect((await Pod.findById(dm._id).lean()).members).toHaveLength(2);
    });

    it('refuses a community pod for an ordinary member, as install does', async () => {
      const hq = await pod('HQ', [stranger._id, owner._id], { publicRead: true });
      const res = await add(owner, hq._id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('public_pod_requires_admin');
      expect(await row(hq._id)).toBeNull();
    });

    it('refuses an agent already active there, with a code and not a 500', async () => {
      expect((await add(owner, target._id)).status).toBe(200);
      const res = await add(owner, target._id);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'agent_already_in_pod', status: 'active' });
    });

    it('does not undo a pause in the target pod', async () => {
      await seedRow(owner._id, target._id, { status: 'paused' });
      const res = await add(owner, target._id);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'agent_already_in_pod', status: 'paused' });
      expect((await row(target._id)).status).toBe('paused');
    });

    it('answers a double click with one success and one refusal', async () => {
      const results = await Promise.all([add(owner, target._id), add(owner, target._id)]);
      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(results.find((res) => res.status === 409).body.code).toBe('agent_already_in_pod');
      expect(await AgentInstallation.countDocuments({ podId: target._id })).toBe(1);
    });

    it('reactivates a row uninstalled in that pod, keeping its id and label', async () => {
      await request(app).post('/api/registry/install').set('Authorization', bearer(owner)).send({
        agentName: NAME,
        podId: String(target._id),
        instanceId: 'default',
        displayName: 'Curated here',
        config: { runtime: { runtimeType: 'webhook' } },
        scopes: [],
      }).expect(200);
      const first = await row(target._id);
      const removal = await request(app).delete(`/api/registry/agents/${NAME}/pods/${target._id}`)
        .set('Authorization', bearer(owner));
      expect(removal.status).toBe(200);
      expect((await row(target._id)).status).toBe('uninstalled');
      const identity = await bot();
      expect((await Pod.findById(target._id).lean()).members.map(String)).not.toContain(String(identity._id));

      const res = await add(owner, target._id);

      expect(res.status).toBe(200);
      const back = await row(target._id);
      expect(back._id).toEqual(first._id);
      expect(back.status).toBe('active');
      expect(back.displayName).toBe('Curated here');
      expect(await AgentInstallation.countDocuments({ podId: target._id })).toBe(1);
      expect((await Pod.findById(target._id).lean()).members.map(String)).toContain(String(identity._id));
    });
  });

  describe('the refusals install holds', () => {
    it('refuses the name a stranger already holds', async () => {
      await installByo();
      const elsewhere = await pod('Elsewhere', [stranger._id]);
      await seedRow(stranger._id, elsewhere._id);
      const res = await add(stranger, target._id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('agent_name_taken');
      expect(await row(target._id)).toBeNull();
    });

    it('stops at the F164 confirmation, and passes on confirmNarrowing', async () => {
      await installByo();
      const preview = { code: 'outsider_grant_runtime_narrowed', losesWrites: [], hiddenLosesWritesCount: 1, targetWritable: true };
      previewInstallNarrowing.mockResolvedValueOnce({ status: 'warn', preview });
      const refused = await add(owner, target._id);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('outsider_grant_narrowing_confirm_required');
      expect(refused.body.narrowing).toEqual(preview);
      expect(await row(target._id)).toBeNull();
      expect(previewInstallNarrowing).toHaveBeenCalledWith(expect.objectContaining({
        agentName: NAME, instanceId: 'default', targetPodId: String(target._id), viewerId: expect.anything(),
      }));

      previewInstallNarrowing.mockClear();
      const confirmed = await add(owner, target._id, { body: { confirmNarrowing: true } });
      expect(confirmed.status).toBe(200);
      expect(previewInstallNarrowing).not.toHaveBeenCalled();
    });

    it('does not take a truthy confirmNarrowing for a yes', async () => {
      await installByo();
      previewInstallNarrowing.mockResolvedValueOnce({ status: 'unavailable' });
      const res = await add(owner, target._id, { body: { confirmNarrowing: 'yes' } });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('outsider_grant_narrowing_confirm_required');
    });

    it('stops at the outsider-grant join refusal', async () => {
      await installByo();
      assertAgentRuntimeMayJoinPod.mockRejectedValueOnce(Object.assign(new Error('granted pod'), {
        code: 'outsider_grant_non_native_agent_join',
      }));
      const res = await add(owner, target._id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('outsider_grant_non_native_agent_join');
      expect(await row(target._id)).toBeNull();
    });

    it('refuses a native agent whose identity holds a token', async () => {
      await installByo();
      await AgentInstallation.updateOne({ podId: home._id }, {
        $set: { 'config.runtime': { runtimeType: 'native' } },
      });
      await User.updateOne({ _id: (await bot())._id }, {
        $push: { agentRuntimeTokens: { tokenHash: 'held', label: 'seat', createdAt: new Date() } },
      });
      await AgentRegistry.updateOne({ agentName: NAME }, { $set: { ephemeral: false } });
      await User.updateOne({ _id: owner._id }, { $set: { entitlements: { cloudAgents: true } } });
      const res = await add(owner, target._id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('runtime_token_held');
      expect(await row(target._id)).toBeNull();
    });

    it('refuses a cloud runtime its owner is no longer entitled to', async () => {
      await installByo();
      await AgentInstallation.updateOne({ podId: home._id }, {
        $set: { 'config.runtime': { runtimeType: 'moltbot' } },
      });
      const res = await add(owner, target._id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('cloud_agents_not_entitled');
    });
  });

  describe('a hosted agent', () => {
    const hostedConfig = { runtime: { runtimeType: 'hosted' } };
    const installHosted = async (description) => {
      const res = await install(owner, home._id, hostedConfig, { description });
      expect(res.status).toBe(200);
    };

    it('passes the cap at the cap, because it is the same agent, and keeps its engine', async () => {
      await installHosted('Keeps the log.');
      const res = await add(owner, target._id);
      expect(res.status).toBe(200);
      const added = await row(target._id);
      expect(added.config.hosted).toEqual(expect.objectContaining({ engine: 'native', about: 'Keeps the log.' }));
      expect(added.config.hosted.provisionedAt).toBeTruthy();
    });

    it('stays stopped in the new pod when it is stopped', async () => {
      await installHosted();
      await AgentInstallation.updateOne({ podId: home._id }, { $set: { 'config.hosted.provisionedAt': null } });
      expect((await add(owner, target._id)).status).toBe(200);
      expect((await row(target._id)).config.hosted.provisionedAt).toBeNull();
    });

    it('stays on the Durable Object when that is where it runs', async () => {
      await installHosted();
      await AgentInstallation.updateOne({ podId: home._id }, { $unset: { 'config.hosted': 1 } });
      expect((await add(owner, target._id)).status).toBe(200);
      expect((await row(target._id)).config.hosted).toBeUndefined();
    });

    it('refuses an owner over the cap', async () => {
      await installHosted();
      await seedRow(owner._id, home._id, {
        agentName: 'second-hosted',
        config: { runtime: { runtimeType: 'hosted' }, hosted: { engine: 'native', provisionedAt: new Date() } },
      });
      const res = await add(owner, target._id);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'hosted_cap_reached', used: 2, cap: 1 });
      expect(await row(target._id)).toBeNull();
    });
  });

  it('leaves /install answering a duplicate the way it did', async () => {
    await installByo();
    const res = await install(owner, home._id, { runtime: { runtimeType: 'webhook' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Agent already installed in this pod' });
  });
});
