// TASK-172 §10 step 6b: the admin pause/resume lever projects onto the rows an
// InstallableInstallation owns, and it selects them by `installationId`
// (`routes/admin/installables.ts:108` / `:145`). A hosted-MCP connection is
// minted `scope: 'user'` with NO `installationId` (`routes/hostedMcpConnect.ts`
// writes type/scope/status/createdBy/config and nothing else), so a hosted row
// is outside that projection for the same reason it is outside the pod delete
// and the reconciler: the key it would have to carry is not on it.
//
// This is a real mongod because the claim is about the SELECTOR: a mocked model
// reports the filter it was handed and cannot say which documents that filter
// reaches. The installation-bound row is the positive control — it GOES, which
// is what says the sequence ran in this request rather than being skipped or
// failing early. "The hosted row survived" is worth nothing on its own.
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

// A literal, because a `jest.mock` factory may not close over an out-of-scope
// binding: the id has to be the same string on both sides of the seam.
const ADMIN_ID = '6a8f6de2a1dccf2e02f31400';
const OWNER_ID = new mongoose.Types.ObjectId();

jest.mock('../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: '6a8f6de2a1dccf2e02f31400', role: 'admin' };
  next();
});
jest.mock('../../middleware/adminAuth', () => (_req, _res, next) => next());

jest.mock('../../models/User', () => ({ findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../services/emailService', () => ({ sendEmail: jest.fn() }));

const Integration = require('../../models/Integration');
const InstallableInstallation = require('../../models/InstallableInstallation');
const User = require('../../models/User');

const app = express();
app.use(express.json());
app.use('/admin/installables', require('../../routes/admin/installables'));
app.use('/admin/users', require('../../routes/admin/users'));

const boundRow = () => ({
  type: 'slack',
  scope: 'user',
  status: 'connected',
  createdBy: OWNER_ID,
  config: { linkedUserId: String(OWNER_ID) },
});

// The shape the connect route mints, verbatim, plus the state a connected row is
// in. Nothing here is a field the projection would need to see.
const hostedRow = (entryId) => ({
  type: 'hosted-mcp',
  scope: 'user',
  status: 'connected',
  createdBy: OWNER_ID,
  config: { entryId, intake: 'oauth', credentialRef: 'secret-access-1' },
});

const seed = async (installableId = 'slack', entryId = 'linear') => {
  const installation = await InstallableInstallation.create({
    installableId,
    installableVersion: '1.0.0',
    installSource: 'ui',
    targetType: 'user',
    targetId: OWNER_ID,
    scope: 'user',
    status: 'active',
    installedBy: ADMIN_ID,
  });
  const bound = await Integration.create({
    ...boundRow(),
    installationId: String(installation._id),
  });
  const hosted = await Integration.create(hostedRow(entryId));
  return { installation, bound, hosted };
};

const pause = (installableId, installationId) => request(app)
  .post(`/admin/installables/${installableId}/installations/${installationId}/pause`)
  .send({ reason: 'vendor incident' });
const resume = (installableId, installationId) => request(app)
  .post(`/admin/installables/${installableId}/installations/${installationId}/resume`)
  .send({ reason: 'incident over' });

const rawConfig = async (id) => (await Integration.collection.findOne({ _id: id })).config;

beforeAll(async () => {
  await setupMongoDb();
  await Integration.init();
  await InstallableInstallation.init();
});
beforeEach(async () => {
  await Integration.deleteMany({});
  await InstallableInstallation.deleteMany({});
});
afterAll(async () => {
  await clearMongoDb();
  await closeMongoDb();
});

test('pause reaches the installation-bound row and leaves the hosted row out of it', async () => {
  const { installation, bound, hosted } = await seed();

  const res = await pause('slack', String(installation._id));

  expect(res.status).toBe(200);
  expect(res.body.projected).toBe(true);
  // The control: the same call in the same request put the pause on THIS row, so
  // the projection ran and it is the selector — not a failure — that stops at
  // the hosted row.
  expect((await rawConfig(bound._id)).adminPause).toMatchObject({
    reason: 'vendor incident',
    adminId: ADMIN_ID,
  });
  const hostedConfig = await rawConfig(hosted._id);
  expect(hostedConfig.adminPause).toBeUndefined();
  // …and nothing else on the hosted row moved: a pause is not a removal, so a
  // hosted row must keep the material it would need to be removed later.
  expect(hostedConfig.credentialRef).toBe('secret-access-1');
});

test('resume unprojects the installation-bound row and leaves the hosted row alone', async () => {
  const { installation, bound, hosted } = await seed();
  await pause('slack', String(installation._id));

  const res = await resume('slack', String(installation._id));

  expect(res.status).toBe(200);
  const raw = await Integration.collection.findOne({ _id: bound._id });
  expect('adminPause' in raw.config).toBe(false);
  expect((await rawConfig(hosted._id)).adminPause).toBeUndefined();
});

test('resume lifts the pause on its own installation and not on another one', async () => {
  // Measured, not assumed: widening the RESUME selector to `{}` leaves the arms
  // above green, because `$unset` on a key a row does not carry is a no-op — so
  // the hosted row cannot witness it and the cross-tenant damage goes unseen.
  // Two paused installables and one resume is the shape that can see it. Same
  // argument on the pause side in reverse: the second row must stay untouched.
  const mine = await seed('slack');
  // A different catalogue entry: one hosted row per (person, entry) is a real
  // unique index, so a second row for the same entry is refused by name.
  const other = await seed('linear', 'notion');
  await pause('slack', String(mine.installation._id));
  await pause('linear', String(other.installation._id));

  const res = await resume('slack', String(mine.installation._id));

  expect(res.status).toBe(200);
  const raw = async (id) => (await Integration.collection.findOne({ _id: id })).config;
  expect('adminPause' in (await raw(mine.bound._id))).toBe(false);
  expect((await raw(other.bound._id)).adminPause).toMatchObject({ reason: 'vendor incident' });
  expect((await raw(mine.hosted._id)).adminPause).toBeUndefined();
  expect((await raw(other.hosted._id)).adminPause).toBeUndefined();
});

test('the projection misses the hosted row because the key is ABSENT, not empty', async () => {
  // Pinned as a QUERY, for the reason the same claim is pinned as one on the pod
  // delete: the selector is `{ installationId }`, and a row carrying
  // `installationId: null` is bracketed into that match while an absent field is
  // not. So the miss has to be the ABSENCE, and adding the key with a null value
  // would move the hosted row INTO the sweep without changing a line here.
  const { installation, bound, hosted } = await seed();

  const selected = await Integration.find({ installationId: String(installation._id) }).lean();
  // Exactly the bound row: the query reaches it (so the selector is not
  // vacuous) and does not reach the hosted row (so the exclusion is the field).
  expect(selected.map((row) => String(row._id))).toEqual([String(bound._id)]);
  expect(await Integration.countDocuments({ installationId: { $exists: false } })).toBe(1);

  const raw = await Integration.collection.findOne({ _id: hosted._id });
  expect('installationId' in raw).toBe(false);
});

describe('the admin user delete refuses while the user owns a hosted row (wren 75845)', () => {
  // `DELETE /api/admin/users/:userId` (`routes/admin/users.ts:267`) references
  // Integration nowhere but this guard. Deleting the person would strand their
  // hosted connections: the owner is the only caller the row's own routes accept
  // (PATCH refuses it by kind, `DELETE /api/integrations/:id` wants the owner or
  // an admin), so nothing could finish the removal — not even the vendor revoke
  // owed on a row only they can reach. The arm pins the REFUSAL, not the strand.
  const person = () => ({
    _id: new mongoose.Types.ObjectId(),
    isBot: false,
    role: 'user',
    deleteOne: jest.fn().mockResolvedValue({}),
  });
  const hostedFor = (userId, overrides = {}) => ({
    type: 'hosted-mcp',
    scope: 'user',
    status: 'connected',
    createdBy: userId,
    config: { entryId: 'linear', intake: 'oauth', credentialRef: 'secret-access-1' },
    ...overrides,
  });

  it('refuses with a code and the row ids, and does not delete the person', async () => {
    const target = person();
    User.findById.mockResolvedValue(target);
    const live = await Integration.create(hostedFor(target._id));
    // The case the predicate exists for (vera 75850): the provider step failed,
    // so the row sits at step 2 of the removal — `disconnected`, its material
    // not yet gone. A guard keyed on `connected` waves this one through.
    const stranded = await Integration.create(hostedFor(target._id, {
      status: 'disconnected',
      config: { entryId: 'notion', intake: 'oauth', refreshTokenRef: 'secret-refresh-2' },
    }));

    const res = await request(app).delete(`/admin/users/${target._id}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('hosted_mcp_connection_owned');
    // Both keys count as material: a row can carry a refresh token with no
    // access token written yet, and dropping either branch of the predicate
    // takes one of these ids out of the answer.
    expect([...res.body.connectionIds].sort()).toEqual(
      [String(live._id), String(stranded._id)].sort(),
    );
    // The control: the refusal is what stopped it, not a failed lookup.
    expect(target.deleteOne).not.toHaveBeenCalled();
    expect(await Integration.countDocuments({ createdBy: target._id })).toBe(2);
  });

  it('accepts the delete for a person who owns no hosted row', async () => {
    const target = person();
    User.findById.mockResolvedValue(target);

    const res = await request(app).delete(`/admin/users/${target._id}`);

    expect(res.status).toBe(200);
    expect(target.deleteOne).toHaveBeenCalledTimes(1);
  });

  it('does not refuse for an abandoned connection attempt, which holds neither material nor a grant', async () => {
    // Production mints exactly this: `hostedMcpConnect.ts:237` inserts a
    // `pending` row with `config.entryId` and nothing else, and `credentialRef`
    // is not written until the callback. `routes/grants.ts:319` refuses to mint
    // from such a row, so there is no material to revoke and no grant to end —
    // refusing the delete would protect nothing and block a legitimate cleanup.
    const target = person();
    User.findById.mockResolvedValue(target);
    await Integration.create(hostedFor(target._id, {
      status: 'pending',
      config: { entryId: 'linear', intake: 'oauth', pendingAuth: { state: 's', expiresAt: new Date() } },
    }));

    const res = await request(app).delete(`/admin/users/${target._id}`);

    expect(res.status).toBe(200);
    expect(target.deleteOne).toHaveBeenCalledTimes(1);
  });

  it('does not refuse for a row that is not a hosted one', async () => {
    // Narrowness, in the same shape as the pod-delete control: a github-app row
    // is `scope: 'user'` too, and the guard is about the hosted rows whose
    // removal only their owner can finish. Widening the filter to every
    // Integration turns this arm red, which is what keeps it honest.
    const target = person();
    User.findById.mockResolvedValue(target);
    await Integration.create({
      type: 'github-app',
      scope: 'user',
      status: 'connected',
      createdBy: target._id,
      config: { repo: 'Team-Commonly/commonly' },
    });

    const res = await request(app).delete(`/admin/users/${target._id}`);

    expect(res.status).toBe(200);
    expect(target.deleteOne).toHaveBeenCalledTimes(1);
  });
});
