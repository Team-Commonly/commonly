/**
 * F573: the BYO funnel could see `seat-registered` (a token's first
 * authenticated call) but not whether the seat ever listened, so "registered
 * but never listened" was invisible. A token's first listen (events poll,
 * renew or WebSocket connect) now writes one `first-listen` row in
 * byo_telemetry, with the same shape as seat-registered: a hashed key as _id,
 * the installer as userId, the step, and the time. Nothing else.
 *
 * Real Mongo, the real runtime routes and auth: the once-per-token guarantee
 * is the unique _id index, so a mock cannot prove it.
 */
process.env.PG_HOST = '';

jest.mock('express-rate-limit', () => {
  const actual = jest.requireActual('express-rate-limit');
  const pass = () => (_req, _res, next) => next();
  return Object.assign(pass, actual, { default: pass, rateLimit: pass });
});

jest.mock('../../config/socket', () => ({
  getIO: () => ({ to: () => ({ emit: () => {} }) }),
}));

const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentEvent = require('../../models/AgentEvent');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const { resetListenerCheckInThrottle } = require('../../services/agentListenerCheckIn');

const JWT_SECRET = 'byo-first-listen-test-only';
jest.setTimeout(60000);

let app;
let person;
let personToken;
let pod;
let seatToken;

const telemetry = () => mongoose.connection.db.collection('byo_telemetry');
const firstListenRows = () => telemetry().find({ step: 'first-listen' }).toArray();
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The rows are written fire-and-forget, so a fixed sleep raced them under load
// (F573 review: 3 of 3 failed beside byo-runtime-configuration). Every wait is
// a bounded retry on a signal instead, up to 2 s.
const until = async (check, label) => {
  const end = Date.now() + 2000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await check()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await pause(20);
  }
};

// Every insert into byo_telemetry, by step, and how many have settled, so a
// test can wait for the write it caused to finish rather than for time to pass.
let inserts;
let failInserts;
const settledInserts = (step) => inserts.filter((i) => i.step === step && i.settled).length;
const untilSettled = (step, n) => until(() => settledInserts(step) >= n, `${n} settled ${step} insert(s)`);

const seatListenedAt = async () => {
  const seat = await User.findOne({ isBot: true, 'botMetadata.agentName': 'rivet' }).lean();
  const record = (seat?.agentRuntimeTokens || [])[0];
  return record?.lastListenedAt ? record.lastListenedAt.getTime() : 0;
};
// A later check-in's own stamp: the positive signal that its background work ran.
const untilListenedAfter = (before) => until(async () => (await seatListenedAt()) > before, 'a newer lastListenedAt');
const poll = () => request(app).get('/api/agents/runtime/events').set('Authorization', `Bearer ${seatToken}`);

const manifest = (name) => ({
  agentName: name, displayName: 'Rivet', description: 'first listen agent',
  registry: 'commonly-official', verified: true,
  manifest: {
    name, version: '1.0.0', capabilities: [{ name: 'memory', description: 'memory' }],
    context: { required: ['context:read'] }, runtime: { type: 'standalone', connection: 'rest' },
  },
  latestVersion: '1.0.0', versions: [{ version: '1.0.0', publishedAt: new Date() }],
});

const expectOneRowOfSeatShape = async () => {
  const rows = await firstListenRows();
  expect(rows).toHaveLength(1);
  // The seat-registered shape and nothing more: no content, prompt, IP or token.
  expect(Object.keys(rows[0]).sort()).toEqual(['_id', 'at', 'step', 'userId']);
  expect(rows[0]._id).toMatch(/^first-listen:[0-9a-f]{64}$/);
  expect(String(rows[0].userId)).toBe(String(person._id));
  expect(rows[0].at).toBeInstanceOf(Date);
  return rows[0];
};

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  await setupMongoDb();
  app = express();
  app.use(express.json());
  app.use('/api/registry', require('../../routes/registry'));
  app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
  person = await User.create({ username: 'f573-person', email: 'f573-person@test.com', password: 'password123' });
  personToken = jwt.sign({ id: person._id.toString() }, JWT_SECRET);
  await AgentRegistry.create(manifest('rivet'));
});

afterAll(closeMongoDb);

afterEach(() => jest.restoreAllMocks());

beforeEach(async () => {
  resetListenerCheckInThrottle();
  await Promise.all([AgentInstallation.deleteMany({}), AgentEvent.deleteMany({}), telemetry().deleteMany({})]);
  await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });
  pod = await Pod.create({ name: 'Shared', type: 'chat', createdBy: person._id, members: [person._id] });
  const installed = await request(app).post('/api/registry/install').set('Authorization', `Bearer ${personToken}`)
    .send({ agentName: 'rivet', podId: pod._id.toString(), scopes: ['context:read'] });
  expect(installed.status).toBe(200);
  const res = await request(app).post(`/api/registry/pods/${pod._id}/agents/rivet/runtime-tokens`)
    .set('Authorization', `Bearer ${personToken}`).send({ label: 'rivet token' });
  expect(res.status).toBe(200);
  seatToken = res.body.token;
  await telemetry().deleteMany({});
  inserts = [];
  failInserts = false;
  const { db } = mongoose.connection;
  const original = db.collection.bind(db);
  jest.spyOn(db, 'collection').mockImplementation((name, ...rest) => {
    const real = original(name, ...rest);
    if (name !== 'byo_telemetry') return real;
    return new Proxy(real, {
      get(target, prop) {
        if (prop !== 'insertOne') {
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (doc, ...args) => {
          const entry = { step: doc?.step, settled: false };
          inserts.push(entry);
          const done = failInserts ? Promise.reject(new Error('telemetry down')) : target.insertOne(doc, ...args);
          return done.finally(() => { entry.settled = true; });
        };
      },
    });
  });
});

describe('first-listen telemetry row (F573)', () => {
  it('the first poll writes one first-listen row, beside seat-registered', async () => {
    expect((await poll()).status).toBe(200);
    await untilSettled('first-listen', 1);
    await untilSettled('seat-registered', 1);
    await expectOneRowOfSeatShape();
    expect(await telemetry().countDocuments({ step: 'seat-registered' })).toBe(1);
  });

  it('a second poll writes none', async () => {
    expect((await poll()).status).toBe(200);
    await untilSettled('first-listen', 1);
    await until(async () => (await seatListenedAt()) > 0, 'the first stamp');
    const first = await expectOneRowOfSeatShape();
    const stamped = await seatListenedAt();
    resetListenerCheckInThrottle();
    await pause(5); // the second stamp must be a later millisecond
    expect((await poll()).status).toBe(200);
    await untilListenedAfter(stamped);
    // The guard read the stamp, so the second poll never tried the write.
    expect(inserts.filter((i) => i.step === 'first-listen')).toHaveLength(1);
    const again = await expectOneRowOfSeatShape();
    expect(again.at).toEqual(first.at);
  });

  it('two concurrent first polls write one row', async () => {
    const [a, b] = await Promise.all([poll(), poll()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    // Each poll that read the token as first tried the write; wait for all of them.
    await untilSettled('first-listen', 1);
    const tried = () => inserts.filter((i) => i.step === 'first-listen').length;
    await until(() => settledInserts('first-listen') === tried(), 'every first-listen insert');
    await expectOneRowOfSeatShape();
  });

  it('two first listens that both passed the guard still write one row', async () => {
    // eslint-disable-next-line global-require
    const { recordFirstListen } = require('../../services/byoTelemetry');
    recordFirstListen(person._id, 'same-token-hash');
    recordFirstListen(person._id, 'same-token-hash');
    await untilSettled('first-listen', 2);
    await expectOneRowOfSeatShape();
  });

  it('a first renew of a held event writes one row', async () => {
    const event = await AgentEvent.create({
      agentName: 'rivet', instanceId: 'default', podId: pod._id, type: 'chat.mention',
      status: 'delivered', deliveryId: 'd-1', payload: { content: 'hi' },
    });
    const res = await request(app).post('/api/agents/runtime/events/renew')
      .set('Authorization', `Bearer ${seatToken}`)
      .send({ events: [{ eventId: String(event._id), deliveryId: 'd-1' }] });
    expect(res.status).toBe(200);
    await untilSettled('first-listen', 1);
    await expectOneRowOfSeatShape();
  });

  it('a first WebSocket connect writes one row, and a later poll writes none', async () => {
    // eslint-disable-next-line global-require
    const ws = require('../../services/agentWebSocketService');
    expect(await ws.validateAgentToken(seatToken)).toMatchObject({ agentName: 'rivet' });
    await untilSettled('first-listen', 1);
    await expectOneRowOfSeatShape();
    const stamped = await seatListenedAt();
    await pause(5);
    expect((await poll()).status).toBe(200);
    await untilListenedAfter(stamped);
    expect(inserts.filter((i) => i.step === 'first-listen')).toHaveLength(1);
    await expectOneRowOfSeatShape();
  });

  it('a legacy install-bound token\'s first WebSocket connect writes one row', async () => {
    const raw = 'cm_agent_legacy_f573_test';
    // eslint-disable-next-line global-require
    const { hash } = require('../../utils/secret');
    await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });
    await AgentInstallation.updateOne(
      { agentName: 'rivet', podId: pod._id },
      { $set: { runtimeTokens: [{ tokenHash: hash(raw), label: 'legacy', createdAt: new Date() }] } },
    );
    // eslint-disable-next-line global-require
    const ws = require('../../services/agentWebSocketService');
    expect(await ws.validateAgentToken(raw)).toMatchObject({ agentName: 'rivet' });
    await untilSettled('first-listen', 1);
    await expectOneRowOfSeatShape();
  });

  it('a telemetry write failure still answers the poll normally', async () => {
    failInserts = true;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await poll();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    await untilSettled('first-listen', 1);
    const warned = () => warn.mock.calls
      .some(([m, e]) => m === '[byo-telemetry] write failed:' && e === 'telemetry down');
    await until(warned, 'the warning');
    expect(await firstListenRows()).toHaveLength(0);
  });
});
