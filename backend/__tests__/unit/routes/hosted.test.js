// /api/hosted — ownership (sole-installer), unconfigured 503, cap re-check,
// server-side mint → worker provision, and that secrets never reach the body.
const request = require('supertest');
const express = require('express');

const mockFindOne = jest.fn();
const mockFind = jest.fn();
const mockUserFindOne = jest.fn();
const mockIssueToken = jest.fn();
const mockRevokeRuntimeTokens = jest.fn();
const mockHosted = {
  HOSTED_RUNTIME_TYPE: 'hosted',
  isConfigured: jest.fn(),
  isHostedInstallation: jest.fn(),
  hostedCaps: jest.fn(() => ({ agentsPerUser: 1, turnsPerDay: 200 })),
  hostedCapsForOwner: jest.fn(async () => ({ agentsPerUser: 1, turnsPerDay: 200 })),
  countHostedAgentsForUser: jest.fn(),
  listHostedInstallationsForUser: jest.fn(),
  meterAllowsTurn: jest.fn(),
  provisionAgent: jest.fn(),
  deprovisionAgent: jest.fn(),
  getAgentStatus: jest.fn(),
  HostedRuntimeError: class HostedRuntimeError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  },
};

// The route's limiter (30 a minute, module-level) is passed through here: this
// file makes more requests than one minute's budget, and a shared bucket made
// unrelated arms 429 on a full-file run (sprint-review on #2256). The limiter
// and its key are tested on their own in hosted.rateLimit.test.js.
jest.mock('express-rate-limit', () => ({ __esModule: true, default: () => (_req, _res, next) => next() }));

jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: 'owner-1' };
  next();
});
// The route writes config.hosted with updateOne (fenced on the stored engine
// for the Durable Object branch), so the mock applies it to the in-memory
// installation the test holds, honouring the engine condition.
const mockStore = new Map();
const mockUpdateOne = jest.fn(async (filter, update) => {
  const installation = mockStore.get(String(filter._id));
  if (!installation) return { matchedCount: 0, modifiedCount: 0 };
  const engineCondition = filter['config.hosted.engine'];
  const engine = String((installation.config.get('hosted') || {}).engine || '');
  if (engineCondition && engineCondition.$not.test(engine)) return { matchedCount: 0, modifiedCount: 0 };
  Object.entries(update.$set || {}).forEach(([path, value]) => {
    const [root, key, field] = path.split('.');
    if (root !== 'config') throw new Error(`unexpected path ${path}`);
    installation.config.set(key, field ? { ...(installation.config.get(key) || {}), [field]: value } : value);
  });
  return { matchedCount: 1, modifiedCount: 1 };
});
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    findOne: (...args) => mockFindOne(...args),
    find: (...args) => mockFind(...args),
    updateOne: (...args) => mockUpdateOne(...args),
  },
}));
jest.mock('../../../models/User', () => ({ findOne: (...args) => mockUserFindOne(...args) }));
const mockCredentialUpdateMany = jest.fn();
jest.mock('../../../models/AgentCredential', () => ({ updateMany: (...args) => mockCredentialUpdateMany(...args) }));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: (name, instance) => (instance === 'default' ? name : `${name}-${instance}`),
}));
jest.mock('../../../services/hostedRuntimeService', () => mockHosted);
const mockNativeAvailable = jest.fn(() => false);
jest.mock('../../../services/nativeRuntimeService', () => ({
  isNativeRuntimeAvailable: (...args) => mockNativeAvailable(...args),
  // The real rule, over this file's two switches.
  hostedEngineAvailable: (engine) => (engine === 'native' ? mockNativeAvailable() : mockHosted.isConfigured()),
}));
const mockMarkByoOpened = jest.fn();
jest.mock('../../../services/onboardingMarks', () => ({ markByoOpened: (...args) => mockMarkByoOpened(...args) }));
const mockCompleteConnectAgent = jest.fn();
// Spread the real module so only the writer is replaced (Sprint Review on
// #2252: a factory that lists exports silently drops the rest).
jest.mock('../../../services/starterTaskService', () => ({
  ...jest.requireActual('../../../services/starterTaskService'),
  completeConnectAgentStarterTask: (...args) => mockCompleteConnectAgent(...args),
}));
jest.mock('../../../routes/registry/tokens', () => ({
  revokeRuntimeTokensForAgent: (...args) => mockRevokeRuntimeTokens(...args),
  issueRuntimeTokenForAgent: (...args) => mockIssueToken(...args),
}));

const hostedRouter = require('../../../routes/hosted');

const app = express();
app.use(express.json());
app.use('/api/hosted', hostedRouter);

let installationSeq = 0;
const makeInstallation = (overrides = {}) => {
  installationSeq += 1;
  const installation = {
    _id: `inst-${installationSeq}`,
    agentName: 'scout',
    instanceId: 'default',
    podId: 'pod-1',
    config: new Map([['runtime', { runtimeType: 'hosted' }]]),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  mockStore.set(installation._id, installation);
  return installation;
};


// Pins the pass-through above: if the limiter mock stopped applying (an import
// change), this file's later arms would start to 429 again on a full run.
it('this suite runs without the rate limiter: 35 requests in a row are never 429', async () => {
  const statuses = [];
  for (let i = 0; i < 35; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    statuses.push((await request(app).get('/api/hosted/availability')).status);
  }
  expect(statuses.filter((status) => status === 429)).toEqual([]);
});

describe('/api/hosted', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Requests without an instanceId now resolve through find(); the older
    // tests mock findOne, so by default find() answers with that same row.
    mockFind.mockReset();
    mockFind.mockImplementation(async () => { const one = await mockFindOne(); return one ? [one] : []; });
    mockHosted.isConfigured.mockReturnValue(true);
    mockHosted.isHostedInstallation.mockReturnValue(true);
    mockHosted.countHostedAgentsForUser.mockResolvedValue(1);
    mockHosted.listHostedInstallationsForUser.mockResolvedValue([]);
    mockUserFindOne.mockResolvedValue({ _id: 'bot-1', username: 'scout', agentRuntimeTokens: [] });
    mockCredentialUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockIssueToken.mockResolvedValue({ token: 'cm_agent_secret', existing: false });
    mockRevokeRuntimeTokens.mockImplementation(async ({ agentUser, installation }) => {
      const hashes = Array.from(new Set((agentUser?.agentRuntimeTokens || [])
        .concat(installation?.runtimeTokens || [])
        .map((entry) => entry?.tokenHash)
        .filter(Boolean)));
      if (hashes.length) {
        await mockCredentialUpdateMany(
          { tokenHash: { $in: hashes }, status: 'active' },
          { $set: { status: 'revoked', revokedAt: new Date() } },
        );
      }
      if (agentUser) agentUser.agentRuntimeTokens = [];
      if (installation) installation.runtimeTokens = [];
      return hashes;
    });
    mockHosted.provisionAgent.mockResolvedValue({ provisioned: true });
  });

  it('reports availability and caps without the URL or bearer', async () => {
    const res = await request(app).get('/api/hosted/availability');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true, engine: 'durable-object', caps: { agentsPerUser: 1, turnsPerDay: 200 } });
    mockHosted.isConfigured.mockReturnValue(false);
    const off = await request(app).get('/api/hosted/availability');
    expect(off.body.configured).toBe(false);
  });

  // TASK-268: the page states the caller's own plan line, not a global number.
  it("reports the caller's own plan caps", async () => {
    mockHosted.hostedCapsForOwner.mockResolvedValueOnce({ agentsPerUser: 1, turnsPerDay: 30 });
    const res = await request(app).get('/api/hosted/availability');
    expect(mockHosted.hostedCapsForOwner).toHaveBeenCalledWith('owner-1');
    expect(res.body.caps).toEqual({ agentsPerUser: 1, turnsPerDay: 30 });
  });

  it("records the caller's first visit to Bring your own (the mark contains its own failures)", async () => {
    const res = await request(app).get('/api/hosted/availability');
    expect(res.status).toBe(200);
    expect(mockMarkByoOpened).toHaveBeenCalledTimes(1);
    expect(mockMarkByoOpened).toHaveBeenCalledWith('owner-1');
  });

  it('503s with a code when the runtime is not configured, before touching the DB', async () => {
    mockHosted.isConfigured.mockReturnValue(false);
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('hosted_runtime_unconfigured');
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('400s on a malformed agent name', async () => {
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'Bad Name!' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_agent_name');
  });

  it('404s unless the caller is the installer of an active installation', async () => {
    mockFind.mockResolvedValue([]);
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_owner_or_missing');
    // No instanceId in the request → the lookup is by owner + agent, never by an assumed "default".
    expect(mockFind).toHaveBeenCalledWith({ agentName: 'scout', status: 'active', installedBy: 'owner-1' });
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('a persona hire provisions without an instanceId: the install derived "scout" from the display name and the UI sends only agentName (stranger smoke, 2026-09-08)', async () => {
    mockFind.mockResolvedValue([makeInstallation({ agentName: 'scout-678386', instanceId: 'scout' })]);
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout-678386' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provisioned: true, agentName: 'scout-678386', instanceId: 'scout', podId: 'pod-1' });
    expect(mockHosted.provisionAgent).toHaveBeenCalledWith({ agentName: 'scout-678386', instanceId: 'scout', runtimeToken: 'cm_agent_secret' });
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('with two owned instances and no instanceId, prefers "default" and otherwise asks for one (409)', async () => {
    mockFind.mockResolvedValue([makeInstallation({ instanceId: 'scout' }), makeInstallation({ instanceId: 'default' })]);
    const ok = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(ok.status).toBe(200);
    expect(ok.body.instanceId).toBe('default');
    mockFind.mockResolvedValue([makeInstallation({ instanceId: 'scout' }), makeInstallation({ instanceId: 'demo' })]);
    const amb = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(amb.status).toBe(409);
    expect(amb.body).toMatchObject({ code: 'ambiguous_instance', instanceIds: ['scout', 'demo'] });
  });

  it('prefers the hosted row over a non-hosted "default" when no instanceId is sent (sprint-review on #1644)', async () => {
    const hosted = makeInstallation({ instanceId: 'scout' });
    const byo = makeInstallation({ instanceId: 'default', config: new Map([['runtime', { runtimeType: 'byo' }]]) });
    mockHosted.isHostedInstallation.mockImplementation((row) => row.config.get('runtime').runtimeType === 'hosted');
    mockFind.mockResolvedValue([byo, hosted]);
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(200);
    expect(res.body.instanceId).toBe('scout');
    expect(mockHosted.provisionAgent).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'scout' }));
    // Nothing hosted at all → the honest not_hosted answer survives.
    mockFind.mockResolvedValue([byo]);
    const none = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('not_hosted');
  });

  it('deprovision without an instanceId resolves the same single owned seat — deliberate symmetry, caller-scoped', async () => {
    mockFind.mockResolvedValue([makeInstallation({ instanceId: 'scout' })]);
    const res = await request(app).post('/api/hosted/deprovision').send({ agentName: 'scout' });
    expect(res.status).toBe(200);
    expect(mockFind).toHaveBeenCalledWith({ agentName: 'scout', status: 'active', installedBy: 'owner-1' });
  });

  it('an explicit instanceId still resolves by findOne exactly as before', async () => {
    mockFindOne.mockResolvedValue(makeInstallation({ instanceId: 'demo' }));
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout', instanceId: 'demo' });
    expect(res.status).toBe(200);
    expect(mockFindOne).toHaveBeenCalledWith({ agentName: 'scout', instanceId: 'demo', status: 'active', installedBy: 'owner-1' });
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('409s when the owned installation is not a hosted one', async () => {
    mockFindOne.mockResolvedValue(makeInstallation());
    mockHosted.isHostedInstallation.mockReturnValue(false);
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_hosted');
    expect(mockHosted.provisionAgent).not.toHaveBeenCalled();
  });

  it('403s when the owner is over the (possibly lowered) per-user cap', async () => {
    mockFindOne.mockResolvedValue(makeInstallation());
    mockHosted.countHostedAgentsForUser.mockResolvedValue(2);
    mockHosted.listHostedInstallationsForUser.mockResolvedValue([
      { agentName: 'scout', instanceId: 'default', podId: 'pod-1' },
    ]);
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'hosted_cap_reached',
      used: 2,
      cap: 1,
      holders: [{ agentName: 'scout', instanceId: 'default', podId: 'pod-1' }],
    });
    expect(mockHosted.listHostedInstallationsForUser).toHaveBeenCalledWith('owner-1');
    expect(mockIssueToken).not.toHaveBeenCalled();
  });

  it('keeps the cap response when holder diagnostics fail', async () => {
    mockFindOne.mockResolvedValue(makeInstallation());
    mockHosted.countHostedAgentsForUser.mockResolvedValue(2);
    mockHosted.listHostedInstallationsForUser.mockRejectedValue(new Error('diagnostic timeout'));
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'hosted_cap_reached', used: 2, cap: 1, holders: [] });
  });

  it('mints server-side with owner lineage, provisions, records, and never returns the token', async () => {
    const installation = makeInstallation();
    mockFindOne.mockResolvedValue(installation);
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'Scout', instanceId: 'Demo' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provisioned: true, agentName: 'scout', instanceId: 'demo', podId: 'pod-1' });
    // A Durable Object worker is not live until it polls, so provision does not say ready.
    expect(res.body.ready).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('cm_agent_secret');
    expect(mockUserFindOne).toHaveBeenCalledWith({ username: 'scout-demo', isBot: true });
    expect(mockIssueToken).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'bot-1' }), 'Hosted runtime', installation, { ownerUserId: 'owner-1' },
    );
    expect(mockRevokeRuntimeTokens).toHaveBeenCalledWith({
      agentUser: expect.objectContaining({ _id: 'bot-1' }),
      agentName: 'scout',
      instanceId: 'demo',
      installation,
    });
    expect(mockHosted.provisionAgent).toHaveBeenCalledWith({ agentName: 'scout', instanceId: 'demo', runtimeToken: 'cm_agent_secret' });
    expect(installation.config.get('hosted').provisionedAt).toBeInstanceOf(Date);
    // The worker's first use of its token completes the onboarding card, as a
    // BYO agent's does; provision does not claim it is listening yet.
    expect(mockCompleteConnectAgent).not.toHaveBeenCalled();
  });

  it('rotates: revokes the old credential rows, clears the stored hashes, mints fresh', async () => {
    const installation = makeInstallation({ runtimeTokens: [{ tokenHash: 'old-hash' }] });
    const agentUser = { _id: 'bot-1', username: 'scout', agentRuntimeTokens: [{ tokenHash: 'old-hash' }] };
    mockFindOne.mockResolvedValue(installation);
    mockUserFindOne.mockResolvedValue(agentUser);
    mockIssueToken.mockResolvedValue({ token: 'cm_agent_fresh', existing: false });
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(200);
    expect(mockRevokeRuntimeTokens).toHaveBeenCalledWith({
      agentUser,
      agentName: 'scout',
      instanceId: 'default',
      installation,
    });
    expect(mockCredentialUpdateMany).toHaveBeenCalledWith(
      { tokenHash: { $in: ['old-hash'] }, status: 'active' },
      { $set: expect.objectContaining({ status: 'revoked' }) },
    );
    // Cleared BEFORE minting, so issueRuntimeTokenForAgent cannot take its reuse path.
    expect(agentUser.agentRuntimeTokens).toEqual([]);
    expect(installation.runtimeTokens).toEqual([]);
    expect(mockHosted.provisionAgent).toHaveBeenCalledWith(expect.objectContaining({ runtimeToken: 'cm_agent_fresh' }));
  });

  it('relays a worker failure as 502 and does not record a provision', async () => {
    const installation = makeInstallation();
    mockFindOne.mockResolvedValue(installation);
    mockHosted.provisionAgent.mockRejectedValue(new mockHosted.HostedRuntimeError('Hosted runtime unreachable: timeout', 502));
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('hosted_runtime_unreachable');
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(installation.config.get('hosted')).toBeUndefined();
  });

  it('deprovisions the owner\'s agent and keeps the installation', async () => {
    const installation = makeInstallation();
    mockFindOne.mockResolvedValue(installation);
    mockHosted.deprovisionAgent.mockResolvedValue({ deprovisioned: true });
    const res = await request(app).post('/api/hosted/deprovision').send({ agentName: 'scout' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deprovisioned: true });
    expect(installation.config.get('hosted').provisionedAt).toBeNull();
  });

  // TASK-265, Rhea on #2236: a migration that marks the row native while the
  // worker call is in flight must win. Before the fence, the route saved the
  // Durable Object record it read at the start over the migration's, and the
  // next provision minted a fresh token.
  describe('against a migration landing mid-request', () => {
    const MIGRATED = {
      engine: 'native',
      provisionedAt: new Date('2026-10-15T17:00:00Z'),
      migratedFrom: 'durable-object',
      migration: { state: 'done', doProvisioned: true },
    };

    it('provision: the migrated record stands, the started worker is stopped, its token is taken back, 409', async () => {
      const installation = makeInstallation();
      mockFindOne.mockResolvedValue(installation);
      mockNativeAvailable.mockReturnValue(true);
      mockHosted.provisionAgent.mockImplementation(async () => {
        installation.config.set('hosted', { ...MIGRATED });
        return { provisioned: true };
      });
      mockHosted.deprovisionAgent.mockResolvedValue({ deprovisioned: true });

      const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('hosted_engine_migrated');
      expect(installation.config.get('hosted')).toEqual(MIGRATED);
      expect(mockHosted.deprovisionAgent).toHaveBeenCalledWith('scout', 'default');
      // Once before minting, once to take back the token minted before the mark.
      expect(mockRevokeRuntimeTokens).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(res.body)).not.toContain('cm_agent_secret');

      // The next provision finds the native record and mints nothing.
      const again = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
      expect(again.status).toBe(200);
      expect(again.body.engine).toBe('native');
      expect(mockIssueToken).toHaveBeenCalledTimes(1);
      expect(mockHosted.provisionAgent).toHaveBeenCalledTimes(1);
      expect(installation.config.get('hosted')).toEqual(MIGRATED);
    });

    it('provision: a failed stop of the overtaken worker still takes the token back and reports 409', async () => {
      const installation = makeInstallation();
      mockFindOne.mockResolvedValue(installation);
      mockHosted.provisionAgent.mockImplementation(async () => {
        installation.config.set('hosted', { ...MIGRATED });
        return { provisioned: true };
      });
      mockHosted.deprovisionAgent.mockRejectedValue(new Error('worker unreachable'));
      jest.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });

      expect(res.status).toBe(409);
      expect(mockRevokeRuntimeTokens).toHaveBeenCalledTimes(2);
      expect(installation.config.get('hosted')).toEqual(MIGRATED);
    });

    it('deprovision: the worker is stopped and the migrated record is kept', async () => {
      const installation = makeInstallation();
      mockFindOne.mockResolvedValue(installation);
      mockHosted.deprovisionAgent.mockImplementation(async () => {
        installation.config.set('hosted', { ...MIGRATED });
        return { deprovisioned: true };
      });

      const res = await request(app).post('/api/hosted/deprovision').send({ agentName: 'scout' });

      expect(res.status).toBe(200);
      expect(installation.config.get('hosted')).toEqual(MIGRATED);
    });
  });

  it('reports runtime status together with today\'s meter for the owner', async () => {
    mockFindOne.mockResolvedValue(makeInstallation());
    mockHosted.getAgentStatus.mockResolvedValue({ agentName: 'scout', lastPollAt: 1 });
    mockHosted.meterAllowsTurn.mockResolvedValue({ allowed: true, used: 3, cap: 200 });
    const res = await request(app).get('/api/hosted/status').query({ agentName: 'scout' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runtime: { lastPollAt: 1 }, meter: { used: 3, cap: 200 } });
  });
});

// ADR-023 amendment A1: a hosted install on the native engine has nothing to
// start. Provision records it and revokes any stray token without minting one,
// status reports ready from the record, and the worker is never called.
describe('/api/hosted on the native engine', () => {
  const PROVISIONED = new Date('2026-10-15T12:00:00Z');
  const nativeInstallation = (hosted = {}) => makeInstallation({
    config: new Map([
      ['runtime', { runtimeType: 'hosted' }],
      ['hosted', { engine: 'native', provisionedAt: PROVISIONED, about: 'Keeps the research log.', ...hosted }],
    ]),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFind.mockReset();
    mockFind.mockImplementation(async () => { const one = await mockFindOne(); return one ? [one] : []; });
    // The worker is not configured at all: the native engine must not need it.
    mockHosted.isConfigured.mockReturnValue(false);
    mockHosted.isHostedInstallation.mockReturnValue(true);
    mockHosted.countHostedAgentsForUser.mockResolvedValue(1);
    mockHosted.meterAllowsTurn.mockResolvedValue({ allowed: true, used: 3, cap: 200 });
    mockNativeAvailable.mockReturnValue(true);
    mockUserFindOne.mockResolvedValue({ _id: 'bot-1', username: 'scout', agentRuntimeTokens: [{ tokenHash: 'old' }] });
    mockRevokeRuntimeTokens.mockResolvedValue(['old']);
  });

  afterEach(() => { delete process.env.HOSTED_ENGINE; });

  it('availability follows the native runtime when HOSTED_ENGINE=native', async () => {
    process.env.HOSTED_ENGINE = 'native';
    const on = await request(app).get('/api/hosted/availability');
    expect(on.body).toMatchObject({ configured: true, engine: 'native' });
    mockNativeAvailable.mockReturnValue(false);
    const off = await request(app).get('/api/hosted/availability');
    expect(off.body).toMatchObject({ configured: false, engine: 'native' });
  });

  it('provision revokes any old token, mints none, never calls the worker, and keeps the record', async () => {
    const installation = nativeInstallation();
    mockFindOne.mockResolvedValue(installation);
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(200);
    // Live from provision: the page shows it running without a status round trip.
    expect(res.body).toMatchObject({ provisioned: true, ready: true, engine: 'native', agentName: 'scout' });
    expect(mockRevokeRuntimeTokens).toHaveBeenCalledTimes(1);
    expect(mockIssueToken).not.toHaveBeenCalled();
    expect(mockHosted.provisionAgent).not.toHaveBeenCalled();
    expect(installation.config.get('hosted')).toEqual({
      engine: 'native', provisionedAt: PROVISIONED, about: 'Keeps the research log.',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/cm_agent_/);
  });

  // QA 2026-10-16: "Connect your first agent" stayed pending after a hosted
  // agent went live, because the card completes on a runtime token's first
  // use and a native hosted agent has no token. Provision is its live moment.
  it('provision completes the "Connect your first agent" card in the agent\'s pod', async () => {
    mockFindOne.mockResolvedValue(nativeInstallation());
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(200);
    expect(mockCompleteConnectAgent).toHaveBeenCalledTimes(1);
    const [{ podIds, agentLabel }] = mockCompleteConnectAgent.mock.calls[0];
    expect(podIds.map(String)).toEqual(['pod-1']);
    // The label reaches the person in the card's update line, so pin the
    // value, not truthiness (Sprint Review on #2252: a constant passed that).
    expect(agentLabel).toBe('scout');
  });

  it('names the agent on the card by its display name first', async () => {
    mockUserFindOne.mockResolvedValue({
      _id: 'bot-1', username: 'scout', agentRuntimeTokens: [], botMetadata: { displayName: 'Research Scout' },
    });
    mockFindOne.mockResolvedValue(nativeInstallation());
    await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(mockCompleteConnectAgent.mock.calls[0][0].agentLabel).toBe('Research Scout');

    mockCompleteConnectAgent.mockClear();
    mockUserFindOne.mockResolvedValue({ _id: 'bot-1', username: 'scout', agentRuntimeTokens: [] });
    mockFindOne.mockResolvedValue(makeInstallation({
      displayName: 'Lab Notes',
      config: new Map([['runtime', { runtimeType: 'hosted' }], ['hosted', { engine: 'native', provisionedAt: PROVISIONED }]]),
    }));
    await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(mockCompleteConnectAgent.mock.calls[0][0].agentLabel).toBe('Lab Notes');
  });

  it('provision of a native install 503s when the native runtime is unavailable, even with the worker up', async () => {
    mockHosted.isConfigured.mockReturnValue(true);
    mockNativeAvailable.mockReturnValue(false);
    mockFindOne.mockResolvedValue(nativeInstallation());
    const res = await request(app).post('/api/hosted/provision').send({ agentName: 'scout' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('hosted_runtime_unconfigured');
    expect(mockHosted.provisionAgent).not.toHaveBeenCalled();
  });

  it('status is ready once provisioned, without asking the worker', async () => {
    mockFindOne.mockResolvedValue(nativeInstallation());
    const res = await request(app).get('/api/hosted/status?agentName=scout');
    expect(res.status).toBe(200);
    expect(res.body.runtime).toEqual({ engine: 'native', ready: true, provisionedAt: PROVISIONED.toISOString() });
    expect(res.body.meter).toMatchObject({ used: 3, cap: 200 });
    expect(mockHosted.getAgentStatus).not.toHaveBeenCalled();
  });

  it('deprovision clears provisionedAt and keeps engine and persona, without the worker', async () => {
    const installation = nativeInstallation();
    mockFindOne.mockResolvedValue(installation);
    const res = await request(app).post('/api/hosted/deprovision').send({ agentName: 'scout' });
    expect(res.status).toBe(200);
    expect(mockHosted.deprovisionAgent).not.toHaveBeenCalled();
    const hosted = installation.config.get('hosted');
    expect(hosted).toMatchObject({ engine: 'native', provisionedAt: null, about: 'Keeps the research log.' });
    expect(hosted.deprovisionedAt).toBeInstanceOf(Date);

    const status = await request(app).get('/api/hosted/status?agentName=scout');
    expect(status.body.runtime).toMatchObject({ engine: 'native', ready: false });
  });

  // Rhea on #2236: the native branches write only their own fields, so a
  // migration that advances while the request is in flight is not reverted to
  // the record read at the start.
  it.each([
    ['provision', { provisionedAt: PROVISIONED }],
    ['deprovision', { provisionedAt: null }],
  ])('%s on a migrating row never writes back the migration record it read', async (route, expected) => {
    const installation = nativeInstallation({ migratedFrom: 'durable-object', migration: { state: 'marked', doProvisioned: true } });
    // The route holds the copy it read; saving it persists that copy's record,
    // as a hydrated document would. The migration finishes right after the read.
    mockFindOne.mockImplementation(async () => {
      const read = {
        ...installation,
        config: new Map(installation.config),
        save: jest.fn(async () => { installation.config.set('hosted', read.config.get('hosted')); }),
      };
      installation.config.set('hosted', {
        ...installation.config.get('hosted'), migration: { state: 'done', doProvisioned: true },
      });
      return read;
    });

    const res = await request(app).post(`/api/hosted/${route}`).send({ agentName: 'scout' });

    expect(res.status).toBe(200);
    const hosted = installation.config.get('hosted');
    expect(hosted.migration).toEqual({ state: 'done', doProvisioned: true });
    expect(hosted).toMatchObject({ engine: 'native', about: 'Keeps the research log.', ...expected });
  });
});
