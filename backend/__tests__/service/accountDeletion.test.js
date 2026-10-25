const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createHash } = require('crypto');
const { setupMongoDb, closeMongoDb, clearMongoDb, setupPgDb, closePgDb, clearPgDb } = require('../utils/testUtils');
let mockPg;
jest.mock('../../config/db-pg', () => ({ pool: { query: (...args) => mockPg.query(...args) } }));
const mockStripe = { subscriptions: { cancel: jest.fn().mockResolvedValue({ status: 'canceled' }) } };
jest.mock('../../services/billingService', () => ({ stripe: () => mockStripe }));
const User = require('../../models/User');
const File = require('../../models/File');
const MediaObject = require('../../models/MediaObject');
const DeviceAuthorization = require('../../models/DeviceAuthorization');
const OAuthLoginState = require('../../models/OAuthLoginState');
const AgentCredential = require('../../models/AgentCredential');
const AgentMemory = require('../../models/AgentMemory');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { sweepAccountDeletions } = require('../../services/accountDeletionService');
const AccountDeletion = require('../../models/AccountDeletion');
const { issueSessionToken } = require('../../services/sessionTokenService');
const { getObjectStore } = require('../../services/objectStore');
const oauthController = require('../../controllers/oauthController');
const routes = require('../../routes/users');
const uploads = require('../../routes/uploads');
const password = 'Delete-this-account-123!';
const makeUser = (fields = {}) => User.create({ username: `person-${Math.random().toString(16).slice(2)}`,
  email: `${Math.random()}@example.test`, password, ...fields });
let ip = 0;
const deletion = (app, token, body = { confirmation: 'DELETE', password }) => request(app)
  .delete('/api/users/me').set('cf-connecting-ip', `192.0.2.${++ip}`)
  .set('Authorization', `Bearer ${token}`).send(body);
const addFile = async (owner, name, legacy = false) => {
  if (!legacy) await getObjectStore().put(name, Buffer.from('private'), 'image/png');
  return File.create({ fileName: name, originalName: name, contentType: 'image/png', size: 7,
    uploadedBy: owner._id, ...(legacy ? { data: Buffer.from('legacy') } : {}) });
};

describe('Self-serve account deletion', () => {
  let app;
  beforeAll(async () => {
    process.env.JWT_SECRET = 'account-deletion-service-test';
    await setupMongoDb();
    mockPg = await setupPgDb();
    await mockPg.query(`CREATE TABLE IF NOT EXISTS users (_id VARCHAR(24) PRIMARY KEY,
      username VARCHAR(100), profile_picture TEXT, is_bot BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
    app = express(); app.use(express.json());
    app.use('/api/users', routes); app.use('/api/uploads', uploads);
  });
  afterEach(async () => { await clearMongoDb(); await clearPgDb(); await mockPg.query('DELETE FROM users'); });
  afterAll(async () => { await closeMongoDb(); await closePgDb(); });

  it('deletes own bytes and legacy uploads, revokes credentials, preserves agents and other users', async () => {
    const deviceToken = 'cm_delete-device';
    const human = await makeUser({ apiToken: 'cm_delete-api', deviceTokens: [{
      tokenHash: createHash('sha256').update(deviceToken).digest('hex'), label: 'Laptop' }] });
    const other = await makeUser();
    const agent = await makeUser({ isBot: true });
    const memory = await AgentMemory.create({ agentName: 'surviving-agent', instanceId: 'default',
      sections: { long_term: { content: 'Remember this', visibility: 'private', byteSize: 13 } } });
    const ownInstallation = await AgentInstallation.create({ agentName: 'surviving-agent',
      podId: other._id, version: '1.0.0', installedBy: human._id });
    const otherInstallation = await AgentInstallation.create({ agentName: 'surviving-agent',
      podId: agent._id, version: '1.0.0', installedBy: other._id });
    const credential = await AgentCredential.create({ tokenHash: 'delete-runtime-hash', kind: 'runtime',
      ownerUserId: human._id, agentUserId: agent._id, scopes: ['messages:write'] });
    const otherCredential = await AgentCredential.create({ tokenHash: 'keep-runtime-hash', kind: 'runtime',
      ownerUserId: other._id, agentUserId: agent._id, scopes: ['messages:write'] });
    await DeviceAuthorization.create({ deviceCodeHash: 'delete-device', userCodeHash: 'delete-code',
      hostname: 'laptop', clientName: 'cli', status: 'authorized', userId: human._id,
      expiresAt: new Date(Date.now() + 60000) });
    await addFile(human, 'own.png'); await addFile(human, 'legacy.png', true);
    await addFile(other, 'other.png'); await addFile(agent, 'agent.png');
    await mockPg.query('INSERT INTO users (_id, username, profile_picture) VALUES ($1,$2,$3)',
      [String(human._id), 'Private display name', '/api/uploads/own.png']);
    await mockPg.query('INSERT INTO pods (id,name,type,created_by) VALUES ($1,$2,$3,$4)',
      ['123456789012345678901234', 'Shared', 'chat', String(other._id)]);
    await mockPg.query('INSERT INTO messages (id,pod_id,user_id,content) VALUES ($1,$2,$3,$4)',
      ['1', '123456789012345678901234', String(human._id), 'Shared history']);
    const token = issueSessionToken(human);
    await deletion(app, token).expect(204);
    expect(await User.findById(human._id)).toBeNull();
    expect(await File.countDocuments({ uploadedBy: human._id })).toBe(0);
    expect(await MediaObject.findOne({ key: 'own.png' })).toBeNull();
    expect(await MediaObject.countDocuments()).toBe(2);
    expect(await User.findById(agent._id)).not.toBeNull();
    expect((await AgentMemory.findById(memory._id)).sections.long_term.content).toBe('Remember this');
    expect((await AgentInstallation.findById(ownInstallation._id)).status).toBe('paused');
    expect((await AgentInstallation.findById(otherInstallation._id)).status).toBe('active');
    expect(await User.findById(other._id)).not.toBeNull();
    expect((await AgentCredential.findById(credential._id)).status).toBe('revoked');
    expect((await AgentCredential.findById(otherCredential._id)).status).toBe('active');
    expect(await DeviceAuthorization.countDocuments({ userId: human._id })).toBe(0);
    const author = (await mockPg.query('SELECT * FROM users WHERE _id = $1', [String(human._id)])).rows[0];
    expect(author.username).toBe('Deleted user'); expect(author.profile_picture).toBeNull();
    expect((await mockPg.query('SELECT content FROM messages')).rows[0].content).toBe('Shared history');
    // A profile mirror or credential mint that was authenticated before delete
    // may finish late. The durable receipt reapplies redaction and revocation.
    await mockPg.query('UPDATE users SET username = $2 WHERE _id = $1', [String(human._id), 'Late private name']);
    await AgentCredential.updateOne({ _id: credential._id }, { $set: { status: 'active' } });
    await sweepAccountDeletions();
    expect((await mockPg.query('SELECT username FROM users WHERE _id = $1', [String(human._id)])).rows[0].username).toBe('Deleted user');
    expect((await AgentCredential.findById(credential._id)).status).toBe('revoked');
    for (const bearer of [token, 'cm_delete-api', deviceToken]) {
      await request(app).get('/api/users/profile').set('Authorization', `Bearer ${bearer}`).expect(401);
    }
    await request(app).get('/api/uploads/own.png').expect(404);
    await request(app).get('/api/uploads/legacy.png').expect(404);
    await request(app).get('/api/uploads/other.png').expect(200);
  });

  it('requires explicit confirmation, the right password and a browser session', async () => {
    const user = await makeUser({ apiToken: 'cm_no-deletion' }); const token = issueSessionToken(user);
    await deletion(app, token, { password }).expect(400);
    await deletion(app, token, { confirmation: 'DELETE' }).expect(401);
    await deletion(app, token, { confirmation: 'DELETE', password: 'wrong' }).expect(401);
    await deletion(app, 'cm_no-deletion').expect(403);
    const after = await User.findById(user._id).select('+apiToken');
    expect(after).not.toBeNull();
    expect(after.apiToken).toBe('cm_no-deletion');
    expect(after.accountDeletionRequestedAt).toBeUndefined();
  });

  it('requires fresh OAuth sign-in, not JWT issue time or refresh', async () => {
    const user = await makeUser({ password: undefined,
      authProviders: [{ provider: 'github', providerId: 'oauth-delete', linkedAt: new Date() }] });
    const now = Math.floor(Date.now() / 1000);
    for (const marker of [undefined, now - 301, now + 5, 'now']) {
      const token = jwt.sign({ id: user.id, ...(marker === undefined ? {} : { oauthAuthenticatedAt: marker }) },
        process.env.JWT_SECRET, { expiresIn: 1000 });
      await deletion(app, token, { confirmation: 'DELETE' }).expect(401);
    }
    await deletion(app, issueSessionToken(user, now - 1, 0), { confirmation: 'DELETE' }).expect(401);
    // Real one-time OAuth exchange is the positive witness, not a fabricated claim.
    await OAuthLoginState.create({ provider: 'github', state: 'deletion-state', userId: user._id,
      exchangeCode: 'deletion-exchange', exchangeExpiresAt: new Date(Date.now() + 60000),
      expiresAt: new Date(Date.now() + 60000) });
    let session;
    await oauthController.exchangeOAuthCode({ body: { code: 'deletion-exchange' } }, {
      json: (body) => { session = body; }, status: () => { throw new Error('Exchange failed'); } });
    expect(jwt.verify(session.token, process.env.JWT_SECRET).oauthAuthenticatedAt).toBeGreaterThanOrEqual(now);
    await deletion(app, session.token, { confirmation: 'DELETE' }).expect(204);
  });

  it('keeps failed cleanup retryable and blocks new uploads', async () => {
    const user = await makeUser(); const token = issueSessionToken(user);
    await addFile(user, 'retry.png');
    jest.spyOn(getObjectStore(), 'delete').mockRejectedValueOnce(new Error('Storage unavailable'));
    await deletion(app, token).expect(503);
    expect(await File.countDocuments({ uploadedBy: user._id })).toBe(1);
    expect((await User.findById(user._id)).accountDeletionRequestedAt).toBeTruthy();
    await request(app).post('/api/uploads').set('Authorization', `Bearer ${token}`)
      .attach('image', Buffer.from('late'), 'late.png').expect(403);
    await deletion(app, token).expect(204);
    expect(await MediaObject.findOne({ key: 'retry.png' })).toBeNull();
  });

  it('discards an upload that was already in flight', async () => {
    const user = await makeUser(); const token = issueSessionToken(user);
    const store = getObjectStore(); const originalPut = store.put.bind(store);
    jest.spyOn(store, 'put').mockImplementationOnce(async (...args) => {
      await deletion(app, token).expect(204); return originalPut(...args);
    });
    await request(app).post('/api/uploads').set('Authorization', `Bearer ${token}`)
      .attach('image', Buffer.from('late bytes'), 'late.png').expect(403);
    expect(await MediaObject.countDocuments()).toBe(0);
    expect(await File.countDocuments()).toBe(0);
  });

  it('leaves the account and uploads intact if subscription cancellation fails', async () => {
    const user = await makeUser({ apiToken: 'cm_keep-on-billing-failure',
      billing: { subscriptionId: 'sub_fail', subscriptionStatus: 'active' } });
    await addFile(user, 'billing.png');
    mockStripe.subscriptions.cancel.mockRejectedValueOnce(new Error('Provider unavailable'));
    await deletion(app, issueSessionToken(user)).expect(503);
    const after = await User.findById(user._id).select('+apiToken');
    expect(after.apiToken).toBe('cm_keep-on-billing-failure');
    expect(after.accountDeletionRequestedAt).toBeUndefined();
    expect(await MediaObject.findOne({ key: 'billing.png' })).not.toBeNull();
    expect(await File.countDocuments({ uploadedBy: user._id })).toBe(1);
  });

  it('keeps a PG failure retryable and only removes the human after anonymization succeeds', async () => {
    const user = await makeUser(); const token = issueSessionToken(user);
    jest.spyOn(mockPg, 'query').mockRejectedValueOnce(new Error('PG unavailable'));
    await deletion(app, token).expect(503);
    expect(await User.findById(user._id)).not.toBeNull();
    await deletion(app, token).expect(204);
    expect(await User.findById(user._id)).toBeNull();
  });

  it.each([false, true])('retries late-upload cleanup after User deletion even if File save fails (%s)', async (metadataFails) => {
    const user = await makeUser(); const token = issueSessionToken(user);
    const other = await makeUser(); await addFile(other, 'keep.png');
    const store = getObjectStore(); const originalPut = store.put.bind(store);
    jest.spyOn(store, 'put').mockImplementationOnce(async (...args) => {
      await deletion(app, token).expect(204);
      await originalPut(...args);
      if (metadataFails) jest.spyOn(File.prototype, 'save').mockRejectedValueOnce(new Error('Metadata unavailable'));
      else jest.spyOn(store, 'delete').mockRejectedValueOnce(new Error('Late storage delete unavailable'));
    });
    await request(app).post('/api/uploads').set('Authorization', `Bearer ${token}`)
      .attach('image', Buffer.from('late bytes'), 'late.png').expect(500);
    expect(await User.findById(user._id)).toBeNull();
    expect(await AccountDeletion.findById(user._id)).not.toBeNull();
    expect(await MediaObject.countDocuments()).toBe(2);
    if (metadataFails) expect(await File.countDocuments({ uploadedBy: user._id })).toBe(0);
    await sweepAccountDeletions();
    expect(await MediaObject.countDocuments()).toBe(1);
    expect(await MediaObject.findOne({ key: 'keep.png' })).not.toBeNull();
    expect(await File.countDocuments({ uploadedBy: user._id })).toBe(0);
    // Repeated and overlapping sweeps are safe after their data is gone.
    await Promise.all([sweepAccountDeletions(), sweepAccountDeletions()]);
    expect(await MediaObject.countDocuments()).toBe(1);
  });

  it('protects the last administrator', async () => {
    const user = await makeUser({ role: 'admin' });
    await deletion(app, issueSessionToken(user)).expect(409);
    expect(await User.findById(user._id)).not.toBeNull();
  });

  it('cancels a subscription before deleting its billing linkage', async () => {
    const user = await makeUser({ billing: { subscriptionId: 'sub_delete', subscriptionStatus: 'active' } });
    await deletion(app, issueSessionToken(user)).expect(204);
    expect(mockStripe.subscriptions.cancel).toHaveBeenCalledWith('sub_delete', {}, { idempotencyKey: `account-deletion-${user.id}` });
  });
});
