// The X and Instagram feed credentials are stored through connectorSecrets, the
// way Slack's bot token and the hosted-MCP pair are. Real Mongo, real models,
// real routes and the real X provider; only the vendor HTTP calls are stubbed.
// Each case reads the RAW stored row, so a token written to `config` under any
// key fails the "no material on the row" assertion.
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'bbbbbbbbbbbbbbbbbbbbbb01' };
  req.userId = req.user.id;
  next();
});

const axios = require('axios');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const Integration = require('../../../models/Integration');
const OAuthState = require('../../../models/OAuthState');
const ConnectorSecret = require('../../../models/ConnectorSecret');
const router = require('../../../routes/admin/globalIntegrations');
const integrationRoutes = require('../../../routes/integrations');
const externalFeedService = require('../../../services/externalFeedService');
const {
  readFeedAccessToken,
  readFeedRefreshToken,
  takeFeedTokens,
} = require('../../../services/feedCredentials');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const key = (fill) => Buffer.alloc(32, fill).toString('base64');

const handlerFor = (path, method) => {
  const layer = router.stack.find(
    (entry) => entry.route && entry.route.path === path && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const createRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res;
};

const rawRow = (type) => Integration.collection.findOne({ type });

const expectNoMaterialOnRow = (row, ...materials) => {
  expect(row.config.accessToken).toBeUndefined();
  expect(row.config.refreshToken).toBeUndefined();
  const serialized = JSON.stringify(row);
  materials.forEach((material) => expect(serialized).not.toContain(material));
};

describe('feed credentials are stored through connectorSecrets', () => {
  const saved = {
    keys: process.env.CONNECTOR_SECRET_KEYS,
    activeKey: process.env.CONNECTOR_SECRET_ACTIVE_KEY,
    clientId: process.env.X_OAUTH_CLIENT_ID,
  };
  const adminId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await setupMongoDb();
    await ConnectorSecret.syncIndexes();
  });

  afterAll(async () => {
    await closeMongoDb();
    process.env.CONNECTOR_SECRET_KEYS = saved.keys;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = saved.activeKey;
    process.env.X_OAUTH_CLIENT_ID = saved.clientId;
  });

  beforeEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
    process.env.CONNECTOR_SECRET_KEYS = `k1:${key(7)}`;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k1';
    process.env.X_OAUTH_CLIENT_ID = 'test-client';
  });

  const connectX = async () => {
    await OAuthState.create({
      provider: 'x',
      state: 'state-1',
      userId: adminId,
      codeVerifier: 'verifier',
      expiresAt: new Date(Date.now() + 60_000),
    });
    axios.post.mockResolvedValueOnce({
      data: {
        access_token: 'x-access-1', refresh_token: 'x-refresh-1', token_type: 'bearer', expires_in: 7200,
      },
    });
    axios.get.mockResolvedValueOnce({ data: { data: { id: 'x-user-1', username: 'commonly' } } });
    const res = createRes();
    await handlerFor('/x/oauth/callback', 'get')({ query: { state: 'state-1', code: 'code-1' } }, res);
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('xOAuth=success'));
  };

  it('stores the X pair on OAuth connect and the reader resolves it', async () => {
    await connectX();

    const row = await rawRow('x');
    expectNoMaterialOnRow(row, 'x-access-1', 'x-refresh-1');
    expect(row.config.feedAccessTokenRef).toEqual(expect.any(String));
    expect(row.config.feedRefreshTokenRef).toEqual(expect.any(String));
    expect(await readFeedAccessToken(row.config)).toBe('x-access-1');
    expect(await readFeedRefreshToken(row.config)).toBe('x-refresh-1');
  });

  it('writes a refreshed X pair back through the store, and the sync calls X with it', async () => {
    await connectX();
    const before = await rawRow('x');
    // Expired, so the sync refreshes before it reads the timeline.
    await Integration.updateOne({ _id: before._id }, { $set: { 'config.tokenExpiresAt': new Date(Date.now() - 1000) } });
    axios.post.mockResolvedValueOnce({
      data: { access_token: 'x-access-2', refresh_token: 'x-refresh-2', expires_in: 7200 },
    });
    axios.get.mockResolvedValue({ data: { data: [] } });

    const [result] = await externalFeedService.syncExternalFeeds();
    expect(result.success).toBe(true);

    // The reader handed the stored refresh token to X, and the timeline call
    // carried the refreshed access token.
    expect(String(axios.post.mock.calls[1][1])).toContain('refresh_token=x-refresh-1');
    expect(axios.get.mock.calls.at(-1)[1].headers.Authorization).toBe('Bearer x-access-2');

    const after = await rawRow('x');
    expectNoMaterialOnRow(after, 'x-access-1', 'x-refresh-1', 'x-access-2', 'x-refresh-2');
    // The store upserts on (row, kind): a rotation keeps the refs it replaces.
    expect(after.config.feedAccessTokenRef).toBe(before.config.feedAccessTokenRef);
    expect(after.config.feedRefreshTokenRef).toBe(before.config.feedRefreshTokenRef);
    expect(await readFeedAccessToken(after.config)).toBe('x-access-2');
    expect(await readFeedRefreshToken(after.config)).toBe('x-refresh-2');
  });

  it('stores the Instagram token from the save form and keeps it on a blank re-save', async () => {
    const save = handlerFor('/instagram', 'post');
    const body = { enabled: true, username: 'commonly', igUserId: 'ig-1' };

    const first = createRes();
    await save({ userId: String(adminId), body: { ...body, accessToken: 'ig-token-1' } }, first);
    expect(first.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const row = await rawRow('instagram');
    expectNoMaterialOnRow(row, 'ig-token-1');
    expect(await readFeedAccessToken(row.config)).toBe('ig-token-1');

    // The form sends a token only when one is typed; a blank field keeps it.
    const second = createRes();
    await save({ userId: String(adminId), body }, second);
    expect(second.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const kept = await rawRow('instagram');
    expect(kept.config.feedAccessTokenRef).toBe(row.config.feedAccessTokenRef);
    expect(await readFeedAccessToken(kept.config)).toBe('ig-token-1');
  });

  it('refuses a blank-token save when no stored token resolves', async () => {
    const res = createRes();
    await handlerFor('/x', 'post')({
      userId: String(adminId), body: { enabled: true, username: 'commonly', userId: 'x-user-1' },
    }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(await Integration.countDocuments({ type: 'x' })).toBe(0);
  });

  it('stores the token a generic connector create or edit supplies', async () => {
    const member = 'bbbbbbbbbbbbbbbbbbbbbb01';
    // The edit gate reads the caller's User row.
    await User.create({
      _id: member, username: 'feed-owner', email: 'feed-owner@example.test', password: 'unused-password',
    });
    const pod = await Pod.create({ name: 'Feeds', createdBy: member, members: [member] });
    const app = express();
    app.use(express.json());
    app.use('/api/integrations', integrationRoutes);

    const created = await request(app).post('/api/integrations').send({
      podId: String(pod._id), type: 'x', config: { accessToken: 'x-generic-1', username: 'commonly' },
    });
    expect(created.status).toBe(201);
    const row = await rawRow('x');
    expectNoMaterialOnRow(row, 'x-generic-1');
    expect(row.status).toBe('connected');
    expect(await readFeedAccessToken(row.config)).toBe('x-generic-1');

    const edited = await request(app).patch(`/api/integrations/${row._id}`).send({
      config: { accessToken: 'x-generic-2' },
    });
    expect(edited.status).toBe(200);
    const after = await rawRow('x');
    expectNoMaterialOnRow(after, 'x-generic-1', 'x-generic-2');
    expect(after.config.feedAccessTokenRef).toBe(row.config.feedAccessTokenRef);
    expect(after.config.username).toBe('commonly');
    expect(await readFeedAccessToken(after.config)).toBe('x-generic-2');
  });

  it('splits the token fields out of a supplied config', () => {
    expect(takeFeedTokens({ accessToken: 'a', refreshToken: 'r', username: 'u' })).toEqual({
      rest: { username: 'u' },
      tokens: { accessToken: 'a', refreshToken: 'r' },
    });
  });
});
