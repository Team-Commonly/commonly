const express = require('express');
const request = require('supertest');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const { issueSessionToken } = require('../../services/sessionTokenService');
const routes = require('../../routes/admin/users');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const makeAdmin = (name) => User.create({ username: name, email: `${name}@example.test`,
  password: 'Role-concurrency-test-123!', role: 'admin' });

describe('Administrator role concurrency', () => {
  const app = express(); app.use(express.json()); app.use('/api/admin/users', routes);
  beforeAll(async () => { process.env.JWT_SECRET = 'admin-role-service-test'; await setupMongoDb(); });
  afterEach(async () => { jest.restoreAllMocks(); await clearMongoDb(); });
  afterAll(closeMongoDb);

  it.each(['demote', 'delete'])('preserves an administrator when demotion races %s', async (operation) => {
    const [alice, bob] = await Promise.all([makeAdmin('role-alice'), makeAdmin('role-bob')]);
    const firstCount = deferred();
    const releaseFirst = deferred();
    const count = User.countDocuments.bind(User);
    let calls = 0;
    jest.spyOn(User, 'countDocuments').mockImplementation(async (...args) => {
      const value = await count(...args);
      if (++calls === 1) { firstCount.resolve(); await releaseFirst.promise; }
      return value;
    });
    const first = request(app).patch(`/api/admin/users/${bob._id}/role`)
      .set('Authorization', `Bearer ${issueSessionToken(alice)}`).send({ role: 'user' }).then((res) => res);
    await firstCount.promise;
    let second;
    try {
      const pending = operation === 'demote'
        ? request(app).patch(`/api/admin/users/${alice._id}/role`).send({ role: 'user' })
        : request(app).delete(`/api/admin/users/${alice._id}`);
      second = await pending.set('Authorization', `Bearer ${issueSessionToken(bob)}`);
    } finally { releaseFirst.resolve(); }
    const firstResult = await first;
    expect(firstResult.status).toBe(200);
    expect({ secondStatus: second.status, remainingAdmins: await count({ role: 'admin' }) })
      .toEqual({ secondStatus: 503, remainingAdmins: 1 });
  });
  it.each(['demote', 'delete', 'ban'])('never steals an abandoned lock for %s', async (operation) => {
    const [alice, bob] = await Promise.all([makeAdmin('lock-alice'), makeAdmin('lock-bob')]);
    const Lock = require('../../models/AdminUserMutationLock');
    await Lock.create({ _id: 'global-admin-user-mutations', owner: 'stopped-worker', acquiredAt: new Date('2000-01-01') });
    const pending = operation === 'demote'
      ? request(app).patch(`/api/admin/users/${bob._id}/role`).send({ role: 'user' })
      : operation === 'delete' ? request(app).delete(`/api/admin/users/${bob._id}`)
        : request(app).patch(`/api/admin/users/${bob._id}/ban`).send({ banned: true });
    const res = await pending.set('Authorization', `Bearer ${issueSessionToken(alice)}`);
    expect(res.status).toBe(503); expect(res.body.code).toBe('ADMIN_MUTATION_BUSY');
    expect((await Lock.findById('global-admin-user-mutations')).owner).toBe('stopped-worker');
    expect(await User.countDocuments({ role: 'admin' })).toBe(2);
  });

  it('rechecks actor authorization and only releases a known pre-write refusal', async () => {
    const alice = await makeAdmin('stale-alice');
    const { withAdminUserMutation } = require('../../services/adminUserMutationService');
    const Lock = require('../../models/AdminUserMutationLock');
    const operation = jest.fn();
    await User.updateOne({ _id: alice._id }, { $set: { role: 'user' } });
    await expect(withAdminUserMutation(String(alice._id), operation)).rejects.toMatchObject({ status: 403 });
    expect(operation).not.toHaveBeenCalled();
    expect(await Lock.countDocuments()).toBe(0);
    await User.updateOne({ _id: alice._id }, { $set: { role: 'admin' } });
    await expect(withAdminUserMutation(String(alice._id), async (beginWrite) => { beginWrite(); throw new Error('write failure'); }))
      .rejects.toThrow('write failure');
    expect(await Lock.countDocuments()).toBe(1);
    await expect(withAdminUserMutation(String(alice._id), async () => 'next writer'))
      .rejects.toMatchObject({ code: 'ADMIN_MUTATION_BUSY' });
  });

  it.each(['actor', 'count'])('releases the lock after a pre-write %s read fails', async (stage) => {
    const [alice, bob] = await Promise.all([makeAdmin(`read-${stage}-alice`), makeAdmin(`read-${stage}-bob`)]);
    const { withAdminUserMutation } = require('../../services/adminUserMutationService');
    const Lock = require('../../models/AdminUserMutationLock');
    if (stage === 'actor') {
      jest.spyOn(User, 'findById').mockRejectedValueOnce(new Error('actor read unavailable'));
      await expect(withAdminUserMutation(String(alice._id), jest.fn())).rejects.toThrow('actor read unavailable');
    } else {
      jest.spyOn(User, 'countDocuments').mockRejectedValueOnce(new Error('count unavailable'));
      const failed = await request(app).patch(`/api/admin/users/${bob._id}/role`)
        .set('Authorization', `Bearer ${issueSessionToken(alice)}`).send({ role: 'user' });
      expect(failed.status).toBe(500);
    }
    expect(await Lock.countDocuments()).toBe(0);
    const retry = await request(app).patch(`/api/admin/users/${bob._id}/role`)
      .set('Authorization', `Bearer ${issueSessionToken(alice)}`).send({ role: 'user' });
    expect(retry.status).toBe(200);
    expect(await User.countDocuments({ role: 'admin' })).toBe(1);
  });

  it.each(['role', 'ban', 'delete'])('retains the lock if the %s handler write rejects', async (kind) => {
    const [alice, bob] = await Promise.all([makeAdmin(`write-${kind}-alice`), makeAdmin(`write-${kind}-bob`)]);
    const Lock = require('../../models/AdminUserMutationLock');
    if (kind === 'ban') await User.updateOne({ _id: bob._id }, { $set: { role: 'user' } });
    const write = (kind === 'role' ? jest.spyOn(User, 'findOneAndUpdate')
      : kind === 'delete' ? jest.spyOn(User, 'findOneAndDelete') : jest.spyOn(User.prototype, 'save'))
      .mockRejectedValueOnce(new Error('write outcome unknown'));
    try {
      const pending = kind === 'delete' ? request(app).delete(`/api/admin/users/${bob._id}`)
        : request(app).patch(`/api/admin/users/${bob._id}/${kind}`)
          .send(kind === 'role' ? { role: 'user' } : { banned: true });
      const failed = await pending.set('Authorization', `Bearer ${issueSessionToken(alice)}`);
      expect(failed.status).toBe(500);
    } finally { write.mockRestore(); }
    expect(await Lock.countDocuments()).toBe(1);
  });

  it('does not send success before releasing the lock, and fails closed if release fails', async () => {
    const [alice, bob] = await Promise.all([makeAdmin('release-alice'), makeAdmin('release-bob')]);
    const Lock = require('../../models/AdminUserMutationLock');
    jest.spyOn(Lock, 'deleteOne').mockRejectedValueOnce(new Error('release unavailable'));
    const res = await request(app).patch(`/api/admin/users/${bob._id}/role`)
      .set('Authorization', `Bearer ${issueSessionToken(alice)}`).send({ role: 'user' });
    expect(res.status).toBe(500);
    expect(await Lock.countDocuments()).toBe(1);
    const retry = await request(app).patch(`/api/admin/users/${bob._id}/role`)
      .set('Authorization', `Bearer ${issueSessionToken(alice)}`).send({ role: 'user' });
    expect(retry.status).toBe(503);
    expect(await User.countDocuments({ role: 'admin' })).toBe(1);
  });

  it('serializes ban with a concurrent promotion', async () => {
    const alice = await makeAdmin('promotion-alice');
    const bob = await User.create({ username: 'promotion-bob', email: 'promotion-bob@example.test',
      password: 'Role-concurrency-test-123!', role: 'user' });
    const writing = deferred(); const resume = deferred();
    const update = User.findOneAndUpdate.bind(User);
    jest.spyOn(User, 'findOneAndUpdate').mockImplementation(async (...args) => {
      if (String(args[0]._id) === String(bob._id) && args[1].$set?.role === 'admin') {
        writing.resolve(); await resume.promise;
      }
      return update(...args);
    });
    const first = request(app).patch(`/api/admin/users/${bob._id}/role`)
      .set('Authorization', `Bearer ${issueSessionToken(alice)}`).send({ role: 'admin' }).then((res) => res);
    await writing.promise;
    let second;
    try {
      second = await request(app).patch(`/api/admin/users/${bob._id}/ban`)
        .set('Authorization', `Bearer ${issueSessionToken(alice)}`).send({ banned: true });
    } finally { resume.resolve(); }
    expect((await first).status).toBe(200); expect(second.status).toBe(503);
    const target = await User.findById(bob._id);
    expect(target.role).toBe('admin'); expect(target.banned).not.toBe(true);
  });

  it('retains the lock when a rejected operation can still finish its write later', async () => {
    const [alice, bob] = await Promise.all([makeAdmin('uncertain-alice'), makeAdmin('uncertain-bob')]);
    const { withAdminUserMutation } = require('../../services/adminUserMutationService');
    const resume = deferred(); let late;
    await expect(withAdminUserMutation(String(alice._id), async (beginWrite) => {
      beginWrite();
      late = resume.promise.then(() => User.updateOne({ _id: bob._id }, { $set: { role: 'user' } }));
      throw new Error('unknown write outcome');
    })).rejects.toThrow('unknown write outcome');
    let second;
    try {
      second = await request(app).patch(`/api/admin/users/${alice._id}/role`)
        .set('Authorization', `Bearer ${issueSessionToken(bob)}`).send({ role: 'user' });
    } finally { resume.resolve(); await late; }
    expect({ secondStatus: second.status, remainingAdmins: await User.countDocuments({ role: 'admin' }) })
      .toEqual({ secondStatus: 503, remainingAdmins: 1 });
  });

  it('cannot release a replacement owner’s lock', async () => {
    const alice = await makeAdmin('owner-alice');
    const Lock = require('../../models/AdminUserMutationLock');
    const { withAdminUserMutation } = require('../../services/adminUserMutationService');
    await expect(withAdminUserMutation(String(alice._id), async () => {
      await Lock.updateOne({ _id: 'global-admin-user-mutations' }, { $set: { owner: 'replacement' } });
    })).rejects.toMatchObject({ code: 'ADMIN_MUTATION_LOCK_LOST' });
    expect((await Lock.findById('global-admin-user-mutations')).owner).toBe('replacement');
  });

  it('rejects a malformed target before any database write without leaving a lock', async () => {
    const alice = await makeAdmin('invalid-target-alice');
    const Lock = require('../../models/AdminUserMutationLock');
    const res = await request(app).patch('/api/admin/users/not-an-id/role')
      .set('Authorization', `Bearer ${issueSessionToken(alice)}`).send({ role: 'user' });
    expect(res.status).toBe(400); expect(await Lock.countDocuments()).toBe(0);
  });

});
