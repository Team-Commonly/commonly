/**
 * F576: a BYO seat's install intro says "As I post this, nothing is running me
 * yet ... it never updates". The seat connected a minute later and its first
 * turn, reading that sentence, opened by correcting it. Now the seat's first
 * listen rewrites the intro in place to the composer's listening arm, emits
 * `messageUpdated` to the pod, and does both before the check-in returns, so
 * the first event the seat can claim is read against the new text.
 *
 * Real Mongo, the real runtime routes and auth, the Mongo message store (this
 * tier has no Postgres; installIntroOnFirstListen.pg.test.js covers that
 * store). The order of the emit and the response is recorded by the app.
 */
process.env.PG_HOST = '';

jest.mock('express-rate-limit', () => {
  const actual = jest.requireActual('express-rate-limit');
  const pass = () => (_req, _res, next) => next();
  return Object.assign(pass, actual, { default: pass, rateLimit: pass });
});

const mockOrder = [];
const mockEmits = [];
jest.mock('../../config/socket', () => ({
  getIO: () => ({
    to: (room) => ({
      emit: (event, body) => {
        if (event !== 'messageUpdated') return;
        mockOrder.push('emit');
        mockEmits.push({ room, event, body });
      },
    }),
  }),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Message = require('../../models/Message');
const AgentEvent = require('../../models/AgentEvent');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const { composeInstallIntro } = require('../../routes/registry/helpers');
const { resetListenerCheckInThrottle } = require('../../services/agentListenerCheckIn');

const JWT_SECRET = 'intro-first-listen-test-only';
jest.setTimeout(60000);

let app;
let person;
let personToken;
let pod;
let seat;
let seatToken;

const NEVER = composeInstallIntro({
  displayName: 'Rivet', handle: 'rivet', state: 'never-connected',
  fixCommand: 'npx -y @commonlyai/cli@latest agent run rivet', connectable: true,
});
const LISTENING = composeInstallIntro({
  displayName: 'Rivet', handle: 'rivet', state: 'listening', fixCommand: 'unused',
});

const manifest = (name) => ({
  agentName: name, displayName: 'Rivet', description: 'first listen agent',
  registry: 'commonly-official', verified: true,
  manifest: {
    name, version: '1.0.0', capabilities: [{ name: 'memory', description: 'memory' }],
    context: { required: ['context:read'] }, runtime: { type: 'standalone', connection: 'rest' },
  },
  latestVersion: '1.0.0', versions: [{ version: '1.0.0', publishedAt: new Date() }],
});

const seedIntro = (content, payload = { kind: 'install-intro' }) => Message.create({
  podId: pod._id, userId: seat._id, content, messageType: 'text', authorKind: 'kernel', payload,
});

const poll = () => request(app).get('/api/agents/runtime/events').set('Authorization', `Bearer ${seatToken}`);

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  await setupMongoDb();
  app = express();
  app.use(express.json());
  // Records the moment each check-in answers, beside the emits.
  app.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => { mockOrder.push('response'); return json(body); };
    next();
  });
  app.use('/api/registry', require('../../routes/registry'));
  app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
  person = await User.create({ username: 'intro-person', email: 'intro-person@test.com', password: 'password123' });
  personToken = jwt.sign({ id: person._id.toString() }, JWT_SECRET);
  await AgentRegistry.create(manifest('rivet'));
});

afterAll(closeMongoDb);

beforeEach(async () => {
  resetListenerCheckInThrottle();
  await Promise.all([AgentInstallation.deleteMany({}), Message.deleteMany({}), AgentEvent.deleteMany({})]);
  await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });
  pod = await Pod.create({ name: 'Shared', type: 'chat', createdBy: person._id, members: [person._id] });
  const installed = await request(app).post('/api/registry/install').set('Authorization', `Bearer ${personToken}`)
    .send({ agentName: 'rivet', podId: pod._id.toString(), scopes: ['context:read'] });
  expect(installed.status).toBe(200);
  const res = await request(app).post(`/api/registry/pods/${pod._id}/agents/rivet/runtime-tokens`)
    .set('Authorization', `Bearer ${personToken}`).send({ label: 'rivet token' });
  expect(res.status).toBe(200);
  seatToken = res.body.token;
  seat = await User.findOne({ isBot: true, 'botMetadata.agentName': 'rivet' });
  // Whatever the install posted is replaced by the intro each case names.
  await Message.deleteMany({});
  mockOrder.length = 0;
  mockEmits.length = 0;
});

describe('first listen rewrites a never-connected install intro (F576)', () => {
  it('rewrites it to the listening arm and emits messageUpdated before the poll answers', async () => {
    const intro = await seedIntro(NEVER);
    const res = await poll();
    expect(res.status).toBe(200);

    const row = await Message.findById(intro._id).lean();
    expect(row.content).toBe(LISTENING);
    expect(row.payload).toMatchObject({ kind: 'install-intro', introState: 'listening' });
    expect(mockEmits).toEqual([{
      room: `pod_${pod._id}`,
      event: 'messageUpdated',
      body: {
        messageId: String(intro._id),
        podId: String(pod._id),
        content: LISTENING,
        payload: { kind: 'install-intro', introState: 'listening' },
      },
    }]);
    expect(mockOrder).toEqual(['emit', 'response']);
  });

  it('a seat with no first_contact queued (a channel-mode poller) still gets the rewrite', async () => {
    const intro = await seedIntro(NEVER);
    expect(await AgentEvent.countDocuments({ agentName: 'rivet', type: 'first_contact' })).toBe(0);
    const res = await request(app).get('/api/agents/runtime/events')
      .set('Authorization', `Bearer ${seatToken}`).set('User-Agent', 'commonly-mcp/1.0.0');
    expect(res.status).toBe(200);
    expect((await Message.findById(intro._id).lean()).content).toBe(LISTENING);
    expect(mockEmits).toHaveLength(1);
  });

  it('a later listen does nothing: the token has listened before', async () => {
    await User.updateOne(
      { _id: seat._id }, { $set: { 'agentRuntimeTokens.0.lastListenedAt': new Date(Date.now() - 3600 * 1000) } },
    );
    const intro = await seedIntro(NEVER);
    expect((await poll()).status).toBe(200);
    expect((await Message.findById(intro._id).lean()).content).toBe(NEVER);
    expect(mockEmits).toHaveLength(0);
  });

  it('a second poll after the first changes nothing more', async () => {
    await seedIntro(NEVER);
    await poll();
    resetListenerCheckInThrottle();
    mockEmits.length = 0;
    expect((await poll()).status).toBe(200);
    expect(mockEmits).toHaveLength(0);
  });

  it('an agent with no intro in the pod: nothing is written or emitted', async () => {
    const other = await Message.create({
      podId: pod._id, userId: seat._id, content: 'hello', messageType: 'text',
    });
    expect((await poll()).status).toBe(200);
    expect((await Message.findById(other._id).lean()).content).toBe('hello');
    expect(mockEmits).toHaveLength(0);
  });

  it('an intro already in the listening form is left alone', async () => {
    const intro = await seedIntro(LISTENING);
    expect((await poll()).status).toBe(200);
    expect((await Message.findById(intro._id).lean()).payload).toEqual({ kind: 'install-intro' });
    expect(mockEmits).toHaveLength(0);
  });

  it('a first WebSocket connect rewrites it before the connect is admitted', async () => {
    const intro = await seedIntro(NEVER);
    // eslint-disable-next-line global-require
    const ws = require('../../services/agentWebSocketService');
    const info = await ws.validateAgentToken(seatToken);
    expect(info).toMatchObject({ agentName: 'rivet' });
    expect((await Message.findById(intro._id).lean()).content).toBe(LISTENING);
    expect(mockEmits).toHaveLength(1);
  });

  it('a legacy install-bound token on WebSocket rewrites the intro in every pod the agent is in', async () => {
    const podB = await Pod.create({ name: 'Second', type: 'chat', createdBy: person._id, members: [person._id] });
    const second = await request(app).post('/api/registry/install').set('Authorization', `Bearer ${personToken}`)
      .send({ agentName: 'rivet', podId: podB._id.toString(), scopes: ['context:read'] });
    expect(second.status).toBe(200);
    await Message.deleteMany({});
    // Only on pod A's install row: the token predates the bot-row store.
    const raw = 'cm_agent_legacy_first_listen_test';
    // eslint-disable-next-line global-require
    const { hash } = require('../../utils/secret');
    await User.updateOne({ _id: seat._id }, { $set: { agentRuntimeTokens: [] } });
    await AgentInstallation.updateOne(
      { agentName: 'rivet', podId: pod._id },
      { $set: { runtimeTokens: [{ tokenHash: hash(raw), label: 'legacy', createdAt: new Date() }] } },
    );
    const introA = await seedIntro(NEVER);
    const introB = await Message.create({
      podId: podB._id, userId: seat._id, content: NEVER, messageType: 'text', authorKind: 'kernel',
      payload: { kind: 'install-intro' },
    });
    // eslint-disable-next-line global-require
    const ws = require('../../services/agentWebSocketService');
    expect(await ws.validateAgentToken(raw)).toMatchObject({ agentName: 'rivet' });
    expect((await Message.findById(introA._id).lean()).content).toBe(LISTENING);
    expect((await Message.findById(introB._id).lean()).content).toBe(LISTENING);
    expect(mockEmits.map((e) => e.room).sort()).toEqual([`pod_${pod._id}`, `pod_${podB._id}`].sort());
  });

  it('a legacy WebSocket token still validates when the pod lookup fails, and settles its own pod', async () => {
    const podB = await Pod.create({ name: 'Second', type: 'chat', createdBy: person._id, members: [person._id] });
    await request(app).post('/api/registry/install').set('Authorization', `Bearer ${personToken}`)
      .send({ agentName: 'rivet', podId: podB._id.toString(), scopes: ['context:read'] });
    await Message.deleteMany({});
    const raw = 'cm_agent_legacy_lookup_fails_test';
    // eslint-disable-next-line global-require
    const { hash } = require('../../utils/secret');
    await User.updateOne({ _id: seat._id }, { $set: { agentRuntimeTokens: [] } });
    await AgentInstallation.updateOne(
      { agentName: 'rivet', podId: pod._id },
      { $set: { runtimeTokens: [{ tokenHash: hash(raw), label: 'legacy', createdAt: new Date() }] } },
    );
    const introA = await seedIntro(NEVER);
    const introB = await Message.create({
      podId: podB._id, userId: seat._id, content: NEVER, messageType: 'text', authorKind: 'kernel',
      payload: { kind: 'install-intro' },
    });
    const failing = () => ({
      select: () => ({ lean: () => Promise.reject(new Error('install lookup down')) }),
      lean: () => Promise.reject(new Error('install lookup down')),
    });
    const find = jest.spyOn(AgentInstallation, 'find').mockImplementation(failing);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // eslint-disable-next-line global-require
      const ws = require('../../services/agentWebSocketService');
      expect(await ws.validateAgentToken(raw)).toMatchObject({ agentName: 'rivet' });
    } finally {
      find.mockRestore();
      warn.mockRestore();
    }
    expect((await Message.findById(introA._id).lean()).content).toBe(LISTENING);
    expect((await Message.findById(introB._id).lean()).content).toBe(NEVER);
  });

  it('a second rewrite failing still announces the first', async () => {
    const podB = await Pod.create({ name: 'Second', type: 'chat', createdBy: person._id, members: [person._id] });
    await request(app).post('/api/registry/install').set('Authorization', `Bearer ${personToken}`)
      .send({ agentName: 'rivet', podId: podB._id.toString(), scopes: ['context:read'] });
    await Message.deleteMany({});
    await seedIntro(NEVER);
    await Message.create({
      podId: podB._id, userId: seat._id, content: NEVER, messageType: 'text', authorKind: 'kernel',
      payload: { kind: 'install-intro' },
    });
    const real = Message.updateOne.bind(Message);
    let calls = 0;
    const spy = jest.spyOn(Message, 'updateOne').mockImplementation((...args) => {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error('db down')) : real(...args);
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await poll()).status).toBe(200);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
    expect(await Message.countDocuments({ 'payload.introState': 'listening' })).toBe(1);
    expect(mockEmits).toHaveLength(1);
  });

  it('a WebSocket connect whose token already listened through an install copy is not a first listen', async () => {
    // eslint-disable-next-line global-require
    const { hash } = require('../../utils/secret');
    await AgentInstallation.updateOne(
      { agentName: 'rivet', podId: pod._id },
      { $set: { runtimeTokens: [{ tokenHash: hash(seatToken), lastListenedAt: new Date(Date.now() - 3600 * 1000) }] } },
    );
    const intro = await seedIntro(NEVER);
    // eslint-disable-next-line global-require
    const ws = require('../../services/agentWebSocketService');
    await ws.validateAgentToken(seatToken);
    expect((await Message.findById(intro._id).lean()).content).toBe(NEVER);
    expect(mockEmits).toHaveLength(0);
  });

  it('a renew naming an event the seat holds is a first listen too', async () => {
    const intro = await seedIntro(NEVER);
    const event = await AgentEvent.create({
      agentName: 'rivet', instanceId: 'default', podId: pod._id, type: 'chat.mention',
      status: 'delivered', deliveryId: 'd-1', payload: { content: 'hi' },
    });
    const res = await request(app).post('/api/agents/runtime/events/renew')
      .set('Authorization', `Bearer ${seatToken}`)
      .send({ events: [{ eventId: String(event._id), deliveryId: 'd-1' }] });
    expect(res.status).toBe(200);
    expect((await Message.findById(intro._id).lean()).content).toBe(LISTENING);
    expect(mockOrder).toEqual(['emit', 'response']);
  });

  it('a failing rewrite does not fail the poll', async () => {
    await seedIntro(NEVER);
    const spy = jest.spyOn(Message, 'updateOne').mockRejectedValueOnce(new Error('db down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await poll();
      expect(res.status).toBe(200);
      expect(mockEmits).toHaveLength(0);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });
});
