/**
 * F253: a repeat that answers a new ask is not spam.
 *
 * Prod, 2026-11-06: the seat posted "Blue" as 130062 to a person's 130061. The
 * person replied under it, 130064, "@seat and a river near that color? one
 * word". The seat's next turn answered "Blue", `duplicate_recent` skipped it
 * against 130062, the tool said success, the seat ended NO_REPLY and the person
 * saw nothing.
 *
 * Real Mongo, the real runtime message route and the real mention path, so the
 * event rows here are the ones routing writes, not ones a test imagined. The
 * Mongo message store stands in for Postgres; the in-thread case feeds
 * Postgres-shaped rows, because no Postgres runs in this tier.
 */
process.env.PG_HOST = '';

// Who wrote in a thread is a Postgres read, and this tier has no Postgres.
jest.mock('../../services/threadWakeScopeService', () => {
  const actual = jest.requireActual('../../services/threadWakeScopeService');
  return { ...actual, threadAuthorIds: jest.fn(actual.threadAuthorIds) };
});

// The seats here post far more per minute than the runtime limiter allows.
jest.mock('express-rate-limit', () => {
  const actual = jest.requireActual('express-rate-limit');
  const pass = () => (_req, _res, next) => next();
  return Object.assign(pass, actual, { default: pass, rateLimit: pass });
});

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Message = require('../../models/Message');
const AgentEvent = require('../../models/AgentEvent');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentMessageService = require('../../services/agentMessageService');
const AgentMentionService = require('../../services/agentMentionService');
const Task = require('../../models/Task');
const { threadAuthorIds } = require('../../services/threadWakeScopeService');
const MessageClaimService = require('../../services/messageClaimService');

const JWT_SECRET = 'duplicate-answer-test-only';
jest.setTimeout(60000);

let app;
let person;
let personToken;
let pod;
let seat;
let seatToken;
let other;
let otherToken;

const manifest = (name) => ({
  agentName: name, displayName: name, description: 'duplicate answer agent',
  registry: 'commonly-official', verified: true,
  manifest: {
    name, version: '1.0.0', capabilities: [{ name: 'memory', description: 'memory' }],
    context: { required: ['context:read'] }, runtime: { type: 'standalone', connection: 'rest' },
  },
  latestVersion: '1.0.0', versions: [{ version: '1.0.0', publishedAt: new Date() }],
});

const install = async (agentName) => {
  const installed = await request(app).post('/api/registry/install').set('Authorization', `Bearer ${personToken}`)
    .send({ agentName, podId: pod._id.toString(), scopes: ['context:read'] });
  expect(installed.status === 200 ? 200 : installed.body).toBe(200);
  const res = await request(app).post(`/api/registry/pods/${pod._id}/agents/${agentName}/runtime-tokens`)
    .set('Authorization', `Bearer ${personToken}`).send({ label: `${agentName} token` });
  expect(res.status).toBe(200);
  return res.body.token;
};

const tick = () => new Promise((resolve) => { setTimeout(resolve, 5); });

const post = async (token, content, extra = {}) => {
  await tick();
  return request(app).post(`/api/agents/runtime/pods/${pod._id}/messages`)
    .set('Authorization', `Bearer ${token}`).send({ content, continueAnyway: true, ...extra });
};

// A message exactly as a person's or agent's send reaches the mention path.
const say = async (author, content, extra = {}) => {
  await tick();
  const row = await Message.create({ podId: pod._id, userId: author._id, content, messageType: 'text' });
  await AgentMentionService.enqueueMentions({
    podId: pod._id,
    message: { _id: row._id, content, createdAt: row.createdAt, ...extra.message },
    userId: author._id,
    username: author.username,
    ...(extra.replyToMessageId ? { replyToMessageId: extra.replyToMessageId } : {}),
  });
  return row;
};

// The agent's own view of its inbox: a real claim, a real ack.
const claim = async (token = seatToken) => {
  const res = await request(app).get('/api/agents/runtime/events').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.events;
};

const ack = (event, result) => request(app).post(`/api/agents/runtime/events/${event._id}/ack`)
  .set('Authorization', `Bearer ${seatToken}`)
  .send({ deliveryId: event.deliveryId, result });

// What @commonlyai/mcp's commonly_checkpoint_event sends.
const CHECKPOINT = { outcome: 'acknowledged', reason: 'handled-checkpoint' };

const askRow = (message) => AgentEvent.findOne({ agentName: 'alice', 'payload.messageId': String(message._id) }).lean();

const copies = async (content) => (await Message.find({ podId: pod._id, content }).lean()).length;

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  await setupMongoDb();
  app = express();
  app.use(express.json());
  app.use('/api/registry', require('../../routes/registry'));
  app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
  person = await User.create({ username: 'dup-person', email: 'dup-person@test.com', password: 'password123' });
  personToken = jwt.sign({ id: person._id.toString() }, JWT_SECRET);
  await AgentRegistry.create(manifest('alice'));
  await AgentRegistry.create(manifest('bob'));
});

afterAll(closeMongoDb);

beforeEach(async () => {
  await Promise.all([AgentInstallation.deleteMany({}), Message.deleteMany({}), AgentEvent.deleteMany({})]);
  await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });
  pod = await Pod.create({ name: 'Shared', type: 'chat', createdBy: person._id, members: [person._id] });
  seatToken = await install('alice');
  otherToken = await install('bob');
  seat = await User.findOne({ isBot: true, 'botMetadata.agentName': 'alice' });
  other = await User.findOne({ isBot: true, 'botMetadata.agentName': 'bob' });
  await AgentEvent.deleteMany({});
  await Message.deleteMany({});
});

describe('a person has an open ask of this agent since its copy', () => {
  test('an @mention lets the identical answer through', async () => {
    expect((await post(seatToken, 'Blue')).body.message).toBeTruthy();
    await say(person, '@alice what colour again?');
    const repeat = await post(seatToken, 'Blue');
    expect(repeat.body.skipped).toBeUndefined();
    expect(await copies('Blue')).toBe(2);
  });

  test('a handle only routing can resolve counts: the display-name slug', async () => {
    await AgentInstallation.updateOne({ podId: pod._id, agentName: 'alice' }, { displayName: 'Sky Reader' });
    await post(seatToken, 'Blue');
    await say(person, '@sky-reader what colour again?');
    expect((await post(seatToken, 'Blue')).body.skipped).toBeUndefined();
    expect(await copies('Blue')).toBe(2);
  });

  test('a reply to the agent\'s message counts, with no @ in it', async () => {
    const first = await post(seatToken, 'Blue');
    await say(person, 'and now?', {
      message: { replyTo: { userId: seat._id } },
      replyToMessageId: String(first.body.message.id || first.body.message._id),
    });
    expect((await post(seatToken, 'Blue')).body.skipped).toBeUndefined();
    expect(await copies('Blue')).toBe(2);
  });

  test('one ask buys one repeat: the next identical post is skipped again', async () => {
    await post(seatToken, 'Blue');
    await say(person, '@alice again?');
    await post(seatToken, 'Blue');
    const third = await post(seatToken, 'Blue');
    expect(third.body).toMatchObject({ skipped: true, reason: 'duplicate_recent' });
    expect(await copies('Blue')).toBe(2);
  });

  test('a new ask buys a new repeat', async () => {
    await post(seatToken, 'Blue');
    await say(person, '@alice again?');
    await post(seatToken, 'Blue');
    await say(person, '@alice and once more?');
    expect((await post(seatToken, 'Blue')).body.skipped).toBeUndefined();
    expect(await copies('Blue')).toBe(3);
  });

  test('the ask stays open while its turn runs', async () => {
    await post(seatToken, 'Blue');
    const asked = await say(person, '@alice again?');
    await claim();
    expect(await askRow(asked)).toMatchObject({ status: 'delivered' });
    const repeat = await post(seatToken, 'Blue');
    expect(repeat.status).toBe(200);
    expect(repeat.body.skipped).toBeUndefined();
    expect(await copies('Blue')).toBe(2);
  });

  test('a person\'s message joined to an older pending row still counts (ADR-018 D6.5)', async () => {
    const asked = await Message.create({ podId: pod._id, userId: person._id, content: '@alice one', messageType: 'text' });
    const row = await AgentEvent.create({
      agentName: 'alice', instanceId: 'default', podId: pod._id, type: 'chat.mention',
      payload: { messageId: String(asked._id), userId: person._id, senderIsHuman: true },
    });
    await post(seatToken, 'Blue');
    await tick();
    const joined = await Message.create({ podId: pod._id, userId: person._id, content: '@alice two', messageType: 'text' });
    await AgentEvent.updateOne({ _id: row._id }, {
      $push: { 'payload.coalesced': { messageId: String(joined._id), userId: String(person._id) } },
    });
    const repeat = await post(seatToken, 'Blue');
    expect(repeat.status).toBe(200);
    expect(repeat.body.skipped).toBeUndefined();
    expect(await copies('Blue')).toBe(2);
  });

  describe('the 2026-11-06 walk: a thread reply under the agent\'s own message', () => {
    const THREAD = 130062;
    const walk = async () => {
      const seen = [
        { id: 130061, content: '@alice pick a color', createdAt: new Date(Date.now() - 40000), userId: { _id: String(person._id) } },
        { id: THREAD, content: 'Blue', createdAt: new Date(Date.now() - 26000), userId: { _id: String(seat._id) } },
      ];
      const asked = {
        id: 130064,
        content: '@alice and a river near that color? one word',
        thread_root_id: THREAD,
        reply_to_message_id: THREAD,
        createdAt: new Date(),
      };
      await AgentMentionService.enqueueMentions({
        podId: pod._id,
        message: { ...asked, replyTo: { userId: seat._id } },
        userId: person._id,
        username: person.username,
        replyToMessageId: String(THREAD),
      });
      seen.push({ ...asked, userId: { _id: String(person._id) } });
      const spy = jest.spyOn(AgentMessageService, 'getRecentMessages').mockResolvedValue(seen);
      const [event] = await claim();
      expect(event).toMatchObject({ type: 'chat.mention' });
      expect(event.payload).toMatchObject({ messageId: '130064', threadRootId: THREAD, senderIsHuman: true });
      return { event, seen, spy };
    };

    test('the seat\'s different turn answers with the same word, and it lands', async () => {
      const { spy } = await walk();
      try {
        const repeat = await post(seatToken, 'Blue');
        expect(repeat.body.skipped).toBeUndefined();
        expect(repeat.body.message).toBeTruthy();
      } finally {
        spy.mockRestore();
      }
    });

    test('it still lands when the seat\'s checkpoint reached the kernel before its post', async () => {
      const { event, seen, spy } = await walk();
      try {
        expect((await ack(event, CHECKPOINT)).status).toBe(200);
        expect(await AgentEvent.findById(event._id).lean()).toMatchObject({ status: 'acked' });
        const repeat = await post(seatToken, 'Blue');
        expect(repeat.body.skipped).toBeUndefined();
        expect(repeat.body.message).toBeTruthy();
        // And that was its one repeat.
        seen.push({ id: 130065, content: 'Blue', createdAt: new Date(), userId: { _id: String(seat._id) } });
        expect((await post(seatToken, 'Blue')).body).toMatchObject({ skipped: true, reason: 'duplicate_recent' });
      } finally {
        spy.mockRestore();
      }
    });
  });

  test('a plain reply that joined an older row still counts', async () => {
    const asked = await say(person, '@alice one');
    const first = await post(seatToken, 'Blue');
    const said = await say(person, 'and now?', {
      message: { replyTo: { userId: seat._id } },
      replyToMessageId: String(first.body.message.id || first.body.message._id),
    });
    expect((await askRow(asked)).payload.coalesced.map((entry) => entry.messageId)).toEqual([String(said._id)]);
    expect((await post(seatToken, 'Blue')).body.skipped).toBeUndefined();
    expect(await copies('Blue')).toBe(2);
  });

  test('neither other guard undoes it: the run cap and a repeated link both let it pass', async () => {
    const answer = 'See https://example.com/colour for Blue';
    await post(seatToken, answer);
    await post(seatToken, 'two');
    await post(seatToken, 'three');
    await say(person, '@alice again?');
    const repeat = await post(seatToken, answer);
    expect(repeat.body.skipped).toBeUndefined();
    expect(repeat.body.refused).toBeUndefined();
    expect(await copies(answer)).toBe(2);
  });
});

describe('the guard still holds', () => {
  const expectSkipped = async () => {
    const repeat = await post(seatToken, 'Blue');
    expect(repeat.body).toMatchObject({ skipped: true, reason: 'duplicate_recent' });
    expect(await copies('Blue')).toBe(1);
  };

  test('when nobody spoke', async () => {
    await post(seatToken, 'Blue');
    await expectSkipped();
  });

  test('when a person spoke but addressed nobody', async () => {
    await post(seatToken, 'Blue');
    await say(person, 'nice weather');
    await expectSkipped();
  });

  test('when a person addressed a different agent', async () => {
    await post(seatToken, 'Blue');
    await say(person, '@bob what do you think?');
    await expectSkipped();
  });

  test('when the person spoke before the copy', async () => {
    await say(person, '@alice colour?');
    await post(seatToken, 'Blue');
    await expectSkipped();
  });

  describe('a person spoke, but not to this agent (a thread it wrote in)', () => {
    const THREAD = 130100;
    const inThread = { message: { thread_root_id: THREAD } };
    let claimants;
    beforeEach(() => {
      threadAuthorIds.mockResolvedValue(new Set([String(seat._id)]));
      claimants = jest.spyOn(MessageClaimService, 'liveClaimantsInThread').mockResolvedValue(new Set());
    });
    afterEach(() => {
      claimants.mockRestore();
      threadAuthorIds.mockReset();
      threadAuthorIds.mockImplementation(jest.requireActual('../../services/threadWakeScopeService').threadAuthorIds);
    });

    test('their @ went to someone else', async () => {
      await post(seatToken, 'Blue');
      const said = await say(person, '@bob what do you think?', inThread);
      const row = await askRow(said);
      expect(row).toMatchObject({ type: 'message.posted' });
      expect(row.payload.addressed).toBe(true);
      expect(await AgentEvent.exists({ agentName: 'bob', type: 'chat.mention' })).toBeTruthy();
      await expectSkipped();
    });

    test('their follow-up named nobody: every seat in the thread would open', async () => {
      await post(seatToken, 'Blue');
      const said = await say(person, 'and now?', inThread);
      expect((await askRow(said)).payload.addressed).toBe(true);
      await expectSkipped();
    });
  });

  test('when a person replied under the agent\'s message but @\'d someone else', async () => {
    const first = await post(seatToken, 'Blue');
    const firstId = String(first.body.message.id || first.body.message._id);
    const said = await say(person, '@bob what do you think of this?', {
      message: { replyTo: { userId: seat._id } },
      replyToMessageId: firstId,
    });
    expect(await askRow(said)).toMatchObject({ type: 'chat.mention', payload: { implicitReply: true } });
    await expectSkipped();
  });

  test('when a reply that @\'d someone else joined an older row for this agent', async () => {
    const asked = await say(person, '@alice one');
    const first = await post(seatToken, 'Blue');
    const said = await say(person, '@bob what do you think of this?', {
      message: { replyTo: { userId: seat._id } },
      replyToMessageId: String(first.body.message.id || first.body.message._id),
    });
    const row = await askRow(asked);
    expect(row.payload.coalesced.map((entry) => entry.messageId)).toEqual([String(said._id)]);
    await expectSkipped();
  });

  test('when a person mentioned a task assigned to the agent', async () => {
    await Task.create({
      podId: pod._id, taskNum: 9, taskId: 'TASK-9', title: 'A task', assignee: 'alice',
    });
    await post(seatToken, 'Blue');
    const said = await say(person, 'TASK-9 looks fine to me');
    expect((await askRow(said)).payload.addressed).toBe(true);
    await expectSkipped();
  });

  test('when the agent already answered the ask: its other texts do not reopen', async () => {
    await post(seatToken, 'The digest');
    await post(seatToken, 'A curated item');
    await say(person, '@alice hi there');
    await post(seatToken, 'Hello!');
    const digest = await post(seatToken, 'The digest');
    const item = await post(seatToken, 'A curated item');
    expect(digest.body).toMatchObject({ skipped: true, reason: 'duplicate_recent' });
    expect(item.body).toMatchObject({ skipped: true, reason: 'duplicate_recent' });
    expect(await copies('The digest')).toBe(1);
    expect(await copies('A curated item')).toBe(1);
  });

  test('when the agent declined the ask', async () => {
    await post(seatToken, 'Blue');
    await say(person, '@alice anything?');
    const [event] = await claim();
    expect((await ack(event, { outcome: 'no_action', reason: 'silent_or_empty' })).status).toBe(200);
    await expectSkipped();
  });

  test('when the ask was checkpointed and that turn is long over', async () => {
    await post(seatToken, 'Blue');
    await say(person, '@alice anything?');
    const [event] = await claim();
    expect((await ack(event, CHECKPOINT)).status).toBe(200);
    await AgentEvent.updateOne({ _id: event._id }, { deliveredAt: new Date(Date.now() - 11 * 60 * 1000) });
    await expectSkipped();
  });

  test('when the ask was retired as failed', async () => {
    await post(seatToken, 'Blue');
    const said = await say(person, '@alice anything?');
    await AgentEvent.updateOne({ 'payload.messageId': String(said._id) }, { status: 'failed' });
    await expectSkipped();
  });

  // F253 finding 3, the other order. A turn replaying its own post and a later
  // turn answering a mid-turn ask look the same from here: see the comment on
  // personAskStillOpen. What it gets instead is the truth and a way out.
  test('when the ask came first: a second ask mid-turn, and the guidance does not deny it', async () => {
    await say(person, '@alice colour?');
    const [running] = await claim();
    const second = await say(person, '@alice colour, please?');
    expect((await askRow(second)).payload.arrivedMidTurn).toBeTruthy();
    await post(seatToken, 'Blue');
    expect((await ack(running, { outcome: 'posted' })).status).toBe(200);
    await claim();
    const repeat = await post(seatToken, 'Blue');
    expect(repeat.body).toMatchObject({ skipped: true, reason: 'duplicate_recent', posted: false });
    expect(repeat.body.guidance).not.toMatch(/addressed/);
    expect(repeat.body.guidance).toMatch(/different words/);
  });

  test('on an ambient wake: a wake-on-message row is not an ask', async () => {
    await post(seatToken, 'Blue');
    await tick();
    const said = await Message.create({ podId: pod._id, userId: person._id, content: 'anyone?', messageType: 'text' });
    await AgentEvent.create({
      agentName: 'alice', instanceId: 'default', podId: pod._id, type: 'message.posted',
      payload: { messageId: String(said._id), wakeOnMessage: true, senderIsHuman: true },
    });
    await expectSkipped();
  });

  test('for a same-id mention in another pod', async () => {
    await post(seatToken, 'Blue');
    await tick();
    const said = await Message.create({ podId: pod._id, userId: person._id, content: 'hello', messageType: 'text' });
    const elsewhere = await Pod.create({ name: 'Other', type: 'chat', createdBy: person._id, members: [person._id] });
    await AgentEvent.create({
      agentName: 'alice', instanceId: 'default', podId: elsewhere._id, type: 'chat.mention',
      payload: { messageId: String(said._id), senderIsHuman: true },
    });
    await expectSkipped();
  });
});

describe('another agent\'s mention opens nothing', () => {
  test('two agents cannot loop identical text past the guard', async () => {
    await post(seatToken, 'Blue @bob');
    await post(otherToken, 'Blue @alice');
    await say(seat, '@bob again');
    await say(other, '@alice again');
    await say(seat, '@bob again');
    const seatRepeat = await post(seatToken, 'Blue @bob');
    const otherRepeat = await post(otherToken, 'Blue @alice');
    expect(seatRepeat.body).toMatchObject({ skipped: true, reason: 'duplicate_recent' });
    expect(otherRepeat.body).toMatchObject({ skipped: true, reason: 'duplicate_recent' });
  });

  test('an agent\'s mention routed to the seat is on the queue and still does not open it', async () => {
    await post(seatToken, 'Blue');
    const said = await say(other, '@alice again?');
    const row = await AgentEvent.findOne({ agentName: 'alice', 'payload.messageId': String(said._id) }).lean();
    expect(row).toBeTruthy();
    expect((await post(seatToken, 'Blue')).body).toMatchObject({ skipped: true });
  });

  test('an agent\'s message joined to a person\'s row does not borrow the person', async () => {
    const asked = await Message.create({ podId: pod._id, userId: person._id, content: '@alice one', messageType: 'text' });
    const row = await AgentEvent.create({
      agentName: 'alice', instanceId: 'default', podId: pod._id, type: 'chat.mention',
      payload: { messageId: String(asked._id), userId: person._id, senderIsHuman: true },
    });
    await post(seatToken, 'Blue');
    await tick();
    const joined = await Message.create({ podId: pod._id, userId: other._id, content: '@alice two', messageType: 'text' });
    await AgentEvent.updateOne({ _id: row._id }, {
      $push: { 'payload.coalesced': { messageId: String(joined._id), userId: String(other._id) } },
    });
    expect((await post(seatToken, 'Blue')).body).toMatchObject({ skipped: true });
  });
});

describe('what the poster is told on a skip that remains', () => {
  test('the route says not posted first, and keeps every field existing readers use', async () => {
    const first = await post(seatToken, 'Blue');
    const repeat = await post(seatToken, 'Blue');
    expect(repeat.status).toBe(200);
    expect(Object.keys(repeat.body).slice(0, 2)).toEqual(['posted', 'guidance']);
    expect(repeat.body.posted).toBe(false);
    expect(repeat.body.guidance).toMatch(/^Not posted/);
    expect(repeat.body.guidance).toContain(String(first.body.message.id || first.body.message._id));
    expect(repeat.body).toMatchObject({
      success: true, skipped: true, reason: 'duplicate_recent', mentionNotices: [],
      duplicate: { dedupeWindowMinutes: 30 },
    });
  });

  test('the bot route says the same', async () => {
    const account = await User.findById(seat._id);
    const apiToken = account.generateApiToken();
    await account.save();
    const send = () => request(app).post(`/api/agents/runtime/bot/pods/${pod._id}/messages`)
      .set('Authorization', `Bearer ${apiToken}`).send({ content: 'Blue', continueAnyway: true });
    const first = await send();
    expect(first.body).toMatchObject({ success: true });
    await tick();
    const repeat = await send();
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ posted: false, skipped: true, reason: 'duplicate_recent' });
    expect(repeat.body.guidance).toMatch(/^Not posted/);
    expect(Object.keys(repeat.body).slice(0, 2)).toEqual(['posted', 'guidance']);
  });

  test('a post that lands carries none of it', async () => {
    const first = await post(seatToken, 'Blue');
    expect(first.body.message).toBeTruthy();
    expect(first.body.posted).toBeUndefined();
    expect(first.body.guidance).toBeUndefined();
  });
});
