/**
 * TASK-783 — pull-request access (`prWrite`) is chosen at mint, on a GitHub
 * App grant, as `write-with-confirm`, beside the PR tools and no other write.
 * A BYO seat the grant names may hold it; every other write keeps
 * `byo_read_only`. A child can drop it and never add it.
 *
 * RoomGrant runs on memory Mongo; the pod, connection, catalogue, agent rows,
 * ownership and confinement are mocked at their module boundaries, as in
 * grants.byoNaming.test.js.
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

const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const BYO = 'cccccccccccccccccccccc01';
const HOSTED_SEAT = 'dddddddddddddddddddddd01';
const GH_ID = 'eeeeeeeeeeeeeeeeeeeeee01';
const PR_TOOLS = ['github.get_issue', 'github.create_pull_request', 'github.commit_files'];

let mongod;
let RoomGrant;
let roomGrantService;
let app;
let caller = 0;
let connection;

const mint = (body) => request(app).post('/api/grants').set('x-test-user', OWNER)
  .set('x-auth-token', `pr-caller-${caller}`).send({
    connectionId: GH_ID,
    target: { kind: 'pod', id: POD },
    tools: PR_TOOLS,
    writeMode: 'write-with-confirm',
    prWrite: true,
    audience: [HOSTED_SEAT],
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    ...body,
  });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  RoomGrant = require('../../../models/RoomGrant');
  roomGrantService = require('../../../services/roomGrantService');
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
  await RoomGrant.deleteMany({});
  Pod.findById.mockImplementation((id) => ({
    select: () => ({ lean: async () => (String(id) === POD
      ? { _id: POD, type: 'team', members: [OWNER, BYO, HOSTED_SEAT] } : null) }),
  }));
  connection = {
    _id: GH_ID, type: 'github-app', status: 'connected', createdBy: OWNER, installationId: 'gh-inst-1',
    config: { installationId: 'gh-inst-1', owner: 'Team-Commonly', repo: 'commonly' },
  };
  Integration.findById.mockImplementation(async () => connection);
  Installable.findOne.mockReturnValue({ lean: async () => buildGithubToolInstallable() });
  mockUserFind.mockImplementation(() => ({ select: () => ({ lean: async () => [
    { _id: BYO, botType: 'agent', botMetadata: { agentName: 'lily-claude', instanceId: 'default' } },
  ] }) }));
  mockOwns.mockResolvedValue({ owned: true });
  mockJudge.mockResolvedValue({ refusal: { reason: 'sandbox_trust_not_public' }, scope: 'seat' });
});

describe('minting pull-request access', () => {
  test('is stored when chosen with write-with-confirm and the PR tools', async () => {
    const res = await mint({});
    expect(res.status).toBe(201);
    expect((await RoomGrant.findOne({ grantId: res.body.grantId }).lean()).prWrite).toBe(true);
  });

  test('is off unless chosen: a write-with-confirm grant without it stores none', async () => {
    const res = await mint({ prWrite: undefined });
    expect(res.status).toBe(201);
    expect((await RoomGrant.findOne({ grantId: res.body.grantId }).lean()).prWrite).toBeUndefined();
  });

  test.each([
    ['a non-boolean', { prWrite: 'yes' }, 400, 'invalid_pr_write'],
    ['read mode', { writeMode: 'read' }, 403, 'pr_write_requires_confirm'],
    ['unattended write mode', { writeMode: 'write' }, 403, 'pr_write_requires_confirm'],
    ['no create_pull_request', { tools: ['github.get_issue', 'github.commit_files'] }, 403, 'pr_write_requires_create_pull_request'],
    ['another write beside it', { tools: [...PR_TOOLS, 'github.merge_pull_request'] }, 403, 'pr_write_other_writes'],
  ])('refuses %s', async (_label, body, status, error) => {
    const res = await mint(body);
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(error);
    expect(await RoomGrant.countDocuments({})).toBe(0);
  });

  test('is a GitHub App scope only', () => {
    const { prWriteMintRefusal } = require('../../../services/prWriteScope');
    expect(prWriteMintRefusal({
      connectionType: 'hosted-mcp', writeMode: 'write-with-confirm',
      tools: ['github.create_pull_request'], requiredWriteModeOf: () => 'read',
    })).toBe('pr_write_github_only');
  });

  test('a tool the broker does not know counts as a write', () => {
    const { prWriteMintRefusal } = require('../../../services/prWriteScope');
    expect(prWriteMintRefusal({
      connectionType: 'github-app', writeMode: 'write-with-confirm',
      tools: ['github.create_pull_request', 'github.someday_tool'], requiredWriteModeOf: () => undefined,
    })).toBe('pr_write_other_writes');
  });
});

describe('naming a BYO seat', () => {
  const byo = (body) => mint({ audience: [BYO], byoAgents: [BYO], byoConsent: true, ...body });

  test('a named seat may hold pull-request access', async () => {
    const res = await byo({});
    expect(res.status).toBe(201);
    const row = await RoomGrant.findOne({ grantId: res.body.grantId }).lean();
    expect(row).toMatchObject({ prWrite: true, writeMode: 'write-with-confirm', byoAgents: [BYO] });
    expect(row.byoConsent.version).toBe('byo-pr-v1');
  });

  test('any other write still refuses byo_read_only', async () => {
    const res = await byo({ prWrite: undefined, tools: ['github.get_issue', 'github.create_issue'] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('byo_read_only');
  });

  test('a write-with-confirm grant without the scope still refuses byo_read_only', async () => {
    const res = await byo({ prWrite: undefined });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('byo_read_only');
  });

  test('a seat on a machine with no enforceable sandbox is never named, scope or not', async () => {
    mockJudge.mockResolvedValue({ refusal: { reason: 'sandbox_absent' }, scope: 'seat', hostUnconfined: true });
    const res = await byo({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('byo_unconfined_host');
  });
});

describe('attenuation', () => {
  const parent = (over = {}) => roomGrantService.mintGrant({
    connectionId: GH_ID, installationId: 'gh-inst-1', target: { kind: 'pod', id: POD },
    tools: PR_TOOLS, writeMode: 'write-with-confirm', audience: [HOSTED_SEAT],
    expiresAt: new Date(Date.now() + 86400000), brokerId: 'commonly-grant-broker', ...over,
  });

  test('a child keeps the scope by default and can drop it', async () => {
    const root = await parent({ prWrite: true });
    const kept = await roomGrantService.attenuateGrant({ parentGrantId: root.grantId });
    expect(kept.prWrite).toBe(true);
    const dropped = await roomGrantService.attenuateGrant({ parentGrantId: root.grantId, prWrite: false });
    expect(dropped.prWrite).toBeUndefined();
  });

  test('a read child holds no pull-request access', async () => {
    const root = await parent({ prWrite: true });
    const child = await roomGrantService.attenuateGrant({ parentGrantId: root.grantId, writeMode: 'read' });
    expect(child.prWrite).toBeUndefined();
  });

  test('a child cannot add it', async () => {
    const root = await parent({});
    await expect(roomGrantService.attenuateGrant({ parentGrantId: root.grantId, prWrite: true }))
      .rejects.toMatchObject({ code: 'grant_not_attenuated' });
  });

  test('a body-supplied prWrite on mint input that is not exactly true stores nothing', async () => {
    const root = await parent({ prWrite: 'true' });
    expect(root.prWrite).toBeUndefined();
  });
});
