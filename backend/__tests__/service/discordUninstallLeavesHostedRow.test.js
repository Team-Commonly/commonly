// TASK-172 §10 step 6b / TASK-147: the legacy Discord uninstall route
// (`routes/discord.ts:241`) is one of the four row-removing paths. It matches
// `{ installationId, type: 'discord' }` and deletes with `findByIdAndDelete`,
// so it neither reaches a hosted row (no `installationId`, and the type is
// `hosted-mcp`) nor ends grants — which is why it can only ever be a witness on
// the paths it does NOT take, not a place a hosted grant can be stranded.
//
// Real mongod. The control is the Discord row the SAME call deletes: without it
// "the hosted row survived" is also what a 404, a 403 or a crash produces. The
// github-app row is the second control Vera 75311 asks for on this path — a
// grantable shape that is untouched with its grant still active.
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.PG_HOST = '';

// Literal, for the same reason as the admin suite: a `jest.mock` factory cannot
// close over an out-of-scope binding, so the id has to match on both sides.
const OWNER = '6a8f6de2a1dccf2e02f31401';

jest.mock('../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: '6a8f6de2a1dccf2e02f31401' };
  next();
});
jest.mock('../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../models/Pod', () => ({ findById: jest.fn() }));

let mongod;
let app;
let Integration;
let DiscordIntegration;
let RoomGrant;
let User;
let Pod;

const hostedRow = () => ({
  type: 'hosted-mcp',
  scope: 'user',
  status: 'connected',
  createdBy: OWNER,
  config: { entryId: 'linear', intake: 'oauth', credentialRef: 'secret-access-1' },
});

const grantFixture = (overrides = {}) => ({
  grantId: new mongoose.Types.ObjectId().toString(),
  connectionId: 'placeholder',
  installationId: 'install-1',
  target: { kind: 'pod', id: new mongoose.Types.ObjectId() },
  tools: ['linear.create_issue'],
  writeMode: 'read',
  audience: [String(OWNER)],
  expiresAt: new Date(Date.now() + 3_600_000),
  brokerId: 'hosted-mcp',
  ...overrides,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  Integration = require('../../models/Integration');
  DiscordIntegration = require('../../models/DiscordIntegration');
  RoomGrant = require('../../models/RoomGrant');
  User = require('../../models/User');
  Pod = require('../../models/Pod');
  await RoomGrant.syncIndexes();
  await Integration.syncIndexes();
  app = express();
  app.use(express.json());
  app.use('/api/discord', require('../../routes/discord'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await RoomGrant.deleteMany({});
  await Integration.deleteMany({});
  await DiscordIntegration.deleteMany({});
  User.findById.mockResolvedValue({ _id: OWNER, role: 'user' });
  Pod.findById.mockResolvedValue(null);
});

test('the legacy Discord uninstall removes its own row and neither hosted nor github-app rows', async () => {
  const discordRow = await Integration.create({
    type: 'discord',
    status: 'connected',
    createdBy: OWNER,
    scope: 'pod',
    podId: new mongoose.Types.ObjectId(),
    installationId: 'discord-install-1',
    config: { serverId: 'guild-1' },
  });
  await DiscordIntegration.create({
    integrationId: discordRow._id,
    guildId: 'guild-1',
    serverId: 'guild-1',
    serverName: 'Commonly Dev',
    channelId: 'chan-1',
    channelName: 'general',
    webhookId: 'hook-1',
  });
  const hosted = await Integration.create(hostedRow());
  const githubRow = await Integration.create({
    type: 'github-app',
    scope: 'user',
    status: 'connected',
    createdBy: OWNER,
    config: { repo: 'Team-Commonly/commonly' },
  });
  // A grant on each survivor, so "untouched" covers the grants and not just the
  // row: this route ends no grants at all, and a hosted grant left behind is
  // exactly the residue TASK-147 is about.
  const hostedGrant = await RoomGrant.create(grantFixture({ connectionId: String(hosted._id) }));
  const githubGrant = await RoomGrant.create(grantFixture({
    connectionId: String(githubRow._id),
    brokerId: 'github-app',
  }));

  const res = await request(app).delete('/api/discord/uninstall/discord-install-1');

  expect(res.status).toBe(200);
  // Control: the route ran and deleted the row it selected.
  expect(await Integration.collection.findOne({ _id: discordRow._id })).toBeNull();
  expect(await DiscordIntegration.collection.findOne({ integrationId: discordRow._id })).toBeNull();

  const rawHosted = await Integration.collection.findOne({ _id: hosted._id });
  expect(rawHosted).not.toBeNull();
  expect(rawHosted.config.credentialRef).toBe('secret-access-1');
  // Not a removal path for it: the row is not even marked disconnected.
  expect(rawHosted.status).toBe('connected');
  const rawGithub = await Integration.collection.findOne({ _id: githubRow._id });
  expect(rawGithub).not.toBeNull();

  // A grant is live when `revokedAt` is null — there is no status column, so
  // "still active" has to be read as the absence of the revocation stamp.
  const rawHostedGrant = await RoomGrant.collection.findOne({ _id: hostedGrant._id });
  expect(rawHostedGrant.revokedAt ?? null).toBeNull();
  const rawGithubGrant = await RoomGrant.collection.findOne({ _id: githubGrant._id });
  expect(rawGithubGrant.revokedAt ?? null).toBeNull();
});

test('the route cannot reach a hosted row even when the ids collide', async () => {
  // The address is a bare `installationId` from the URL, so the only thing
  // keeping a hosted row out of this destructive legacy route is the TYPE
  // filter — this arm is what pins that, by handing it a hosted row that also
  // carries the installationId it was asked to remove. A hosted row shipped by
  // the connect route never has one (asserted in the row-shape suite), so this
  // is the tripwire for the change that gives it one.
  const hostile = await Integration.create({ ...hostedRow(), installationId: 'collide-1' });

  const res = await request(app).delete('/api/discord/uninstall/collide-1');

  expect(res.status).toBe(404);
  const raw = await Integration.collection.findOne({ _id: hostile._id });
  expect(raw).not.toBeNull();
  expect(raw.status).toBe('connected');
});
