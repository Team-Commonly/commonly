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
const Pod = require('../../models/Pod');
const authController = require('../../controllers/authController');
const MediaObject = require('../../models/MediaObject');
const DeviceAuthorization = require('../../models/DeviceAuthorization');
const OAuthLoginState = require('../../models/OAuthLoginState');
const AgentCredential = require('../../models/AgentCredential');
const AgentMemory = require('../../models/AgentMemory');
const { AgentInstallation } = require('../../models/AgentRegistry');
const SchedulerLease = require('../../models/SchedulerHeartbeatLease');
const { issueRuntimeTokenForAgent } = require('../../routes/registry/tokens');
const agentRuntimeAuth = require('../../middleware/agentRuntimeAuth');
const { sweepAccountDeletions } = require('../../services/accountDeletionService');
const AccountDeletion = require('../../models/AccountDeletion');
const { issueSessionToken } = require('../../services/sessionTokenService');
const { getObjectStore } = require('../../services/objectStore');
const oauthController = require('../../controllers/oauthController');
const auth = require('../../middleware/auth');
const { socketAuthMiddleware } = require('../../middleware/socketAuth');
const routes = require('../../routes/users');
const uploads = require('../../routes/uploads');
const adminRoutes = require('../../routes/admin/users');
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
    app.use('/api/admin/users', adminRoutes);
    const probeLimit = require('express-rate-limit')({ windowMs: 60000, max: 1000 });
    app.get('/session-probe', probeLimit, auth, (_req, res) => res.sendStatus(204));
    app.post('/session-probe', probeLimit, auth, (_req, res) => res.sendStatus(204));
    const recovery = express.Router();
    recovery.get('/user', probeLimit, auth, authController.getCurrentUser);
    recovery.get('/profile', probeLimit, auth, (_req, res) => res.sendStatus(204));
    app.use('/api/auth', recovery);
    app.get('/runtime-probe', probeLimit, agentRuntimeAuth, (_req, res) => res.sendStatus(204));
  });
  afterEach(async () => { await clearMongoDb(); await clearPgDb(); await mockPg.query('DELETE FROM users'); });
  afterAll(async () => { await closeMongoDb(); await closePgDb(); });

  it('deletes own bytes and legacy uploads, revokes credentials, preserves agents and other users', async () => {
    const deviceToken = 'cm_delete-device';
    const human = await makeUser({ apiToken: 'cm_delete-api', deviceTokens: [{
      tokenHash: createHash('sha256').update(deviceToken).digest('hex'), label: 'Laptop' }] });
    const other = await makeUser();
    const agent = await makeUser({ isBot: true });
    const sharedPod = await Pod.create({ name: 'Keep shared pod', createdBy: human._id,
      members: [human._id, other._id, agent._id] });
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
    await mockPg.query('INSERT INTO pod_members (pod_id,user_id) VALUES ($1,$2)',
      ['123456789012345678901234', String(human._id)]);
    const token = issueSessionToken(human);
    await deletion(app, token).expect(204);
    expect(await User.findById(human._id)).toBeNull();
    const retainedPod = await Pod.findById(sharedPod._id);
    expect(retainedPod.members.map(String).sort()).toEqual([String(other._id), String(agent._id)].sort());
    expect(String(retainedPod.createdBy)).toBe(String(human._id));
    expect((await mockPg.query('SELECT * FROM pod_members WHERE user_id = $1', [String(human._id)])).rows).toHaveLength(0);
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
    await request(app).get('/session-probe').set('Authorization', `Bearer ${issueSessionToken(user)}`).expect(204);
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

  it('does not let anonymous deletion attempts exhaust a proxy-wide bucket', async () => {
    for (let attempt = 0; attempt < 121; attempt += 1) {
      const response = await request(app).delete('/api/users/me').send({ confirmation: 'DELETE' });
      expect([401, 429]).toContain(response.status);
    }
    const user = await makeUser();
    await deletion(app, issueSessionToken(user), {}).expect(400);
  });

  it('limits deletion by account despite rotating JWTs and forwarding headers', async () => {
    const user = await makeUser();
    const tokens = [issueSessionToken(user), issueSessionToken(user, undefined, undefined, 1)];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await deletion(app, tokens[attempt % 2], {}).expect(400);
    }
    await deletion(app, tokens[0], {}).expect(429);
    expect(await User.findById(user._id)).not.toBeNull();
    expect(await AccountDeletion.countDocuments()).toBe(0);
  });

  it('recovers a stale billing preflight claim and refuses an active one', async () => {
    const user = await makeUser({ accountDeletionRequestedAt: new Date() });
    const token = issueSessionToken(user);
    await deletion(app, token).expect(409);
    await User.updateOne({ _id: user._id }, {
      $set: { accountDeletionRequestedAt: new Date(Date.now() - 301000) },
    });
    await deletion(app, token).expect(204);
  });

  it('recovers a failed receipt write without relying on a browser retry', async () => {
    const user = await makeUser({ billing: { subscriptionId: 'sub_receipt', subscriptionStatus: 'active' } });
    await addFile(user, 'stranded.png');
    jest.spyOn(AccountDeletion, 'updateOne').mockRejectedValueOnce(new Error('Receipt store unavailable'));
    await deletion(app, issueSessionToken(user)).expect(503);
    expect(await AccountDeletion.countDocuments()).toBe(0);
    expect((await User.findById(user._id)).accountDeletionRequestedAt).toBeDefined();
    await sweepAccountDeletions();
    expect(await AccountDeletion.countDocuments()).toBe(0); // Active preflight is left alone.
    await User.updateOne({ _id: user._id }, {
      $set: { accountDeletionRequestedAt: new Date(Date.now() - 301000) },
    });
    await sweepAccountDeletions();
    expect(await AccountDeletion.countDocuments()).toBe(1);
    expect(await File.countDocuments({ uploadedBy: user._id })).toBe(0);
    expect(await MediaObject.findOne({ key: 'stranded.png' })).toBeNull();
    await deletion(app, issueSessionToken(user)).expect(204);
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
    await request(app).get('/session-probe').set('Authorization', `Bearer ${issueSessionToken(user)}`).expect(204);
    expect(await MediaObject.findOne({ key: 'billing.png' })).not.toBeNull();
    expect(await File.countDocuments({ uploadedBy: user._id })).toBe(1);
  });

  it('blocks ordinary HTTP and socket access after failed cleanup but permits reauthenticated deletion retry', async () => {
    const user = await makeUser(); const token = issueSessionToken(user);
    await request(app).get('/session-probe').set('Authorization', `Bearer ${token}`).expect(204);
    jest.spyOn(mockPg, 'query').mockRejectedValueOnce(new Error('PG unavailable'));
    await deletion(app, token).expect(503);
    await request(app).get('/session-probe').set('Authorization', `Bearer ${token}`).expect(403);
    await request(app).post('/session-probe').set('Authorization', `Bearer ${token}`).expect(403);
    await request(app).get('/api/auth/profile').set('Authorization', `Bearer ${token}`).expect(403);
    const bootstrap = await request(app).get('/api/auth/user').set('Authorization', `Bearer ${token}`).expect(200);
    expect(Object.keys(bootstrap.body).sort()).toEqual(['_id', 'username', 'email', 'role', 'accountDeletionPending'].sort());
    expect(bootstrap.body.accountDeletionPending).toBe(true);
    const next = jest.fn();
    await socketAuthMiddleware({ handshake: { auth: { token } } }, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    await deletion(app, token, { confirmation: 'DELETE', password: 'wrong' }).expect(401);
    await deletion(app, token).expect(204);
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

  it('refuses both concurrent admin deletions without changing accounts or creating cleanup intents', async () => {
    const a = await makeUser({ role: 'admin' }); const b = await makeUser({ role: 'admin' });
    const results = await Promise.all([deletion(app, issueSessionToken(a)), deletion(app, issueSessionToken(b))]);
    expect(results.map((result) => result.status)).toEqual([409, 409]);
    expect(results.map((result) => result.body.code)).toEqual(['ADMIN_HANDOFF_REQUIRED', 'ADMIN_HANDOFF_REQUIRED']);
    expect(await User.countDocuments({ role: 'admin' })).toBe(2);
    expect(await AccountDeletion.countDocuments()).toBe(0);
    expect((await User.findById(a._id)).accountDeletionRequestedAt).toBeUndefined();
    expect((await User.findById(b._id)).accountDeletionRequestedAt).toBeUndefined();
  });

  it('allows deletion after another administrator hands off the role', async () => {
    const user = await makeUser({ role: 'admin' }); const keeper = await makeUser({ role: 'admin' });
    await request(app).patch(`/api/admin/users/${user.id}/role`)
      .set('Authorization', `Bearer ${issueSessionToken(keeper)}`).send({ role: 'user' }).expect(200);
    expect((await User.findById(user._id)).role).toBe('user');
    await deletion(app, issueSessionToken(user)).expect(204);
    expect(await User.findById(user._id)).toBeNull();
    expect((await User.findById(keeper._id)).role).toBe('admin');
  });

  it('refuses deletion if a promotion wins before the conditional deletion marker', async () => {
    const user = await makeUser({ billing: { subscriptionId: 'sub_promoted', subscriptionStatus: 'active' } });
    await addFile(user, 'promotion.png');
    mockStripe.subscriptions.cancel.mockClear();
    const updateOne = User.updateOne.bind(User);
    jest.spyOn(User, 'updateOne').mockImplementation((filter, update, ...rest) => {
      if (update.$set?.accountDeletionRequestedAt) return (async () => {
        await updateOne({ _id: user._id }, { $set: { role: 'admin' } });
        return updateOne(filter, update, ...rest);
      })();
      return updateOne(filter, update, ...rest);
    });
    await deletion(app, issueSessionToken(user)).expect(409);
    expect((await User.findById(user._id)).role).toBe('admin');
    expect(mockStripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(await File.countDocuments({ uploadedBy: user._id })).toBe(1);
    expect(await AccountDeletion.countDocuments()).toBe(0);
  });

  it('refuses an admin role change after deletion has marked the account', async () => {
    const admin = await makeUser({ role: 'admin' });
    const user = await makeUser({ accountDeletionRequestedAt: new Date() });
    await request(app).patch(`/api/admin/users/${user.id}/role`)
      .set('Authorization', `Bearer ${issueSessionToken(admin)}`).send({ role: 'admin' }).expect(409);
    expect((await User.findById(user._id)).role).toBe('user');
  });

  it('discards an in-flight upload when PG failure leaves the human marked for deletion', async () => {
    const user = await makeUser(); const token = issueSessionToken(user);
    const store = getObjectStore(); const put = store.put.bind(store);
    jest.spyOn(store, 'put').mockImplementationOnce(async (...args) => {
      jest.spyOn(mockPg, 'query').mockRejectedValueOnce(new Error('PG unavailable'));
      await deletion(app, token).expect(503);
      return put(...args);
    });
    await request(app).post('/api/uploads').set('Authorization', `Bearer ${token}`)
      .attach('image', Buffer.from('late'), 'late.png').expect(403);
    expect((await User.findById(user._id)).accountDeletionRequestedAt).toBeTruthy();
    expect(await MediaObject.countDocuments()).toBe(0);
    expect(await File.countDocuments({ uploadedBy: user._id })).toBe(0);
  });

  it('continues past one failed receipt and reports aggregate failure after cleaning the next', async () => {
    const a = await makeUser(); const b = await makeUser();
    await AccountDeletion.create([{ _id: a._id }, { _id: b._id }]);
    await addFile(a, 'fail.png'); await addFile(b, 'clean.png');
    const remove = getObjectStore().delete.bind(getObjectStore());
    jest.spyOn(getObjectStore(), 'delete').mockImplementation(async (key) => {
      if (key === 'fail.png') throw new Error('One object unavailable');
      return remove(key);
    });
    await expect(sweepAccountDeletions()).rejects.toThrow('Account deletion cleanup failed');
    expect(await File.findOne({ fileName: 'fail.png' })).not.toBeNull();
    expect(await File.findOne({ fileName: 'clean.png' })).toBeNull();
    expect(await MediaObject.findOne({ key: 'clean.png' })).toBeNull();
    expect((await AccountDeletion.findById(b._id)).lastSweptAt).toBeTruthy();
    expect(await SchedulerLease.findById('account-deletion-sweep')).toBeNull();
  });

  it('skips a sweep held by another worker and recovers an expired lease', async () => {
    const user = await makeUser(); await AccountDeletion.create({ _id: user._id });
    await addFile(user, 'lease.png');
    await SchedulerLease.create({ _id: 'account-deletion-sweep', ownerId: 'another-worker',
      expiresAt: new Date(Date.now() + 120000) });
    await sweepAccountDeletions();
    expect(await MediaObject.findOne({ key: 'lease.png' })).not.toBeNull();
    await SchedulerLease.updateOne({ _id: 'account-deletion-sweep' }, { $set: { expiresAt: new Date(0) } });
    await sweepAccountDeletions();
    expect(await MediaObject.findOne({ key: 'lease.png' })).toBeNull();
  });

  it('bounds each sweep and fairly rotates receipts without expiring late-write intent', async () => {
    const ids = Array.from({ length: 101 }, () => new User()._id);
    await AccountDeletion.insertMany(ids.map((_id) => ({ _id })));
    await sweepAccountDeletions();
    expect(await AccountDeletion.countDocuments({ lastSweptAt: { $exists: true } })).toBe(100);
    expect(await AccountDeletion.countDocuments()).toBe(101);
    await sweepAccountDeletions();
    expect(await AccountDeletion.countDocuments({ lastSweptAt: { $exists: true } })).toBe(101);
  });

  it.each([false, true])('refuses issuance and backfill for a marked owner (%s)', async (existing) => {
    const owner = await makeUser({ accountDeletionRequestedAt: new Date() });
    const agent = await makeUser({ isBot: true, agentRuntimeTokens: existing ? [{ tokenHash: 'old-hash', label: 'old' }] : [] });
    await expect(issueRuntimeTokenForAgent(agent, 'key', null, { ownerUserId: owner._id }))
      .rejects.toMatchObject({ code: 'account_deleting' });
    expect(await AgentCredential.countDocuments()).toBe(0);
  });

  it.each([false, true])('revokes a token minted or backfilled after deletion completed (%s)', async (existing) => {
    const owner = await makeUser();
    const agent = await makeUser({ isBot: true, agentRuntimeTokens: existing ? [{ tokenHash: 'late-old-hash', label: 'old' }] : [] });
    const method = existing ? 'updateOne' : 'create';
    const write = AgentCredential[method].bind(AgentCredential);
    jest.spyOn(AgentCredential, method).mockImplementationOnce(async (...args) => {
      await deletion(app, issueSessionToken(owner)).expect(204);
      return write(...args);
    });
    await expect(issueRuntimeTokenForAgent(agent, 'key', null, { ownerUserId: owner._id }))
      .rejects.toMatchObject({ code: 'account_deleting' });
    expect(await AgentCredential.countDocuments({ ownerUserId: owner._id, status: 'active' })).toBe(0);
    expect((await User.findById(agent._id)).agentRuntimeTokens).toHaveLength(0);
  });

  it('cleans a late legacy reprovision mint even when no issuer ledger was written', async () => {
    const owner = await makeUser(); const agent = await makeUser({ isBot: true });
    const installation = await AgentInstallation.create({ agentName: agent.username, podId: owner._id,
      version: '1.0.0', installedBy: owner._id });
    const save = agent.save.bind(agent);
    jest.spyOn(agent, 'save').mockImplementationOnce(async () => {
      await deletion(app, issueSessionToken(owner)).expect(204);
      return save();
    });
    await expect(issueRuntimeTokenForAgent(agent, 'key', installation))
      .rejects.toMatchObject({ code: 'account_deleting' });
    expect(await AgentCredential.countDocuments()).toBe(0);
    expect((await User.findById(agent._id)).agentRuntimeTokens).toHaveLength(0);
    expect((await AgentInstallation.findById(installation._id)).runtimeTokens).toHaveLength(0);
    expect((await AgentInstallation.findById(installation._id)).status).toBe('paused');
  });

  it('a late backfill refusal preserves an existing token owned by someone else', async () => {
    const owner = await makeUser(); const other = await makeUser();
    const agent = await makeUser({ isBot: true, agentRuntimeTokens: [{ tokenHash: 'shared-old-hash', label: 'other key' }] });
    const credential = await AgentCredential.create({ tokenHash: 'shared-old-hash', kind: 'runtime',
      ownerUserId: other._id, agentUserId: agent._id });
    const write = AgentCredential.updateOne.bind(AgentCredential);
    jest.spyOn(AgentCredential, 'updateOne').mockImplementationOnce(async (...args) => {
      await deletion(app, issueSessionToken(owner)).expect(204);
      return write(...args);
    });
    await expect(issueRuntimeTokenForAgent(agent, 'key', null, { ownerUserId: owner._id }))
      .rejects.toMatchObject({ code: 'account_deleting' });
    expect((await AgentCredential.findById(credential._id)).status).toBe('active');
    expect((await User.findById(agent._id)).agentRuntimeTokens).toHaveLength(1);
  });

  it('rejects an active credential while its owner is being deleted, before any later sweep', async () => {
    const owner = await makeUser();
    const raw = 'cm_agent_deletion-fence-test';
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const agent = await makeUser({ isBot: true, botMetadata: { agentName: 'deletion-runtime-probe', instanceId: 'default' },
      agentRuntimeTokens: [{ tokenHash, label: 'probe', lastUsedAt: new Date() }] });
    await AgentInstallation.create({ agentName: 'deletion-runtime-probe', instanceId: 'default', podId: owner._id,
      version: '1.0.0', installedBy: owner._id });
    await AgentCredential.create({ tokenHash, kind: 'runtime', ownerUserId: owner._id, agentUserId: agent._id });
    // A viable credential is essential: an incomplete identity would return
    // 401 even with the deletion fence removed and could not pin this guard.
    await request(app).get('/runtime-probe').set('Authorization', `Bearer ${raw}`).expect(204);
    await AccountDeletion.create({ _id: owner._id });
    await request(app).get('/runtime-probe').set('Authorization', `Bearer ${raw}`).expect(401);
    expect(await AgentCredential.countDocuments({ status: 'active' })).toBe(1);
  });

  it('protects the last administrator', async () => {
    const user = await makeUser({ role: 'admin' });
    await deletion(app, issueSessionToken(user)).expect(409);
    expect(await User.findById(user._id)).not.toBeNull();
  });

  it('cancels a subscription before deleting its billing linkage', async () => {
    const user = await makeUser({ billing: { subscriptionId: 'sub_delete', subscriptionStatus: 'active' } });
    await deletion(app, issueSessionToken(user)).expect(204);
    expect(mockStripe.subscriptions.cancel).toHaveBeenCalledWith('sub_delete', {}, { idempotencyKey: `account-deletion-${user.id}-sub_delete`, timeout: 30000, maxNetworkRetries: 0 });
  });
});
