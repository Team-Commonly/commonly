/**
 * TASK-784 (D164). A daemon machine records what it runs on, metadata only:
 * the platform, the OS release major, the arch and its CLI version. Nothing
 * on the server said how many machines run on Windows, or whether any agent
 * on one ever answered a person. The machine also records when one of its
 * agents first answered a person (an @mention or a DM), and admin stats
 * count machines by platform and CLI version, with that success view per
 * platform.
 *
 * Real Mongo through the real routes: register, heartbeat, the agent ack and
 * the admin read.
 */
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, generateTestToken } = require('../utils/testUtils');
const { hash } = require('../../utils/secret');
const User = require('../../models/User');
const Machine = require('../../models/Machine');
const AgentEvent = require('../../models/AgentEvent');
const { AgentInstallation } = require('../../models/AgentRegistry');

jest.mock('../../config/socket', () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));

const app = express();
app.use(express.json());
app.use('/api/machines', require('../../routes/machines'));
app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
app.use('/api/admin/analytics', require('../../routes/admin/analytics'));

jest.setTimeout(60_000);

const WINDOWS = { platform: 'win32', osMajor: 10, arch: 'x64', cliVersion: '0.1.245' };
const MAC = { platform: 'darwin', osMajor: 25, arch: 'arm64', cliVersion: '0.1.245' };

const person = async (extra = {}) => User.create({
  username: `p-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
  email: `${new mongoose.Types.ObjectId()}@example.test`,
  password: 'Password123!',
  verified: true,
  ...extra,
});

const register = (user, body) => request(app)
  .post('/api/machines')
  .set('Authorization', `Bearer ${generateTestToken(user._id)}`)
  .send(body);

const heartbeat = (daemonToken, machineDbId, body) => request(app)
  .post(`/api/machines/${machineDbId}/heartbeat`)
  .set('Authorization', `Bearer ${daemonToken}`)
  .send(body);

const row = async (id) => Machine.findById(id).lean();

// A seat bound to `machine`, with a runtime token, and one person-waiting
// event delivered to it.
let seatCount = 0;
const seatOn = async (owner, machine) => {
  seatCount += 1;
  const agentName = `seat-${seatCount}`;
  const podId = new mongoose.Types.ObjectId();
  const bot = await User.create({
    username: agentName,
    email: `${agentName}@agents.commonly.local`,
    password: 'Password123!',
    isBot: true,
    botType: 'agent',
    botMetadata: { agentName, instanceId: 'default', machineId: machine.machineId },
  });
  await AgentInstallation.create({
    agentName, instanceId: 'default', podId, version: '1.0.0', installedBy: owner._id, status: 'active',
  });
  const token = `cm_agent_${String(seatCount).padStart(2, '0').repeat(16)}`;
  bot.agentRuntimeTokens.push({ tokenHash: hash(token), label: 'seat', createdAt: new Date() });
  await bot.save();
  return { agentName, podId, token };
};

const deliveredEvent = async (seat, type = 'chat.mention', payload = null) => AgentEvent.create({
  agentName: seat.agentName,
  instanceId: 'default',
  podId: seat.podId,
  type,
  status: 'delivered',
  attempts: 1,
  deliveredAt: new Date(),
  deliveryNonce: 'd'.repeat(32),
  payload: payload || { messageId: '41', content: '@seat hello', userId: String((await person())._id) },
});

const agentSender = async () => User.create({
  username: `a-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
  email: `${new mongoose.Types.ObjectId()}@agents.commonly.local`,
  password: 'Password123!',
  isBot: true,
  botType: 'agent',
  botMetadata: { agentName: 'other', instanceId: 'default' },
});

const ack = (seat, event, outcome) => request(app)
  .post(`/api/agents/runtime/events/${event._id}/ack`)
  .set('Authorization', `Bearer ${seat.token}`)
  .send({ deliveryId: 'd'.repeat(32), result: { outcome } })
  .expect(200);

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Machine.deleteMany({}), AgentEvent.deleteMany({}), AgentInstallation.deleteMany({}),
  ]);
});

describe('a machine records what it runs on', () => {
  it('stores the host a new CLI sends at registration', async () => {
    const owner = await person();
    const res = await register(owner, { name: 'work laptop', host: WINDOWS }).expect(201);
    const stored = await row(res.body.machine.id);
    expect(stored.host).toEqual(WINDOWS);
    expect(stored.hostReportedAt).toBeInstanceOf(Date);
  });

  it('registers an older CLI that sends no host, and leaves the host null', async () => {
    const owner = await person();
    const res = await register(owner, { name: 'old laptop' }).expect(201);
    const stored = await row(res.body.machine.id);
    expect(stored.host).toBeNull();
    expect(stored.hostReportedAt).toBeNull();
    expect(stored.firstAnswerAt).toBeNull();
  });

  it('keeps metadata only: unknown keys, paths and malformed values are not stored', async () => {
    const owner = await person();
    const res = await register(owner, {
      name: 'laptop',
      host: {
        platform: 'win32',
        osMajor: '10.0.22631',
        arch: 'C:\\Users\\sam',
        cliVersion: '0.1.245; rm -rf /',
        hostname: 'SAMS-PC',
        homedir: 'C:\\Users\\sam',
        username: 'sam',
      },
    }).expect(201);
    const stored = await row(res.body.machine.id);
    expect(stored.host).toEqual({ platform: 'win32', osMajor: null, arch: null, cliVersion: null });
    expect(JSON.stringify(stored)).not.toMatch(/SAMS-PC|Users|sam'|rm -rf/);
  });

  it('refuses an unknown platform name rather than storing caller text', async () => {
    const owner = await person();
    const res = await register(owner, { name: 'laptop', host: { platform: 'my-pc', cliVersion: '0.1.245' } }).expect(201);
    expect((await row(res.body.machine.id)).host).toEqual({
      platform: null, osMajor: null, arch: null, cliVersion: '0.1.245',
    });
  });

  it('updates the host on a check-in that carries one, and keeps it on one that does not', async () => {
    const owner = await person();
    const res = await register(owner, { name: 'laptop', host: WINDOWS }).expect(201);
    const { id } = res.body.machine;
    const upgraded = { ...WINDOWS, cliVersion: '0.1.250' };
    await heartbeat(res.body.daemonToken, id, { agents: [], host: upgraded }).expect(200);
    expect((await row(id)).host).toEqual(upgraded);
    // An older daemon's check-in carries no host: the last report stands.
    await heartbeat(res.body.daemonToken, id, { agents: [] }).expect(200);
    expect((await row(id)).host).toEqual(upgraded);
  });

  it('fills in the host for a machine an older CLI registered, on its first new check-in', async () => {
    const owner = await person();
    const res = await register(owner, { name: 'laptop' }).expect(201);
    await heartbeat(res.body.daemonToken, res.body.machine.id, { host: MAC }).expect(200);
    expect((await row(res.body.machine.id)).host).toEqual(MAC);
  });
});

describe('a machine records when one of its agents first answered a person', () => {
  const setup = async () => {
    const owner = await person();
    const res = await register(owner, { name: 'laptop', host: WINDOWS }).expect(201);
    const machine = await row(res.body.machine.id);
    return { machine, seat: await seatOn(owner, machine) };
  };

  it('stamps the machine when its seat acks an @mention it posted a reply to', async () => {
    const { machine, seat } = await setup();
    await ack(seat, await deliveredEvent(seat), 'posted');
    expect((await row(machine._id)).firstAnswerAt).toBeInstanceOf(Date);
  });

  it('counts a DM reply too, since a person was waiting on it', async () => {
    const { machine, seat } = await setup();
    await ack(seat, await deliveredEvent(seat, 'dm.message'), 'posted');
    expect((await row(machine._id)).firstAnswerAt).toBeInstanceOf(Date);
  });

  it('does not stamp on an ack that posted nothing, or on an event no person was waiting on', async () => {
    const { machine, seat } = await setup();
    await ack(seat, await deliveredEvent(seat), 'no_action');
    await ack(seat, await deliveredEvent(seat, 'heartbeat'), 'posted');
    expect((await row(machine._id)).firstAnswerAt).toBeNull();
  });

  // enqueueDmEvent sends an agent's DM as chat.mention, so the event type alone
  // says nothing about who is waiting.
  it('does not stamp on a mention an agent sent', async () => {
    const { machine, seat } = await setup();
    const sender = await agentSender();
    await ack(seat, await deliveredEvent(seat, 'chat.mention', {
      messageId: '42', content: 'hello', userId: String(sender._id), dmKind: 'agent-agent',
    }), 'posted');
    expect((await row(machine._id)).firstAnswerAt).toBeNull();
  });

  it('does not stamp on a kernel wake, whoever the row names', async () => {
    const { machine, seat } = await setup();
    const owner = await person();
    for (const flag of [{ assignedTaskWake: true }, { boardWake: true }, { triggerAuthor: 'kernel' }]) {
      // eslint-disable-next-line no-await-in-loop
      await ack(seat, await deliveredEvent(seat, 'chat.mention', {
        messageId: '43', content: 'a row moved', userId: String(owner._id), ...flag,
      }), 'posted');
    }
    expect((await row(machine._id)).firstAnswerAt).toBeNull();
  });

  it('does not stamp when the sender is missing or is not a person it can find', async () => {
    const { machine, seat } = await setup();
    await ack(seat, await deliveredEvent(seat, 'chat.mention', { messageId: '44', content: 'hi' }), 'posted');
    await ack(seat, await deliveredEvent(seat, 'chat.mention', {
      messageId: '45', content: 'hi', userId: String(new mongoose.Types.ObjectId()),
    }), 'posted');
    expect((await row(machine._id)).firstAnswerAt).toBeNull();
  });

  it('stamps when an agent\'s row also carries a person\'s message', async () => {
    const { machine, seat } = await setup();
    const sender = await agentSender();
    const waiting = await person();
    await ack(seat, await deliveredEvent(seat, 'chat.mention', {
      messageId: '46',
      content: 'hello',
      userId: String(sender._id),
      coalesced: [{ messageId: '47', userId: String(waiting._id), createdAt: new Date().toISOString() }],
    }), 'posted');
    expect((await row(machine._id)).firstAnswerAt).toBeInstanceOf(Date);
  });

  // A reply under the agent's message that @'d someone else asked them, not it.
  it('does not stamp on a reply that asked someone else', async () => {
    const { machine, seat } = await setup();
    const waiting = await person();
    await ack(seat, await deliveredEvent(seat, 'chat.mention', {
      messageId: '48',
      content: '@pixel can you check this',
      userId: String(waiting._id),
      implicitReply: true,
      mentions: ['pixel'],
    }), 'posted');
    expect((await row(machine._id)).firstAnswerAt).toBeNull();
  });

  // The unanswered line has no room to go to here. The answer still happened.
  it('stamps on a comment on a post with no pod', async () => {
    const { machine, seat } = await setup();
    const waiting = await person();
    await ack(seat, await deliveredEvent(seat, 'thread.mention', {
      messageId: '49',
      content: 'a comment',
      userId: String(waiting._id),
      thread: { postId: 'post-1', postPodId: null },
    }), 'posted');
    expect((await row(machine._id)).firstAnswerAt).toBeInstanceOf(Date);
  });

  it('keeps the first answer: a later one does not move the stamp', async () => {
    const { machine, seat } = await setup();
    await ack(seat, await deliveredEvent(seat), 'posted');
    const first = (await row(machine._id)).firstAnswerAt;
    expect(first).toBeInstanceOf(Date);
    await new Promise((resolve) => { setTimeout(resolve, 15); });
    await ack(seat, await deliveredEvent(seat), 'posted');
    expect((await row(machine._id)).firstAnswerAt).toEqual(first);
  });
});

describe('admin stats count machines by platform and CLI version', () => {
  const machineWith = async (owner, host, answered) => {
    const res = await register(owner, { name: 'm', ...(host ? { host } : {}) }).expect(201);
    if (answered) await Machine.updateOne({ _id: res.body.machine.id }, { $set: { firstAnswerAt: new Date() } });
  };

  it('returns per-platform counts with the answered view, and per-version counts, to an admin', async () => {
    const owner = await person();
    await machineWith(owner, WINDOWS, true);
    await machineWith(owner, WINDOWS, false);
    await machineWith(owner, { ...WINDOWS, cliVersion: '0.1.243' }, false);
    await machineWith(owner, MAC, true);
    await machineWith(owner, null, false);
    const admin = await person({ role: 'admin' });
    const res = await request(app)
      .get('/api/admin/analytics/machines')
      .set('Authorization', `Bearer ${generateTestToken(admin._id)}`)
      .expect(200);
    expect(res.body.total).toBe(5);
    expect(res.body.byPlatform).toEqual([
      { platform: 'win32', machines: 3, answered: 1 },
      { platform: 'darwin', machines: 1, answered: 1 },
      { platform: null, machines: 1, answered: 0 },
    ]);
    expect(res.body.byCliVersion).toEqual([
      { cliVersion: '0.1.245', machines: 3 },
      { cliVersion: '0.1.243', machines: 1 },
      { cliVersion: null, machines: 1 },
    ]);
  });

  it('refuses anyone who is not an admin', async () => {
    const owner = await person();
    await request(app)
      .get('/api/admin/analytics/machines')
      .set('Authorization', `Bearer ${generateTestToken(owner._id)}`)
      .expect(403);
  });
});
