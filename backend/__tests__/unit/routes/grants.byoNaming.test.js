/**
 * F94 — a grant may name the granter's own agent that runs outside Commonly
 * (BYO: Claude Code, Codex through the daemon), read-only, with consent.
 * RoomGrant runs on memory Mongo; the pod, connection, catalogue, agent rows,
 * ownership and confinement are mocked at their module boundaries.
 */
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const id = req.get('x-test-user');
  if (!id) return res.status(401).json({ error: 'unauthorized' });
  req.user = { id };
  req.userId = id;
  return next();
});
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());
jest.mock('../../../services/brokerRecordService', () => ({
  ...jest.requireActual('../../../services/brokerRecordService'),
  recordGrantIssued: jest.fn(),
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn(), exists: jest.fn(async () => true) }));
jest.mock('../../../models/Integration', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/Installable', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/githubAppService', () => ({}));
jest.mock('../../../models/ToolCall', () => ({ __esModule: true, default: {}, digestArgs: jest.fn(), reserveBudgetLineage: jest.fn() }));
jest.mock('../../../services/outsiderGrantPodEligibility', () => ({
  outsiderGrantPodRefusal: jest.fn(async () => null),
  outsiderGrantRefusalMessage: jest.fn((reason) => `refused: ${reason}`),
}));
const mockUserFind = jest.fn();
jest.mock('../../../models/User', () => ({
  __esModule: true,
  default: { find: (...args) => mockUserFind(...args), findById: jest.fn() },
  find: (...args) => mockUserFind(...args),
  findById: jest.fn(),
}));
const mockOwns = jest.fn();
jest.mock('../../../services/runtimeIdentityOwnership', () => ({
  ...jest.requireActual('../../../services/runtimeIdentityOwnership'),
  ownsRuntimeIdentity: (...args) => mockOwns(...args),
}));
const mockJudge = jest.fn();
jest.mock('../../../services/seatGrantConfinement', () => {
  const actual = jest.requireActual('../../../services/seatGrantConfinement');
  return { ...actual, judgeSeatConfinement: (...args) => mockJudge(...args) };
});

const Pod = require('../../../models/Pod');
const Integration = require('../../../models/Integration');
const Installable = require('../../../models/Installable');
const { buildGithubToolInstallable } = require('../../../services/installable/toolInstallables');
const { HOSTED_MCP_ENTRIES } = require('../../../integrations/hostedMcp/entries');
const { outsiderGrantPodRefusal } = require('../../../services/outsiderGrantPodEligibility');

const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const BYO = 'cccccccccccccccccccccc01';
const HOSTED_ID = 'eeeeeeeeeeeeeeeeeeeeee01';

const pinned = (over) => ({
  name: 'list_issues', upstreamName: 'list_issues', description: 'List issues',
  class: 'read', inputSchema: { type: 'object' }, ...over,
});
const ENTRY = {
  id: 'linear', title: 'Linear', resource: 'https://mcp.linear.app/mcp',
  issuer: 'https://mcp.linear.app', client: 'cimd', scopes: ['read'], writeScope: 'write',
  revoke: 'https://mcp.linear.app/token', tools: [pinned({})],
};
const CALENDAR = {
  ...ENTRY, id: 'google-calendar', title: 'Google Calendar', resource: 'https://calendar.example/mcp',
  tools: [pinned({ name: 'list_events', upstreamName: 'list_events', description: 'List events' })],
};

let mongod;
let RoomGrant;
let app;
let caller = 0;
let connection;
let agentRows;

const mint = (body) => request(app).post('/api/grants').set('x-test-user', OWNER)
  .set('x-auth-token', `byo-caller-${caller}`).send({
    connectionId: HOSTED_ID,
    target: { kind: 'pod', id: POD },
    tools: ['linear.list_issues'],
    writeMode: 'read',
    audience: [OWNER, BYO],
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    byoAgents: [BYO],
    byoConsent: true,
    ...body,
  });

const withCatalog = async (entries, run) => {
  const shipped = HOSTED_MCP_ENTRIES.splice(0, HOSTED_MCP_ENTRIES.length, ...entries);
  try {
    return await run();
  } finally {
    HOSTED_MCP_ENTRIES.splice(0, HOSTED_MCP_ENTRIES.length, ...shipped);
  }
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  RoomGrant = require('../../../models/RoomGrant');
  app = express();
  app.use(express.json());
  app.use('/api/grants', require('../../../routes/grants'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  caller += 1;
  jest.clearAllMocks();
  outsiderGrantPodRefusal.mockResolvedValue(null);
  await RoomGrant.deleteMany({});
  Pod.findById.mockImplementation((id) => ({
    select: () => ({ lean: async () => (String(id) === POD ? { _id: POD, type: 'team', members: [OWNER, BYO] } : null) }),
  }));
  connection = {
    _id: HOSTED_ID, type: 'hosted-mcp', status: 'connected', createdBy: OWNER,
    config: { entryId: 'linear', credentialRef: 'secret-ref-1', grantedScope: 'read write openid' },
  };
  Integration.findById.mockImplementation(async () => connection);
  Installable.findOne.mockReturnValue({ lean: async () => buildGithubToolInstallable() });
  agentRows = [{ _id: BYO, botType: 'agent', botMetadata: { agentName: 'lily-claude', instanceId: 'default' } }];
  mockUserFind.mockImplementation(() => ({ select: () => ({ lean: async () => agentRows }) }));
  mockOwns.mockResolvedValue({ owned: true });
  // A workspace-trust Claude Code seat: the server knows it is not confined.
  mockJudge.mockResolvedValue({ refusal: { reason: 'sandbox_trust_not_public' }, scope: 'seat' });
});

describe('POST /api/grants naming a BYO agent', () => {
  test('a read grant naming the owner\'s own agent, with consent, is minted and exempts only it', async () => {
    const res = await withCatalog([ENTRY], () => mint());
    expect(res.status).toBe(201);
    const stored = await RoomGrant.findOne({ grantId: res.body.grantId }).lean();
    expect(stored.byoAgents).toEqual([BYO]);
    expect(stored.byoConsent).toMatchObject({
      by: OWNER, version: 'byo-v1', agents: [{ userId: BYO, sandbox: 'unconfined' }],
    });
    expect(outsiderGrantPodRefusal).toHaveBeenCalledWith(
      { kind: 'pod', id: POD }, 'read', expect.objectContaining({ exemptAgentIds: [BYO] }),
    );
    expect(mockOwns).toHaveBeenCalledWith(OWNER, 'lily-claude', 'default');
  });

  describe('the sandbox state the consent records', () => {
    let AgentInstallation;
    beforeEach(async () => {
      ({ AgentInstallation } = require('../../../models/AgentRegistry'));
      await AgentInstallation.deleteMany({});
      mockJudge.mockResolvedValue({ refusal: null, scope: 'seat' });
    });
    const install = (runtimeType) => AgentInstallation.create({
      agentName: 'lily-claude', instanceId: 'default', podId: POD, version: '1.0.0',
      status: 'active', installedBy: OWNER, config: { runtime: { runtimeType } },
    });

    test('a daemon-spawned seat the server judged confinable is recorded as confined', async () => {
      await install('wrapper');
      agentRows[0].botMetadata.machineId = 'machine-a';
      const res = await withCatalog([ENTRY], () => mint());
      expect(res.status).toBe(201);
      expect(res.body.byoConsent.agents).toEqual([{ userId: BYO, sandbox: 'confined' }]);
    });

    test('a bring-your-own token in the person\'s own client is never recorded as confined', async () => {
      await install('webhook');
      agentRows[0].botMetadata.machineId = 'machine-a';
      const res = await withCatalog([ENTRY], () => mint());
      expect(res.body.byoConsent.agents).toEqual([{ userId: BYO, sandbox: 'unknown' }]);
    });

    test('reads the install in the grant\'s own pod, not another pod\'s', async () => {
      await AgentInstallation.create({
        agentName: 'lily-claude', instanceId: 'default', podId: '000000000000000000000001', version: '1.0.0',
        status: 'active', installedBy: OWNER, config: { runtime: { runtimeType: 'webhook' } },
      });
      await install('wrapper');
      agentRows[0].botMetadata.machineId = 'machine-a';
      const res = await withCatalog([ENTRY], () => mint());
      expect(res.body.byoConsent.agents).toEqual([{ userId: BYO, sandbox: 'confined' }]);
    });

    test('a seat bound to no machine is not recorded as confined', async () => {
      await install('wrapper');
      const res = await withCatalog([ENTRY], () => mint());
      expect(res.body.byoConsent.agents).toEqual([{ userId: BYO, sandbox: 'unknown' }]);
    });
  });

  test.each([
    ['write-with-confirm is refused', { writeMode: 'write-with-confirm' }, 'byo_read_only'],
    ['a missing consent is refused', { byoConsent: undefined }, 'byo_consent_required'],
    ['a consent that is not literally true is refused', { byoConsent: 'yes' }, 'byo_consent_required'],
    ['an agent outside the audience is refused', { audience: [OWNER] }, 'byo_not_audience'],
  ])('%s', async (_, body, error) => {
    const res = await withCatalog([ENTRY], () => mint(body));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(error);
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('an agent the granter did not solely install is refused', async () => {
    mockOwns.mockResolvedValue({ owned: false, failure: 'another_installer' });
    const res = await withCatalog([ENTRY], () => mint());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('byo_agent_not_owned');
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('a member that is not an agent row is refused', async () => {
    agentRows = [{ _id: BYO, botType: 'bridge-bot', botMetadata: { agentName: 'relay' } }];
    const res = await withCatalog([ENTRY], () => mint());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('byo_not_agent');
  });

  test('an agent on a machine with no enforceable sandbox is never named', async () => {
    mockJudge.mockResolvedValue({ refusal: { reason: 'sandbox_mode_unenforceable' }, scope: 'seat', hostUnconfined: true });
    const res = await withCatalog([ENTRY], () => mint());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('byo_unconfined_host');
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('an adapter not approved for the broker cannot be named', async () => {
    mockJudge.mockResolvedValue({ refusal: { reason: 'adapter_cannot_confine' }, scope: 'seat' });
    const res = await withCatalog([ENTRY], () => mint());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('byo_adapter_unsupported');
    // F175a: the message names every harness that can hold a grant, from the
    // server's own confining-adapter list.
    expect(res.body.message).toBe('Only a Claude Code, Codex or OpenCode agent can be named on a grant.');
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('a Limited Use connector (Calendar) cannot name a BYO agent', async () => {
    connection.config.entryId = 'google-calendar';
    const res = await withCatalog([CALENDAR], () => mint({ tools: ['google-calendar.list_events'] }));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('byo_limited_use');
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('a grant naming nobody keeps the full pod gate and stores no consent', async () => {
    const res = await withCatalog([ENTRY], () => mint({ byoAgents: undefined }));
    expect(res.status).toBe(201);
    expect(res.body.byoAgents).toBeUndefined();
    expect(res.body.byoConsent).toBeUndefined();
    expect(outsiderGrantPodRefusal).toHaveBeenCalledWith(
      { kind: 'pod', id: POD }, 'read', expect.objectContaining({ exemptAgentIds: [] }),
    );
  });

  test('byoAgents that is not a list of ids is refused', async () => {
    const res = await withCatalog([ENTRY], () => mint({ byoAgents: BYO }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_byo_agents');
  });

  test('a BYO grant still needs an expiry: none is ever open-ended', async () => {
    const res = await withCatalog([ENTRY], () => mint({ expiresAt: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_expiry');
  });
});

describe('attenuating a grant that names a BYO agent', () => {
  const { attenuateGrant } = require('../../../services/roomGrantService');
  const parentWith = async () => {
    const res = await withCatalog([ENTRY], () => mint());
    expect(res.status).toBe(201);
    return res.body.grantId;
  };

  test('a child keeps a named agent only while it still reaches it, under the parent consent', async () => {
    const parentGrantId = await parentWith();
    const kept = await attenuateGrant({ parentGrantId, audience: [BYO] });
    expect(kept.byoAgents).toEqual([BYO]);
    expect(kept.byoConsent.by).toBe(OWNER);
    const dropped = await attenuateGrant({ parentGrantId, audience: [OWNER] });
    expect(dropped.byoAgents ?? []).toEqual([]);
    // The consent still rides: the pod gate exempts by it in the shared pod.
    expect(dropped.byoConsent.agents).toEqual([expect.objectContaining({ userId: BYO })]);
    const grandchild = await attenuateGrant({ parentGrantId: dropped.grantId, audience: [OWNER] });
    expect(grandchild.byoConsent.agents).toEqual([expect.objectContaining({ userId: BYO })]);
    const { byoPodExemptAgentIds } = require('../../../services/byoGrantNaming');
    expect(await byoPodExemptAgentIds(grandchild)).toEqual([BYO]);
  });
});

describe('DELETE /api/grants/:grantId/byo-agents/:agentId', () => {
  const remove = (grantId, agentId, user = OWNER) => request(app)
    .delete(`/api/grants/${grantId}/byo-agents/${agentId}`)
    .set('x-test-user', user).set('x-auth-token', `byo-remove-${caller}`);

  test('the granter takes the agent off the grant and its children: naming, audience and consent together', async () => {
    const res = await withCatalog([ENTRY], () => mint());
    const { attenuateGrant } = require('../../../services/roomGrantService');
    const child = await attenuateGrant({ parentGrantId: res.body.grantId, audience: [OWNER, BYO] });
    const out = await remove(res.body.grantId, BYO);
    expect(out.status).toBe(200);
    // Still in the pod, so the lineage is refused there until it leaves.
    expect(out.body).toEqual({ grantId: res.body.grantId, byoAgents: [], pausedWhileInPod: true });
    for (const grantId of [res.body.grantId, child.grantId]) {
      // eslint-disable-next-line no-await-in-loop
      const row = await RoomGrant.findOne({ grantId }).lean();
      expect(row.byoAgents).toEqual([]);
      expect(row.audience).toEqual([OWNER]);
      expect(row.byoConsent.agents).toEqual([]);
    }
  });

  test('says the grant is not paused once the agent is out of the pod', async () => {
    const res = await withCatalog([ENTRY], () => mint());
    // eslint-disable-next-line global-require
    require('../../../models/Pod').exists.mockResolvedValueOnce(null);
    const out = await remove(res.body.grantId, BYO);
    expect(out.body.pausedWhileInPod).toBe(false);
  });

  test('anyone but the granter is refused, and nothing changes', async () => {
    const res = await withCatalog([ENTRY], () => mint());
    const out = await remove(res.body.grantId, BYO, BYO);
    expect(out.status).toBe(403);
    expect((await RoomGrant.findOne({ grantId: res.body.grantId }).lean()).byoAgents).toEqual([BYO]);
  });

  test('an agent the grant does not name is a 404', async () => {
    const res = await withCatalog([ENTRY], () => mint());
    expect((await remove(res.body.grantId, OWNER)).status).toBe(404);
  });
});

describe('GET /api/grants/byo-candidates', () => {
  const NATIVE = 'dddddddddddddddddddddd01';
  let AgentInstallation;
  const candidates = (user = OWNER) => request(app).get(`/api/grants/byo-candidates?podId=${POD}`)
    .set('x-test-user', user).set('x-auth-token', `byo-cand-${caller}`);

  beforeEach(async () => {
    ({ AgentInstallation } = require('../../../models/AgentRegistry'));
    await AgentInstallation.deleteMany({});
    Pod.findById.mockImplementation((id) => ({
      select: () => ({ lean: async () => (String(id) === POD ? { _id: POD, members: [OWNER, BYO, NATIVE] } : null) }),
    }));
    agentRows = [
      { _id: BYO, botType: 'agent', botMetadata: { agentName: 'lily-claude', instanceId: 'default' } },
      { _id: NATIVE, botType: 'agent', botMetadata: { agentName: 'scout', instanceId: 'default' } },
    ];
    const base = { podId: POD, instanceId: 'default', version: '1.0.0', status: 'active', installedBy: OWNER };
    await AgentInstallation.create({ ...base, agentName: 'lily-claude', config: { runtime: { runtimeType: 'local-cli' } } });
    await AgentInstallation.create({ ...base, agentName: 'scout', config: { runtime: { runtimeType: 'native' } } });
  });

  test('lists only the caller\'s own agents that run outside Commonly, with their sandbox state', async () => {
    const res = await candidates();
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([{
      userId: BYO, agentName: 'lily-claude', instanceId: 'default', nameable: true, sandbox: 'unconfined',
    }]);
  });

  test('an agent on a machine with no enforceable sandbox is listed as not nameable', async () => {
    mockJudge.mockResolvedValue({ refusal: { reason: 'sandbox_mode_unenforceable' }, scope: 'seat', hostUnconfined: true });
    const res = await candidates();
    expect(res.body.agents).toEqual([expect.objectContaining({ userId: BYO, nameable: false, reason: 'unconfined_host' })]);
  });

  test('an agent someone else also installed is left out', async () => {
    mockOwns.mockResolvedValue({ owned: false, failure: 'another_installer' });
    expect((await candidates()).body.agents).toEqual([]);
  });

  test('a caller outside the pod is refused', async () => {
    expect((await candidates('ffffffffffffffffffffff01')).status).toBe(403);
  });
});
