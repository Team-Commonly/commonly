/**
 * F172 ruling 3: a grant on a Commonly Connect connection is not minted while
 * the Connect key is unset, so an owner never holds a grant that cannot run.
 * The refusal is `github_app_not_configured` (503) and nothing is saved. A
 * tools row (or a legacy row with no `app`) mints whether or not Connect is
 * configured, and a row naming an unknown App is refused as a mismatch.
 * Same harness as grants.mint.test.js: RoomGrant on memory Mongo, the pod, the
 * connection and the seeded Installable mocked at their module boundaries.
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
jest.mock('../../../middleware/agentRuntimeAuth', () => (_req, _res, next) => next());
jest.mock('../../../services/brokerRecordService', () => ({
  ...jest.requireActual('../../../services/brokerRecordService'),
  recordGrantIssued: jest.fn(),
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/Installable', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/githubAppService', () => ({}));
jest.mock('../../../models/ToolCall', () => ({ __esModule: true, default: {}, digestArgs: jest.fn(), reserveBudgetLineage: jest.fn() }));
jest.mock('../../../services/outsiderGrantPodEligibility', () => ({
  outsiderGrantPodRefusal: jest.fn(async () => null),
  outsiderGrantRefusalMessage: jest.fn((reason) => reason),
}));

const Pod = require('../../../models/Pod');
const Integration = require('../../../models/Integration');
const Installable = require('../../../models/Installable');
const { buildGithubToolInstallable } = require('../../../services/installable/toolInstallables');

const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const SEAT = 'cccccccccccccccccccccc01';
const ROW = 'dddddddddddddddddddddd01';
const ENV_KEYS = ['GITHUB_CONNECT_APP_ID', 'GITHUB_CONNECT_APP_PRIVATE_KEY', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY'];
const savedEnv = {};

let mongod;
let RoomGrant;
let app;
let caller = 0;

const mint = (body = {}) => request(app).post('/api/grants').set('x-test-user', OWNER)
  .set('x-auth-token', `connect-caller-${caller}`)
  .send({
    connectionId: ROW,
    target: { kind: 'pod', id: POD },
    tools: ['github.list_issues'],
    writeMode: 'read',
    budget: { calls: 10, windowMs: 60000 },
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    ...body,
  });

const connectionRow = (app_) => ({
  _id: ROW,
  type: 'github-app',
  status: 'connected',
  createdBy: OWNER,
  config: {
    ...(app_ === undefined ? {} : { app: app_ }), installationId: '7001', owner: 'Outside-Team', repo: 'Widget',
  },
});

beforeAll(async () => {
  ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; });
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  RoomGrant = require('../../../models/RoomGrant'); // eslint-disable-line global-require
  app = express();
  app.use(express.json());
  app.use('/api/grants', require('../../../routes/grants')); // eslint-disable-line global-require
});

afterAll(async () => {
  ENV_KEYS.forEach((k) => { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; });
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  caller += 1;
  jest.clearAllMocks();
  process.env.GITHUB_CONNECT_APP_ID = '424242';
  process.env.GITHUB_CONNECT_APP_PRIVATE_KEY = 'connect-pem';
  // The tools App is configured throughout: a mint that leaned on it would pass.
  process.env.GITHUB_APP_ID = '111';
  process.env.GITHUB_APP_PRIVATE_KEY = 'tools-pem';
  await RoomGrant.deleteMany({});
  Pod.findById.mockImplementation((id) => ({
    select: () => ({ lean: async () => (String(id) === POD ? { _id: POD, type: 'team', members: [OWNER, SEAT] } : null) }),
  }));
  Integration.findOne.mockResolvedValue(null);
  Installable.findOne.mockReturnValue({ lean: async () => buildGithubToolInstallable() });
});

test('a Connect connection mints when the Connect key is configured', async () => {
  Integration.findById.mockResolvedValue(connectionRow('connect'));
  const res = await mint();
  expect(res.status).toBe(201);
  expect(await RoomGrant.countDocuments({})).toBe(1);
});

test.each([
  ['no id', () => { delete process.env.GITHUB_CONNECT_APP_ID; }],
  ['no key', () => { delete process.env.GITHUB_CONNECT_APP_PRIVATE_KEY; }],
])('a Connect connection is refused github_app_not_configured with %s, and nothing is saved', async (_label, unset) => {
  unset();
  Integration.findById.mockResolvedValue(connectionRow('connect'));
  const res = await mint();
  expect(res.status).toBe(503);
  expect(res.body.error).toBe('github_app_not_configured');
  expect(await RoomGrant.countDocuments({})).toBe(0);
});

test('a prWrite grant on an unconfigured Connect connection is refused the same way', async () => {
  delete process.env.GITHUB_CONNECT_APP_PRIVATE_KEY;
  Integration.findById.mockResolvedValue(connectionRow('connect'));
  const res = await mint({
    tools: ['github.create_pull_request', 'github.commit_files'], writeMode: 'write-with-confirm', prWrite: true, audience: [SEAT],
  });
  expect(res.status).toBe(503);
  expect(res.body.error).toBe('github_app_not_configured');
  expect(await RoomGrant.countDocuments({})).toBe(0);
});

test.each([['tools', 'tools'], ['a legacy row with no app', undefined]])(
  '%s mints while Connect is unconfigured',
  async (_label, app_) => {
    delete process.env.GITHUB_CONNECT_APP_ID;
    delete process.env.GITHUB_CONNECT_APP_PRIVATE_KEY;
    Integration.findById.mockResolvedValue(connectionRow(app_));
    const res = await mint();
    expect(res.status).toBe(201);
    expect(await RoomGrant.countDocuments({})).toBe(1);
  },
);

test('a row naming an unknown App is refused as a mismatch', async () => {
  Integration.findById.mockResolvedValue(connectionRow('elsewhere'));
  const res = await mint();
  expect(res.status).toBe(403);
  expect(res.body.error).toBe('connection_mismatch');
  expect(await RoomGrant.countDocuments({})).toBe(0);
});

test('a per-repository row is minted by its row id; its bare installation id finds nothing (no fallback)', async () => {
  // A per-repository row has no top-level installationId, so the real
  // `findOne({ installationId })` matches nothing for it.
  Integration.findById.mockImplementation(async (id) => (String(id) === ROW ? connectionRow('connect') : null));
  // A database answer: the row carries the installation in config only.
  Integration.findOne.mockImplementation(async (query) => (
    String(query?.['config.installationId'] || '') === '7001' ? connectionRow('connect') : null));
  const byInstallation = await mint({ connectionId: '7001' });
  expect(byInstallation.status).toBe(404);
  expect(byInstallation.body.error).toBe('connection_not_found');
  const byRow = await mint();
  expect(byRow.status).toBe(201);
  expect(byRow.body.connectionId).toBe(ROW);
});
