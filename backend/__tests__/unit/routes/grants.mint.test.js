/**
 * Tools plan §2 / §6 — the mint takes its broker from the seeded tool
 * Installable and lets a grant allow only tools that Installable enables.
 * RoomGrant runs on memory Mongo; the pod, the connection and the seeded
 * Installable are mocked at their module boundaries, as grants.read does.
 * The follow-up adds: the grant's installationId is the
 * connection's, and a body value is refused like brokerId.
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
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  const agent = req.get('x-test-agent');
  if (agent) req.agentUser = { _id: agent, isBot: true, botMetadata: { ownerUserId: req.get('x-test-agent-owner') } };
  return next();
});
const mockRecordGrantIssued = jest.fn();
jest.mock('../../../services/brokerRecordService', () => ({
  ...jest.requireActual('../../../services/brokerRecordService'),
  recordGrantIssued: (...args) => mockRecordGrantIssued(...args),
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/Installable', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/githubAppService', () => ({}));
jest.mock('../../../models/ToolCall', () => ({ __esModule: true, default: {}, digestArgs: jest.fn(), reserveBudgetLineage: jest.fn() }));
jest.mock('../../../services/outsiderGrantPodEligibility', () => ({
  outsiderGrantPodRefusal: jest.fn(async () => null),
  outsiderGrantRefusalMessage: jest.fn((reason) => (reason === 'pod_joinable'
    ? 'Agents can self-install into this pod. Make it invite-only to use this connector.'
    : `Use a separate pod: ${reason}`)),
}));

const Pod = require('../../../models/Pod');
const Integration = require('../../../models/Integration');
const Installable = require('../../../models/Installable');
const { buildGithubToolInstallable, GRANT_BROKER_ID } = require('../../../services/installable/toolInstallables');
const { HOSTED_MCP_ENTRIES } = require('../../../integrations/hostedMcp/entries');
const { outsiderGrantPodRefusal } = require('../../../services/outsiderGrantPodEligibility');

const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const SEAT = 'cccccccccccccccccccccc01';

let mongod;
let RoomGrant;
let app;

const mint = (body) => request(app).post('/api/grants').set('x-test-user', OWNER).send({
  connectionId: 'conn-1',
  target: { kind: 'pod', id: POD },
  tools: ['github.list_issues'],
  writeMode: 'read',
  budget: { calls: 10, windowMs: 60000 },
  // Relative, not a fixed date: this fixture pinned `2026-10-01T00:00:00Z`, which
  // the mint refuses as `invalid_expiry` once the clock passes it — five arms in
  // this file went red on their own the morning of 2026-10-01, on main, with no
  // code change (measured at `91cc32af`). The expiry is not what any arm here is
  // about; the grant's own expiry rules are asserted elsewhere.
  expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  ...body,
});

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
  jest.clearAllMocks();
  outsiderGrantPodRefusal.mockResolvedValue(null);
  await RoomGrant.deleteMany({});
  Pod.findById.mockImplementation((id) => ({
    select: () => ({ lean: async () => (String(id) === POD ? { _id: POD, type: 'team', members: [OWNER, SEAT] } : null) }),
  }));
  Integration.findById.mockResolvedValue(null);
  Integration.findOne.mockImplementation(async ({ installationId }) => (installationId === 'conn-1'
    ? {
      _id: 'conn-1', type: 'github-app', status: 'connected', createdBy: OWNER,
      installationId: 'install-1', config: { installationId: 'install-1', owner: 'octo', repo: 'demo' },
    }
    : null));
  Installable.findOne.mockReturnValue({ lean: async () => buildGithubToolInstallable() });
});

describe('POST /api/grants', () => {
  test('an explicit empty pod audience is refused without saving a grant', async () => {
    const res = await mint({ audience: [] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_audience', message: 'name at least one agent, or omit audience for all current members' });
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('omitting pod audience keeps the current member snapshot', async () => {
    const res = await mint({});
    expect(res.status).toBe(201);
    expect(res.body.audience).toEqual([OWNER, SEAT]);
  });

  // TASK-019: create mints pod grants only. A seat target used to pass the
  // target check and reach 201 here only because the outsider gate is mocked
  // to null; the real gate refuses every non-pod target.
  test.each([{ audience: undefined }, { audience: [SEAT] }, { audience: [OWNER, SEAT] }])('a seat target is refused at the target check: %p', async ({ audience }) => {
    const res = await mint({ target: { kind: 'seat', id: SEAT }, ...(audience === undefined ? {} : { audience }) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_target', message: 'target.kind must be pod' });
    expect(outsiderGrantPodRefusal).not.toHaveBeenCalled();
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('the real outsider gate refuses a seat target, so the check above loses nothing', async () => {
    const real = jest.requireActual('../../../services/outsiderGrantPodEligibility');
    await expect(real.outsiderGrantPodRefusal({ kind: 'seat', id: SEAT })).resolves.toBe('pod_required');
  });

  test('an agent User ID used as a pod target returns not-found before join-policy checks', async () => {
    outsiderGrantPodRefusal.mockResolvedValue('pod_joinable');
    const res = await mint({ target: { kind: 'pod', id: SEAT } });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'target_not_found', message: 'target pod not found' });
    expect(outsiderGrantPodRefusal).not.toHaveBeenCalled();
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test.each([
    // A seat now stops at the target check (above); the gate's pod_required
    // still maps to its 403 for a pod it cannot resolve.
    ['pod_required', { kind: 'pod', id: POD }],
    ['pod_not_private', { kind: 'pod', id: POD }],
    ['pod_bridged', { kind: 'pod', id: POD }],
    ['non_native_agent', { kind: 'pod', id: POD }],
    ['write_mode_unconfined', { kind: 'pod', id: POD }],
  ])('refuses outsider connector attach when %s', async (reason, target) => {
    outsiderGrantPodRefusal.mockResolvedValue(reason);
    const res = await mint({ target });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: `outsider_grant_${reason}` });
    expect(res.body.message).toMatch(/separate pod/);
    expect(outsiderGrantPodRefusal).toHaveBeenCalledWith(target, 'read');
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('offers an in-place policy fix only when joinability is the sole refusal', async () => {
    outsiderGrantPodRefusal.mockResolvedValueOnce('pod_joinable').mockResolvedValueOnce(null);
    const res = await mint({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'outsider_grant_pod_joinable' });
    expect(res.body.message).toMatch(/Agents can self-install into this pod/);
    expect(outsiderGrantPodRefusal).toHaveBeenLastCalledWith(
      { kind: 'pod', id: POD }, 'read', { assumeInviteOnly: true },
    );
  });

  test('a bridged pod names the remaining refusal instead of offering an in-place fix', async () => {
    outsiderGrantPodRefusal.mockResolvedValueOnce('pod_joinable').mockResolvedValueOnce('pod_bridged');
    const res = await mint({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'outsider_grant_pod_bridged' });
    expect(res.body.message).toMatch(/separate pod/);
  });

  test('brokerId comes from the tool Installable, never the body', async () => {
    const res = await mint({});
    expect(res.status).toBe(201);
    const row = await RoomGrant.findOne({ grantId: res.body.grantId }).lean();
    expect(row.brokerId).toBe(GRANT_BROKER_ID);
    expect(row.tools).toEqual(['github.list_issues']);
    expect(Installable.findOne).toHaveBeenCalledWith({ installableId: 'github', source: 'builtin', status: 'active' });
  });

  test('a client-supplied brokerId is refused', async () => {
    for (const brokerId of ['attacker-proxy', GRANT_BROKER_ID, '']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await mint({ brokerId });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_broker' });
    }
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('the mint refuses a tool the Installable does not enable', async () => {
    const res = await mint({ tools: ['github.list_issues', 'github.delete_repo'] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_tools' });
    expect(res.body.message).toMatch(/github\.delete_repo/);
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('installationId comes from the connection, never the body', async () => {
    const res = await mint({});
    expect(res.status).toBe(201);
    expect(res.body.installationId).toBe('install-1');
    const row = await RoomGrant.findOne({ grantId: res.body.grantId }).lean();
    expect(row.installationId).toBe('install-1');
    expect(row.connectionId).toBe('conn-1');
  });

  test('a client-supplied installationId is refused', async () => {
    for (const installationId of ['install-2', 'install-1', '']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await mint({ installationId });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_installation' });
    }
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('a connection without an installation is a mismatch', async () => {
    Integration.findOne.mockResolvedValue({ _id: 'conn-1', type: 'github-app', status: 'connected', createdBy: OWNER, config: {} });
    const res = await mint({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'connection_mismatch' });
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('the mint refuses with broker_unavailable when no tool Installable is seeded', async () => {
    Installable.findOne.mockReturnValue({ lean: async () => null });
    const res = await mint({});
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'broker_unavailable' });
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });
});

/**
 * Scope §7: the mint admits `hosted-mcp` beside `github-app`, takes the row's
 * `_id` as the grant's installationId, requires a connected row with a
 * credential, refuses `write` (§5a), and lets a grant name only tools from the
 * row's own entry.
 *
 * Each arm runs against the catalogue it NAMES, swapped in for the duration and
 * restored after: the fixtures call their entry `linear`, which is also the id
 * the shipped catalogue now carries (step 7), and `findHostedMcpEntry` answers
 * first-wins — so a fixture pushed beside the shipped entry would never be
 * found, and the arm that asserts the catalogue is what stops the mint would
 * silently run against a catalogue that is not empty.
 */
const HOSTED_ID = 'eeeeeeeeeeeeeeeeeeeeee01';

const pinned = (over) => ({
  name: 'list_issues', upstreamName: 'list_issues', description: 'List issues',
  class: 'read', inputSchema: { type: 'object' }, ...over,
});

const ENTRY = {
  id: 'linear', title: 'Linear', resource: 'https://mcp.linear.app/mcp',
  issuer: 'https://mcp.linear.app', client: 'cimd', scopes: ['read'],
  revoke: 'https://mcp.linear.app/token', tools: [pinned({})],
};

const OTHER_ENTRY = {
  ...ENTRY, id: 'acme', title: 'Acme', resource: 'https://mcp.acme.example/mcp',
  tools: [pinned({ name: 'list_tickets', upstreamName: 'list_tickets', description: 'List tickets' })],
};

const hostedRow = (config = {}, over = {}) => ({
  _id: HOSTED_ID, type: 'hosted-mcp', status: 'connected', createdBy: OWNER,
  config: { entryId: 'linear', credentialRef: 'secret-ref-1', ...config }, ...over,
});

const hostedMint = (body = {}) => mint({ connectionId: HOSTED_ID, tools: ['linear.list_issues'], ...body });

/** Run `run` with exactly `entries` in the catalogue, then restore it exactly. */
const withCatalog = async (entries, run) => {
  const shipped = HOSTED_MCP_ENTRIES.splice(0, HOSTED_MCP_ENTRIES.length, ...entries);
  try {
    return await run();
  } finally {
    HOSTED_MCP_ENTRIES.splice(0, HOSTED_MCP_ENTRIES.length, ...shipped);
  }
};

describe('POST /api/grants on a hosted-mcp connection', () => {
  describe('hidden-entry mint policy', () => {
    let previousHidden;
    let previousAllowlist;
    beforeEach(() => {
      previousHidden = process.env.HOSTED_MCP_HIDDEN_ENTRIES;
      previousAllowlist = process.env.HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST;
      process.env.HOSTED_MCP_HIDDEN_ENTRIES = JSON.stringify(['linear']);
      delete process.env.HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST;
      Integration.findById.mockResolvedValue(hostedRow());
    });
    afterEach(() => {
      if (previousHidden === undefined) delete process.env.HOSTED_MCP_HIDDEN_ENTRIES;
      else process.env.HOSTED_MCP_HIDDEN_ENTRIES = previousHidden;
      if (previousAllowlist === undefined) delete process.env.HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST;
      else process.env.HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST = previousAllowlist;
    });

    test.each([
      ['no exception', undefined],
      ['another user', JSON.stringify({ linear: [SEAT] })],
      ['invalid JSON', '{broken'],
      ['invalid user in map', JSON.stringify({ linear: [OWNER, 'invalid'] })],
      ['unknown key in map', JSON.stringify({ linear: [OWNER], typo: [OWNER] })],
    ])('a previously connected hidden row refuses mint with %s', async (_, allowlist) => {
      if (allowlist !== undefined) process.env.HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST = allowlist;
      const res = await withCatalog([ENTRY], () => hostedMint({ userId: SEAT, ownerId: SEAT }));
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'unknown_entry' });
      expect(await RoomGrant.countDocuments({})).toBe(0);
    });

    test.each([undefined, '', '   '])('a hosted row without an entry ID refuses before mint: %p', async (entryId) => {
      Integration.findById.mockResolvedValue(hostedRow({ entryId }));
      const res = await withCatalog([ENTRY], () => hostedMint());
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'unknown_entry' });
      expect(await RoomGrant.countDocuments({})).toBe(0);
    });

    test('the exact authenticated allowlisted owner may mint', async () => {
      process.env.HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST = JSON.stringify({ linear: [OWNER] });
      const res = await withCatalog([ENTRY], () => hostedMint());
      expect(res.status).toBe(201);
      expect(await RoomGrant.countDocuments({ grantId: res.body.grantId })).toBe(1);
    });

    test('hiding another entry leaves this connected row grantable', async () => {
      process.env.HOSTED_MCP_HIDDEN_ENTRIES = JSON.stringify(['acme']);
      const res = await withCatalog([ENTRY], () => hostedMint());
      expect(res.status).toBe(201);
    });
  });

  test('a connected hosted row is admitted; what stops the mint is the catalogue, not its type', async () => {
    Integration.findById.mockResolvedValue(hostedRow());
    // The catalogue is emptied for this arm on purpose: since step 7 the shipped
    // one carries `linear`, so without this the arm would be measuring the
    // shipped entry rather than the refusal it names.
    const res = await withCatalog([], () => hostedMint());
    // A type the mint does not admit is refused `connection_mismatch`; this is
    // the other outcome, so the arm is evidence the type check was widened.
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'broker_unavailable' });
    expect(res.body.message).toMatch(/linear/);
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test("the grant's installationId and connectionId are the row's _id, and its broker is the one proxy", async () => {
    Integration.findById.mockResolvedValue(hostedRow());
    const res = await withCatalog([ENTRY], () => hostedMint());
    expect(res.status).toBe(201);
    const row = await RoomGrant.findOne({ grantId: res.body.grantId }).lean();
    expect(row.connectionId).toBe(HOSTED_ID);
    expect(row.installationId).toBe(HOSTED_ID);
    expect(row.brokerId).toBe(GRANT_BROKER_ID);
    expect(row.tools).toEqual(['linear.list_issues']);
  });

  test("a hosted grant cannot name another entry's tool", async () => {
    Integration.findById.mockResolvedValue(hostedRow());
    const res = await withCatalog([ENTRY, OTHER_ENTRY], () => hostedMint({ tools: ['acme.list_tickets'] }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_tools' });
    expect(res.body.message).toMatch(/acme\.list_tickets/);
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  // TASK-255: a tool of this same entry that the entry does not pin.
  test('a hosted grant cannot name a tool its entry does not pin', async () => {
    Integration.findById.mockResolvedValue(hostedRow());
    const res = await withCatalog([ENTRY], () => hostedMint({ tools: ['linear.delete_issue'], writeMode: 'write-with-confirm' }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_tools' });
    expect(res.body.message).toMatch(/linear\.delete_issue/);
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('write is refused on a hosted row, and write-with-confirm is not', async () => {
    Integration.findById.mockResolvedValue(hostedRow());
    const refused = await withCatalog([ENTRY], () => hostedMint({ writeMode: 'write' }));
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'write_requires_confirm' });
    expect(await RoomGrant.countDocuments({})).toBe(0);

    // The control for the arm above: the same row and body, one field changed,
    // and the mint proceeds — so the refusal is about the mode, not the type.
    const allowed = await withCatalog([ENTRY], () => hostedMint({ writeMode: 'write-with-confirm' }));
    expect(allowed.status).toBe(201);
  });

  test('a github-app write grant is refused by the CTO pod-eligibility ruling', async () => {
    outsiderGrantPodRefusal.mockResolvedValue('write_mode_unconfined');
    const res = await mint({ writeMode: 'write' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'outsider_grant_write_mode_unconfined' });
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('a hosted row with no credential is a mismatch, and one that is still pending is too', async () => {
    Integration.findById.mockResolvedValue(hostedRow({ credentialRef: undefined }));
    const noCredential = await hostedMint();
    expect(noCredential.status).toBe(403);
    expect(noCredential.body).toMatchObject({ error: 'connection_mismatch' });

    Integration.findById.mockResolvedValue(hostedRow({}, { status: 'pending' }));
    const pending = await hostedMint();
    expect(pending.status).toBe(403);
    expect(pending.body).toMatchObject({ error: 'connection_mismatch' });
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('a hosted grant takes no installationId from the body either', async () => {
    Integration.findById.mockResolvedValue(hostedRow());
    const res = await hostedMint({ installationId: HOSTED_ID });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_installation' });
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });
});

// TASK-560: a minted grant reaches the record once, issued by whoever minted it.
describe('record wiring', () => {
  test('the owner mints: grant.issued names the owner as a person', async () => {
    const res = await mint({});
    expect(res.status).toBe(201);
    expect(mockRecordGrantIssued).toHaveBeenCalledTimes(1);
    const [grant, issuer] = mockRecordGrantIssued.mock.calls[0];
    expect(grant).toMatchObject({ grantId: res.body.grantId, target: { kind: 'pod', id: POD } });
    expect(typeof grant.toObject).toBe('undefined');
    expect(issuer).toEqual({ type: 'human', id: OWNER });
  });

  test('a refused mint writes nothing', async () => {
    expect((await mint({ audience: [] })).status).toBe(400);
    expect(mockRecordGrantIssued).not.toHaveBeenCalled();
  });

  test('an agent attenuates: the child is issued by that agent, as an agent', async () => {
    const parent = await mint({});
    mockRecordGrantIssued.mockClear();
    const res = await request(app).post(`/api/grants/${parent.body.grantId}/attenuate`)
      .set('x-test-agent', SEAT).set('x-test-agent-owner', OWNER)
      .send({ tools: ['github.list_issues'], expiresAt: new Date(Date.now() + 86400000).toISOString() });
    expect(res.status).toBe(201);
    const [child, issuer] = mockRecordGrantIssued.mock.calls[0];
    expect(child).toMatchObject({ grantId: res.body.grantId, parentGrantId: parent.body.grantId });
    expect(issuer).toEqual({ type: 'agent', id: SEAT, owner: OWNER });
  });
});

describe('task-bound mint', () => {
  const Task = require('../../../models/Task');
  beforeEach(async () => {
    await Task.deleteMany({});
    await Task.create({ podId: POD, taskNum: 1, taskId: 'TASK-1', title: 'Task-bound grant', status: 'pending' });
  });
  test('stores the authorized task tuple and ignores caller epoch values', async () => {
    const res = await mint({ binding: { taskId: 'TASK-1', podId: POD }, taskEpoch: 999 });
    expect(res.status).toBe(201);
    expect(res.body.binding).toEqual({ taskId: 'TASK-1', podId: POD, endsOn: 'task.done' });
    expect(res.body.taskEpoch).toBe(0);
  });
  test.each([
    { taskId: 'TASK-1', podId: 'aaaaaaaaaaaaaaaaaaaaaa02' },
    { taskId: 'TASK-404', podId: POD },
    { taskId: 'TASK-1' },
  ])('rejects foreign or missing task context without saving: %p', async (binding) => {
    const res = await mint({ binding });
    expect([400, 404]).toContain(res.status);
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });
  test('refuses a binding that ends on anything but task.done, without saving', async () => {
    const res = await mint({ binding: { taskId: 'TASK-1', podId: POD, endsOn: 'expiresAt' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_task_binding');
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });
  test('the route leaves a bound grant to mintGrant, so the record gets one line', async () => {
    mockRecordGrantIssued.mockClear();
    const res = await mint({ binding: { taskId: 'TASK-1', podId: POD } });
    expect(res.status).toBe(201);
    expect(mockRecordGrantIssued).not.toHaveBeenCalled();
  });
  test('rejects a closed task', async () => {
    await Task.updateOne({ podId: POD, taskId: 'TASK-1' }, { $set: { status: 'done' } });
    const res = await mint({ binding: { taskId: 'TASK-1', podId: POD } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('task_closed');
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });
});
