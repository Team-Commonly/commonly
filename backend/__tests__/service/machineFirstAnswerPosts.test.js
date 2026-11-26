/**
 * F639. A machine's `firstAnswerAt` was stamped only from an event ack whose
 * self-reported outcome was `posted` on a person-waiting event type. A daemon
 * seat that answered through `commonly_post_message` (or a comment tool), or
 * answered a person's plain message (a `message.posted` wake), posted for real
 * and left the stamp unset, so the BYO funnel undercounted first answers.
 *
 * The post paths a daemon seat uses now stamp it themselves: the CAP message
 * route (the wrapper's final text and the MCP post tool both land there) and
 * the CAP thread-comment route. Real Mongo through the real routes.
 */
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const { hash } = require('../../utils/secret');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Post = require('../../models/Post');
const Machine = require('../../models/Machine');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { noteMachinePosted } = require('../../services/machineService');

jest.mock('../../config/socket', () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));

jest.setTimeout(60_000);

let n = 0;
const uniq = () => { n += 1; return `${n}-${new mongoose.Types.ObjectId().toString().slice(-6)}`; };

const person = async () => User.create({
  username: `p-${uniq()}`, email: `${uniq()}@example.test`, password: 'Password123!', verified: true,
});

const machineFor = async (owner) => Machine.create({
  ownerUserId: owner._id, machineId: `m-${uniq()}`, name: 'windows laptop',
});

// A daemon seat: a bot User bound to `machine` (or to none), installed in a pod
// it is a member of, holding a runtime token.
const seatIn = async (owner, machine) => {
  const agentName = `seat-${uniq()}`;
  const bot = await User.create({
    username: agentName,
    email: `${agentName}@agents.commonly.local`,
    password: 'Password123!',
    isBot: true,
    botType: 'agent',
    botMetadata: { agentName, instanceId: 'default', ...(machine ? { machineId: machine.machineId } : {}) },
  });
  const pod = await Pod.create({
    name: `pod ${agentName}`, type: 'chat', createdBy: owner._id, members: [owner._id, bot._id],
  });
  await AgentInstallation.create({
    agentName, instanceId: 'default', podId: pod._id, version: '1.0.0', installedBy: owner._id, status: 'active',
  });
  const token = `cm_agent_${uniq().replace(/[^a-z0-9]/gi, '').padEnd(32, 'x')}`;
  bot.agentRuntimeTokens.push({ tokenHash: hash(token), label: 'seat', createdAt: new Date() });
  await bot.save();
  return { bot, pod, token };
};

const postMessage = (seat, content) => request(app)
  .post(`/api/agents/runtime/pods/${seat.pod._id}/messages`)
  .set('Authorization', `Bearer ${seat.token}`)
  .send({ content, continueAnyway: true });

const postComment = async (seat, owner, content) => {
  const post = await Post.create({ content: 'a question', userId: owner._id, podId: seat.pod._id });
  return request(app)
    .post(`/api/agents/runtime/threads/${post._id}/comments`)
    .set('Authorization', `Bearer ${seat.token}`)
    .send({ content });
};

const stampOf = async (machine) => (await Machine.findById(machine._id).lean()).firstAnswerAt;

// The stamp is fire-and-forget, so the response can land before the write.
const settle = async (machine, expectSet) => {
  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const value = await stampOf(machine);
    if (Boolean(value) === expectSet) return value;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return stampOf(machine);
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([
    User.deleteMany({}), Pod.deleteMany({}), Post.deleteMany({}),
    Machine.deleteMany({}), AgentInstallation.deleteMany({}),
  ]);
});

describe('a daemon seat\'s post stamps its machine\'s first answer (F639)', () => {
  it('stamps from the CAP message route, where the wrapper and the MCP post tool both post', async () => {
    const owner = await person();
    const machine = await machineFor(owner);
    const seat = await seatIn(owner, machine);
    const res = await postMessage(seat, 'here is the answer');
    expect(res.status).toBe(200);
    expect(res.body.skipped).not.toBe(true);
    expect(await settle(machine, true)).toBeInstanceOf(Date);
  });

  it('stamps from the CAP thread-comment route', async () => {
    const owner = await person();
    const machine = await machineFor(owner);
    const seat = await seatIn(owner, machine);
    const res = await postComment(seat, owner, 'answering your post');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await settle(machine, true)).toBeInstanceOf(Date);
  });

  it('keeps the first stamp: a second post does not move it', async () => {
    const owner = await person();
    const machine = await machineFor(owner);
    const seat = await seatIn(owner, machine);
    await postMessage(seat, 'first answer').expect(200);
    const first = await settle(machine, true);
    expect(first).toBeInstanceOf(Date);
    await new Promise((resolve) => { setTimeout(resolve, 15); });
    await postMessage(seat, 'second answer').expect(200);
    await postComment(seat, owner, 'a comment too');
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(await stampOf(machine)).toEqual(first);
  });

  it('a post that posts nothing (the NO_REPLY sentinel) does not stamp', async () => {
    const owner = await person();
    const machine = await machineFor(owner);
    const seat = await seatIn(owner, machine);
    const res = await postMessage(seat, 'NO_REPLY').expect(200);
    expect(res.body.skipped).toBe(true);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(await stampOf(machine)).toBeNull();
  });

  it('a post from an agent bound to no machine touches no machine', async () => {
    const owner = await person();
    const machine = await machineFor(owner);
    const seat = await seatIn(owner, null);
    await postMessage(seat, 'hello').expect(200);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(await stampOf(machine)).toBeNull();
  });

  it('a failing stamp never fails the post', async () => {
    const owner = await person();
    const machine = await machineFor(owner);
    const seat = await seatIn(owner, machine);
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(Machine, 'updateOne').mockImplementation(() => Promise.reject(new Error('mongo down')));
    const res = await postMessage(seat, 'still delivered');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const comment = await postComment(seat, owner, 'also delivered');
    expect(comment.status).toBe(200);
    expect(comment.body.success).toBe(true);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(warn).toHaveBeenCalledWith(
      '%s', '[machine] first-answer stamp failed:', expect.objectContaining({ message: 'mongo down' }),
    );
  });
});

// The /bot/* routes post as the bot user with a user API token. That bot user
// can be bound to a machine too.
describe('a bot-token post stamps its machine too', () => {
  const apiTokenFor = async (seat) => {
    const account = await User.findById(seat.bot._id);
    const token = account.generateApiToken();
    await account.save();
    return token;
  };

  it('stamps from POST /bot/pods/:podId/messages', async () => {
    const owner = await person();
    const machine = await machineFor(owner);
    const seat = await seatIn(owner, machine);
    const res = await request(app)
      .post(`/api/agents/runtime/bot/pods/${seat.pod._id}/messages`)
      .set('Authorization', `Bearer ${await apiTokenFor(seat)}`)
      .send({ content: 'an answer', continueAnyway: true });
    expect(res.status).toBe(200);
    expect(res.body.skipped).not.toBe(true);
    expect(await settle(machine, true)).toBeInstanceOf(Date);
  });

  it('does not stamp from a bot-token NO_REPLY', async () => {
    const owner = await person();
    const machine = await machineFor(owner);
    const seat = await seatIn(owner, machine);
    const res = await request(app)
      .post(`/api/agents/runtime/bot/pods/${seat.pod._id}/messages`)
      .set('Authorization', `Bearer ${await apiTokenFor(seat)}`)
      .send({ content: 'NO_REPLY', continueAnyway: true });
    expect(res.body.skipped).toBe(true);
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(await stampOf(machine)).toBeNull();
  });

  it('stamps from POST /bot/threads/:threadId/comments', async () => {
    const owner = await person();
    const machine = await machineFor(owner);
    const seat = await seatIn(owner, machine);
    const post = await Post.create({ content: 'a question', userId: owner._id, podId: seat.pod._id });
    const res = await request(app)
      .post(`/api/agents/runtime/bot/threads/${post._id}/comments`)
      .set('Authorization', `Bearer ${await apiTokenFor(seat)}`)
      .send({ content: 'a comment' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await settle(machine, true)).toBeInstanceOf(Date);
  });
});

// "First answer" is a person seeing their agent answer. An agent-dm pod holds
// two agents and no person (ADR-001 §3.10), so a post there is not one.
describe('a post into an agent-to-agent DM is not the machine\'s first answer', () => {
  const dmFor = async (owner, seat) => {
    const peer = await User.create({
      username: `peer-${uniq()}`,
      email: `${uniq()}@agents.commonly.local`,
      password: 'Password123!',
      isBot: true,
      botType: 'agent',
      botMetadata: { agentName: 'peer', instanceId: 'default' },
    });
    const pod = await Pod.create({
      name: 'agent dm', type: 'agent-dm', createdBy: seat.bot._id, members: [seat.bot._id, peer._id],
    });
    await AgentInstallation.create({
      agentName: seat.bot.botMetadata.agentName,
      instanceId: 'default',
      podId: pod._id,
      version: '1.0.0',
      installedBy: owner._id,
      status: 'active',
    });
    return pod;
  };

  it('does not stamp on an agent-dm post, and a later post in a pod a person is in does', async () => {
    const owner = await person();
    const machine = await machineFor(owner);
    const seat = await seatIn(owner, machine);
    const dm = await dmFor(owner, seat);
    const res = await postMessage({ ...seat, pod: dm }, 'hello peer');
    expect(res.status).toBe(200);
    expect(res.body.skipped).not.toBe(true);
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(await stampOf(machine)).toBeNull();

    await postMessage(seat, 'hello person').expect(200);
    expect(await settle(machine, true)).toBeInstanceOf(Date);
  });

  it('noteMachinePosted skips an agent-dm pod, and reads no pod for a stamped machine', async () => {
    const owner = await person();
    const machine = await machineFor(owner);
    const seat = await seatIn(owner, machine);
    const dm = await dmFor(owner, seat);
    const agentUser = { botMetadata: { machineId: machine.machineId } };
    const update = jest.spyOn(Machine, 'updateOne');
    noteMachinePosted(agentUser, { podId: dm._id });
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(update).not.toHaveBeenCalled();
    expect(await stampOf(machine)).toBeNull();

    noteMachinePosted(agentUser, { podId: seat.pod._id });
    expect(await settle(machine, true)).toBeInstanceOf(Date);

    const podRead = jest.spyOn(Pod, 'findById');
    update.mockClear();
    noteMachinePosted(agentUser, { podId: seat.pod._id });
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(podRead).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('noteMachinePosted', () => {
  it('writes with one conditional update and never throws', async () => {
    const owner = await person();
    const machine = await machineFor(owner);
    const spy = jest.spyOn(Machine, 'updateOne');
    noteMachinePosted({ botMetadata: { machineId: machine.machineId } });
    expect(await settle(machine, true)).toBeInstanceOf(Date);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ machineId: machine.machineId, firstAnswerAt: null });
    expect(() => noteMachinePosted(null)).not.toThrow();
    expect(() => noteMachinePosted({ botMetadata: { machineId: 42 } })).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
