/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * F265: deleting an account takes the person's ids off record lines, and every
 * chain they were on still verifies. Real MongoDB, real PostgreSQL with the real
 * migrations, the real route and the real delete path.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'record-deletion-test-secret';

const express = require('express');
const request = require('supertest');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const { pool } = require('../../config/db-pg');
const { appendRecord, flushRecordWrites, toOtlp } = require('../../services/recordService');
const { sweepAccountDeletions } = require('../../services/accountDeletionService');
const lines = require('../../services/brokerRecordLines');
const { verifyRecord, readRecord } = require('../../vendor/seats/src/record/format');
const { setupMongoDb, closeMongoDb, clearMongoDb, setupPgDb, closePgDb, generateTestToken } = require('../utils/testUtils');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const password = 'Delete-this-account-123!';

real('deleting an account from a real record', () => {
  let app;
  let n = 0;
  const person = (name) => { n += 1; return User.create({ username: `${name}-${n}-${Date.now()}`, email: `${name}-${n}-${Date.now()}@test.com`, password, verified: true }); };
  const as = (user) => ({ Authorization: `Bearer ${generateTestToken(user._id)}` });
  const read = (pod, user, query = '') => request(app).get(`/api/pods/${pod._id}/record${query}`).set(as(user));
  const seed = async (openPod = true) => {
    const creator = await person('creator');
    const ben = await person('ben');
    const ana = await person('ana');
    const joiner = await person('joiner');
    const agentId = String(new User()._id);
    const pod = await Pod.create({
      name: `record ${n}`, type: 'team', createdBy: creator._id, members: [creator._id, ben._id, ana._id, joiner._id],
      ...(openPod ? { publicRead: true, communityListed: true, joinPolicy: 'open' } : {}),
    });
    const ref = { podId: String(pod._id) };
    const agent = { type: 'agent', id: agentId, owner: String(ana._id) };
    const call = { toolCallId: 'tc-1', tool: 'sentry.write', grantId: 'g-1', agent };
    await appendRecord(ref, 'e1', [lines.grantIssuedLine({
      grantId: 'g-1', connectionId: 'conn-ben', tools: ['sentry.write'], writeMode: 'write', audience: [agentId], target: { kind: 'pod', id: ref.podId },
    }, { type: 'human', id: String(ben._id) })]);
    await appendRecord(ref, 'e2', lines.resolvedCallLines(call, true, String(ben._id), 'card-1'));
    await appendRecord(ref, 'e3', lines.executedCallLines(call, true));
    await flushRecordWrites();
    return { creator, ben, ana, joiner, pod };
  };
  const deleteBen = (ben) => request(app).delete('/api/users/me').set('cf-connecting-ip', '192.0.2.9').set(as(ben))
    .send({ confirmation: 'DELETE', password });

  beforeAll(async () => {
    process.env.RECORD_V1_PODS = '*';
    await setupMongoDb();
    await setupPgDb();
    app = express();
    app.use(express.json());
    app.use('/api/pods', require('../../routes/podRecords'));
    app.use('/api/users', require('../../routes/users'));
    app.use('/api/admin/users', require('../../routes/admin/users'));
  });
  afterEach(async () => {
    await clearMongoDb();
    await pool.query('TRUNCATE record_openings, record_lines, record_chains CASCADE');
  });
  afterAll(async () => {
    delete process.env.RECORD_V1_PODS;
    await closeMongoDb();
    await closePgDb();
  });

  it('the route deletes the id, the stored bytes do not change, and the chain still verifies', async () => {
    const { creator, ben, ana, pod } = await seed();
    const before = await read(pod, creator);
    expect(before.text).toContain(String(ben._id));
    const stored = await pool.query('SELECT line FROM record_lines ORDER BY seq');

    expect((await deleteBen(ben)).status).toBe(204);

    expect((await pool.query('SELECT 1 FROM record_openings WHERE subject = $1', [String(ben._id)])).rowCount).toBe(0);
    expect((await pool.query('SELECT line FROM record_lines ORDER BY seq')).rows).toEqual(stored.rows);
    const after = await read(pod, creator);
    expect(after.status).toBe(200);
    expect(after.text).not.toContain(String(ben._id));
    expect(after.text).not.toContain('conn-ben');
    expect(JSON.stringify(toOtlp(after.text))).not.toContain(String(ben._id));
    const result = verifyRecord(after.text);
    expect(result).toMatchObject({ ok: true, errors: [] });
    expect(result.partial).toBeUndefined();
    expect(after.headers['x-record-head']).toBe(before.headers['x-record-head']);
    expect(after.text).toContain(String(ana._id));
    expect((await pool.query('SELECT 1 FROM record_openings WHERE subject = $1', [String(ana._id)])).rowCount).toBeGreaterThan(0);
  });

  it('a joiner\'s view is no weaker after, and no held salt reaches them', async () => {
    const { ben, joiner, pod } = await seed();
    const before = await read(pod, joiner);
    const salts = (await pool.query('SELECT salt FROM record_openings WHERE subject = $1', [String(ben._id)])).rows.map((row) => row.salt);
    expect(salts.length).toBeGreaterThan(0);
    expect((await deleteBen(ben)).status).toBe(204);
    const after = await read(pod, joiner);
    salts.forEach((salt) => { expect(before.text).not.toContain(salt); expect(after.text).not.toContain(salt); });
    expect(verifyRecord(after.text)).toMatchObject({ ok: true, errors: [] });
    expect(after.headers['x-record-head']).toBe(before.headers['x-record-head']);
  });

  it('on a private pod too, and the deleted person can no longer be read on any line', async () => {
    const { ben, ana, pod } = await seed(false);
    expect((await deleteBen(ben)).status).toBe(204);
    const after = await read(pod, ana);
    expect(after.text).not.toContain(String(ben._id));
    expect(verifyRecord(after.text)).toMatchObject({ ok: true, errors: [] });
    const decided = readRecord(after.text).find((entry) => entry.kind === 'permission.decided');
    expect(decided.data.decidedBy).toMatch(/^c1:/);
  });

  it.each(['self-serve', 'admin'])('a surviving agent\'s late line after a %s delete loses its opening on the next sweep', async (path) => {
    const { agentActor } = require('../../services/recordService');
    const { creator, ben, pod } = await seed();
    const bot = await User.create({
      username: `kept-${n}-${Date.now()}`, email: `kept-${n}-${Date.now()}@test.com`, password, isBot: true,
      botMetadata: { agentName: 'kept', ownerUserId: String(ben._id) },
    });
    if (path === 'admin') {
      const admin = await person('admin');
      await User.updateOne({ _id: admin._id }, { role: 'admin' });
      await request(app).delete(`/api/admin/users/${ben._id}`).set(as(admin)).expect(200);
    } else {
      await deleteBen(ben).expect(204);
    }
    const actor = agentActor(await User.findById(bot._id).lean());
    expect(actor.owner).toBe(String(ben._id));
    await appendRecord({ podId: String(pod._id) }, `late/${path}`, [{ kind: 'tool.call', actor, data: { toolCallId: 'tc-9', title: 'x', name: 'x', surface: 'connector' } }]);
    await flushRecordWrites();
    expect((await pool.query('SELECT 1 FROM record_openings WHERE subject = $1', [String(ben._id)])).rowCount).toBe(1);
    await sweepAccountDeletions();
    expect((await pool.query('SELECT 1 FROM record_openings WHERE subject = $1', [String(ben._id)])).rowCount).toBe(0);
    const after = await read(pod, creator);
    expect(after.text).not.toContain(String(ben._id));
    expect(verifyRecord(after.text)).toMatchObject({ ok: true, errors: [] });
  });

  it('a connection id past 255 characters goes on the record, reads back, and goes with its owner', async () => {
    const { creator, ben, pod } = await seed();
    const connectionId = `conn-${'x'.repeat(300)}`;
    const { appended } = await appendRecord({ podId: String(pod._id) }, 'long', [lines.grantIssuedLine({
      grantId: 'g-long', connectionId, tools: ['sentry.write'], writeMode: 'write', audience: [], target: { kind: 'pod', id: String(pod._id) }, ownerId: String(ben._id),
    }, { type: 'human', id: String(ben._id) })]);
    expect(appended).toBe(1);
    expect((await read(pod, creator)).text).toContain(connectionId);
    expect((await pool.query('SELECT 1 FROM record_openings WHERE value = $1', [connectionId])).rowCount).toBe(1);
    expect((await deleteBen(ben)).status).toBe(204);
    const after = await read(pod, creator);
    expect(after.text).not.toContain(connectionId);
    expect(verifyRecord(after.text)).toMatchObject({ ok: true, errors: [] });
  });

  it('a child grant\'s connection goes with the grant\'s owner, not the agent that attenuated it', async () => {
    const { creator, ben, ana, pod } = await seed();
    await appendRecord({ podId: String(pod._id) }, 'child', [lines.grantIssuedLine({
      grantId: 'g-child', parentGrantId: 'g-1', connectionId: 'conn-child', tools: ['sentry.write'], writeMode: 'read', audience: [], target: { kind: 'pod', id: String(pod._id) }, ownerId: String(ben._id),
    }, { type: 'agent', id: String(new User()._id), owner: String(ana._id) })]);
    expect((await read(pod, creator)).text).toContain('conn-child');
    expect((await deleteBen(ben)).status).toBe(204);
    expect((await read(pod, creator)).text).not.toContain('conn-child');
  });

  it('an admin delete a pending self-deletion refuses leaves every id in place', async () => {
    const { ben } = await seed();
    const admin = await person('admin');
    await User.updateOne({ _id: admin._id }, { role: 'admin' });
    const before = (await pool.query('SELECT 1 FROM record_openings WHERE subject = $1', [String(ben._id)])).rowCount;
    expect(before).toBeGreaterThan(0);
    await User.updateOne({ _id: ben._id }, { $set: { accountDeletionRequestedAt: new Date() } });
    await request(app).delete(`/api/admin/users/${ben._id}`).set(as(admin)).expect(409);
    expect((await pool.query('SELECT 1 FROM record_openings WHERE subject = $1', [String(ben._id)])).rowCount).toBe(before);
  });

  it('the sweep also clears a line written after the account went, because its receipt stays', async () => {
    const { creator, ben, pod } = await seed();
    expect((await deleteBen(ben)).status).toBe(204);
    await appendRecord({ podId: String(pod._id) }, 'late', [lines.grantRevokedLine(['g-1'], 'manual', { type: 'human', id: String(ben._id) })]);
    await flushRecordWrites();
    expect((await read(pod, creator)).text).toContain(String(ben._id));
    await sweepAccountDeletions();
    const after = await read(pod, creator);
    expect(after.text).not.toContain(String(ben._id));
    expect(verifyRecord(after.text)).toMatchObject({ ok: true, errors: [] });
  });
});
