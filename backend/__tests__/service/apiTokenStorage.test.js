const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const request = require('supertest');
const mongoose = require('mongoose');
const User = require('../../models/User');
const auth = require('../../middleware/auth');
const { hash } = require('../../utils/secret');
const { backfillApiTokenStorage } = require('../../scripts/backfill-api-token-storage');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const app = express();
// Match the existing database-auth probe fixture (runtimeTokenRevoke.test.js).
const probeLimit = rateLimit({ windowMs: 60000, max: 10000 });
app.get('/private', probeLimit, auth, (req, res) => res.json({ id: req.userId, scopes: req.apiTokenScopes }));
const get = (token) => request(app).get('/private').set('Authorization', `Bearer ${token}`);
const users = () => mongoose.connection.collection('users');
// Auth stamps lastActive asynchronously; migration assertions exclude only
// this unrelated telemetry field while comparing every credential/account field.
const withoutLastActive = ({ lastActive, ...row }) => row;
const create = (name, isBot = false) => User.create({ username: name, email: `${name}@example.test`, isBot, password: 'test-password', apiTokenScopes: ['messages:read'] });
describe('API token storage rollout', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(clearMongoDb);
  it.each([false, true])('issues digest-only, authenticates and revokes (bot=%s)', async (bot) => {
    const user = await create(`issued-${bot}`, bot);
    const token = user.generateApiToken();
    await user.save();
    const stored = await users().findOne({ _id: user._id });
    expect(stored.apiToken).toBeUndefined();
    expect(stored.apiTokenHash).toBe(hash(token));
    expect(stored.apiTokenLast4).toBe(token.slice(-4));
    const hidden = await User.findById(user._id);
    expect(hidden.apiTokenHash).toBeUndefined();
    expect(hidden.apiTokenLast4).toBeUndefined();
    expect((await get(token)).status).toBe(200);
    expect((await get(`${token}wrong`)).status).toBe(401);
    const reloaded = await User.findById(user._id);
    reloaded.revokeApiToken();
    await reloaded.save();
    expect((await get(token)).status).toBe(401);
    expect(await users().findOne({ _id: user._id })).not.toHaveProperty('apiTokenHash');
  });
  it('preserves legacy human/bot bearers and metadata across dry run and repeat apply', async () => {
    const tokens = ['cm_human-secret', 'cm_bot-secret'];
    for (let i = 0; i < tokens.length; i += 1) {
      const user = await create(`legacy-${i}`, Boolean(i));
      await users().updateOne({ _id: user._id }, { $set: { apiToken: tokens[i], apiTokenCreatedAt: new Date('2026-01-01') } });
    }
    for (const token of tokens) expect((await get(token)).status).toBe(200);
    const before = await users().find().toArray();
    expect(await backfillApiTokenStorage()).toMatchObject({ candidates: 2, migrated: 0, remaining: 2 });
    expect((await users().find().toArray()).map(withoutLastActive)).toEqual(before.map(withoutLastActive));
    expect(await backfillApiTokenStorage({ apply: true })).toMatchObject({ migrated: 2, remaining: 0 });
    for (const token of tokens) {
      const response = await get(token);
      expect(response.status).toBe(200);
      expect(response.body.scopes).toEqual(['messages:read']);
    }
    for (const row of before) {
      const after = await users().findOne({ _id: row._id });
      expect(after.apiTokenCreatedAt).toEqual(row.apiTokenCreatedAt);
      expect(after.isBot).toBe(row.isBot);
      expect(after.apiTokenHash).toBe(hash(row.apiToken));
      expect(after.apiTokenLast4).toBe(row.apiToken.slice(-4));
      expect(after.apiToken).toBeUndefined();
    }
    expect(await backfillApiTokenStorage({ apply: true })).toEqual({ candidates: 0, migrated: 0, conflicts: 0, skipped: 0, remaining: 0 });
  });
  it('counts only string bearers as left to migrate', async () => {
    const user = await create('empty-bearer');
    await users().updateOne({ _id: user._id }, { $set: { apiToken: null } });
    expect(await backfillApiTokenStorage({ apply: true })).toEqual({ candidates: 0, migrated: 0, conflicts: 0, skipped: 0, remaining: 0 });
  });
  it('compares fixed-size digests on correct and wrong tokens', async () => {
    const user = await create('constant-time');
    const token = user.generateApiToken();
    await user.save();
    const compare = jest.spyOn(crypto, 'timingSafeEqual');
    expect((await get(token)).status).toBe(200);
    expect((await get('cm_wrong')).status).toBe(401);
    expect(compare).toHaveBeenCalledTimes(2);
    for (const [a, b] of compare.mock.calls) {
      expect(a.length).toBe(64);
      expect(b.length).toBe(64);
    }
    compare.mockRestore();
  });
  it('refuses fallback and backfill when a different digest exists', async () => {
    const user = await create('conflict');
    await users().updateOne({ _id: user._id }, { $set: { apiToken: 'cm_old', apiTokenHash: hash('cm_current') } });
    expect((await get('cm_old')).status).toBe(401);
    expect((await get('cm_current')).status).toBe(200);
    const before = await users().findOne({ _id: user._id });
    expect(await backfillApiTokenStorage({ apply: true })).toMatchObject({ conflicts: 1, migrated: 0, remaining: 1 });
    expect(withoutLastActive(await users().findOne({ _id: user._id }))).toEqual(withoutLastActive(before));
  });
  it.each(['rotate', 'revoke'])('does not undo concurrent %s', async (operation) => {
    const user = await create(`race-${operation}`);
    await users().updateOne({ _id: user._id }, { $set: { apiToken: 'cm_before' } });
    const collection = users();
    const original = collection.updateOne.bind(collection);
    const spy = jest.spyOn(collection, 'updateOne').mockImplementationOnce(async (filter, update) => {
      await original({ _id: user._id }, operation === 'rotate'
        ? { $set: { apiTokenHash: hash('cm_rotated') }, $unset: { apiToken: '' } }
        : { $unset: { apiToken: '', apiTokenHash: '' } });
      return original(filter, update);
    });
    expect(await backfillApiTokenStorage({ apply: true })).toMatchObject({ migrated: 0, skipped: 1 });
    spy.mockRestore();
    expect((await get('cm_before')).status).toBe(401);
    expect((await get('cm_rotated')).status).toBe(operation === 'rotate' ? 200 : 401);
  });
  it.each([false, true])('runs the CLI with apply=%s and prints counts only', async (apply) => {
    const { spawnSync } = require('child_process');
    const path = require('path');
    const user = await create('cli');
    const token = 'cm_cli-secret-sentinel';
    await users().updateOne({ _id: user._id }, { $set: { apiToken: token } });
    const uri = `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}`;
    // NODE_NO_WARNINGS keeps Node's own deprecation notices from a dependency
    // off stderr; the script's own output is what this holds to counts only.
    const result = spawnSync(process.execPath, ['-r', require.resolve('ts-node/register'),
      path.resolve(__dirname, '../../scripts/backfill-api-token-storage.ts'), ...(apply ? ['--apply'] : []),
    ], { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, MONGO_URI: uri, NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 15000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: apply ? 'APPLY' : 'DRY-RUN', migrated: apply ? 1 : 0 });
    for (const secret of [token, hash(token), uri, String(user._id)]) expect(result.stdout).not.toContain(secret);
    const stored = await users().findOne({ _id: user._id });
    expect(stored.apiToken).toBe(apply ? undefined : token);
    expect(stored.apiTokenHash).toBe(apply ? hash(token) : undefined);
  });
  it('preserves device auth and refuses suspended accounts', async () => {
    const user = await create('device');
    user.deviceTokens = [{ tokenHash: hash('cm_device'), label: 'test', createdAt: new Date() }];
    const token = user.generateApiToken();
    await user.save();
    expect((await get('cm_device')).status).toBe(200);
    await users().updateOne({ _id: user._id }, { $set: { banned: true } });
    expect((await get(token)).status).toBe(403);
    expect((await get('cm_device')).status).toBe(403);
  });

  it('rotates a legacy credential loaded with the default hidden projection', async () => {
    const user = await create('rotation');
    await users().updateOne({ _id: user._id }, { $set: { apiToken: 'cm_old' } });
    const hidden = await User.findById(user._id);
    const token = hidden.generateApiToken();
    await hidden.save();
    expect((await users().findOne({ _id: user._id })).apiToken).toBeUndefined();
    expect((await get('cm_old')).status).toBe(401);
    expect((await get(token)).status).toBe(200);
  });

  it('keeps CLI failure output fixed even when invalid input contains a credential', () => {
    const { spawnSync } = require('child_process');
    const path = require('path');
    const sentinel = 'cm_not-for-output';
    const result = spawnSync(process.execPath, ['-r', require.resolve('ts-node/register'),
      path.resolve(__dirname, '../../scripts/backfill-api-token-storage.ts'), sentinel,
    ], { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, MONGO_URI: sentinel, NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 15000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('[api-token-storage] Failed. No values logged; rerun dry-run to inspect counts.\n');
  });

  it('reuses a digest-only credential through the real agent identity and issuance services', async () => {
    const identity = require('../../services/agentIdentityService');
    const { issueUserTokenForInstallation } = require('../../routes/registry/tokens');
    const bot = await identity.getOrCreateAgentUser('storage-probe', { instanceId: 'test' });
    const token = bot.generateApiToken();
    await bot.save();
    const result = await issueUserTokenForInstallation({ agentName: 'storage-probe', instanceId: 'test', scopes: ['agent:context:read'] });
    expect(result).toMatchObject({ existing: true, token: null, requiresRotation: true });
    const stored = await users().findOne({ _id: bot._id });
    expect(stored.apiTokenHash).toBe(hash(token));
    expect(stored.apiToken).toBeUndefined();
    expect((await get(token)).status).toBe(200);
  });

  it.each(['hashed', 'legacy', 'device'])('preserves pending-deletion refusal for %s credentials', async (kind) => {
    const user = await create(`deleting-${kind}`);
    const token = `cm_deleting-${kind}`;
    const credential = kind === 'hashed' ? { apiTokenHash: hash(token) }
      : kind === 'legacy' ? { apiToken: token }
        : { deviceTokens: [{ tokenHash: hash(token), label: 'test', createdAt: new Date() }] };
    await users().updateOne({ _id: user._id }, { $set: { ...credential, accountDeletionRequestedAt: new Date() } });
    const response = await get(token);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ACCOUNT_DELETING');
  });

});
