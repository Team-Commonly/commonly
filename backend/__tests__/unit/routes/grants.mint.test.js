/**
 * Tools plan §2 / §6 — the mint takes its broker from the seeded tool
 * Installable and lets a grant allow only tools that Installable enables.
 * RoomGrant runs on memory Mongo; the pod, the connection and the seeded
 * Installable are mocked at their module boundaries, as grants.read does.
 * The follow-up (Vera 67821) adds: the grant's installationId is the
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
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/Installable', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/githubAppService', () => ({}));
jest.mock('../../../models/ToolCall', () => ({ __esModule: true, default: {}, digestArgs: jest.fn(), reserveBudgetLineage: jest.fn() }));

const Pod = require('../../../models/Pod');
const Integration = require('../../../models/Integration');
const Installable = require('../../../models/Installable');
const { buildGithubToolInstallable, GRANT_BROKER_ID } = require('../../../services/installable/toolInstallables');
const { HOSTED_MCP_ENTRIES } = require('../../../integrations/hostedMcp/entries');

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
  expiresAt: new Date('2026-10-01T00:00:00.000Z').toISOString(),
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
 * row's own entry. `HOSTED_MCP_ENTRIES` is empty in v1, so the catalogue arms
 * push a fixture entry for the duration of the arm and restore the array.
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

/** Run `run` with the catalogue seeded, then restore it exactly. */
const withCatalog = async (entries, run) => {
  const before = HOSTED_MCP_ENTRIES.length;
  HOSTED_MCP_ENTRIES.push(...entries);
  try {
    return await run();
  } finally {
    HOSTED_MCP_ENTRIES.length = before;
  }
};

describe('POST /api/grants on a hosted-mcp connection', () => {
  test('a connected hosted row is admitted; what stops the mint is the catalogue, not its type', async () => {
    Integration.findById.mockResolvedValue(hostedRow());
    const res = await hostedMint();
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

  test('the write refusal is hosted-only: a github-app row still mints write', async () => {
    // The control for the `hosted &&` conjunct in that refusal. Without this
    // arm, dropping the conjunct refuses a github write grant and no test says so.
    const res = await mint({ writeMode: 'write' });
    expect(res.status).toBe(201);
    const row = await RoomGrant.findOne({ grantId: res.body.grantId }).lean();
    expect(row.writeMode).toBe('write');
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
