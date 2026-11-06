/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * F245: a seat's plain answer to a mention inside a thread lands in that
 * thread. Pod chat on the real message model (pg-mem), the wake from the real
 * enqueueMentions, the delivery from the real claim, and the post from the real
 * postMessage. The CAP route's half is in agentsRuntime.mainChannel.test.js.
 */
const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const mongoose = require('mongoose');
const PGMessage = require('../../../models/pg/Message');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const AgentMessageService = require('../../../services/agentMessageService');
const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const AgentIdentityService = require('../../../services/agentIdentityService');
const AgentEvent = require('../../../models/AgentEvent');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const { RUNNING_TURN_WINDOW_MS } = require('../../../services/mentionCoalesce');
const { JUST_ACKED_MS } = require('../../../services/agentAnswerService');

const AGENT = { agentName: 'codex', instanceId: 'd141' };

describe('an answer to a mention inside a thread lands in that thread (F245)', () => {
  const pgHost = process.env.PG_HOST;
  let human;
  let pod;
  let agentUser;

  const makePod = async (type = 'team') => {
    const made = await Pod.create({
      name: `room-${type}`, type, createdBy: human._id, members: [human._id, agentUser._id],
    });
    await mockPool.query('INSERT INTO pods (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [String(made._id)]);
    await AgentInstallation.create({
      ...AGENT, podId: made._id, displayName: 'D141', version: '1.0.0', status: 'active', installedBy: human._id,
    });
    return made;
  };

  beforeAll(async () => {
    process.env.PG_HOST = 'pg-mem';
    await setupMongoDb();
    await mockPool.query(`CREATE TABLE users (
      _id VARCHAR(255) PRIMARY KEY, username VARCHAR(255), profile_picture TEXT, is_bot BOOLEAN
    )`);
    await mockPool.query(`CREATE TABLE pods (id VARCHAR(255) PRIMARY KEY, updated_at TIMESTAMP WITH TIME ZONE)`);
    await mockPool.query(`CREATE TABLE messages (
      id SERIAL PRIMARY KEY,
      legacy_mongo_id VARCHAR(255),
      pod_id VARCHAR(255) NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      content TEXT,
      message_type VARCHAR(50) DEFAULT 'text',
      author_kind VARCHAR(20),
      payload JSONB,
      summary TEXT,
      kind VARCHAR(20),
      receipt JSONB,
      reply_to_message_id INTEGER,
      thread_root_id INTEGER,
      top_level_answer BOOLEAN,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`);
    jest.spyOn(AgentIdentityService, 'syncUserToPostgreSQL').mockResolvedValue(undefined);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(async () => {
    if (pgHost === undefined) delete process.env.PG_HOST; else process.env.PG_HOST = pgHost;
    jest.restoreAllMocks();
    await closeMongoDb();
  });
  beforeEach(async () => {
    await clearMongoDb();
    await mockPool.query('DELETE FROM messages');
    await mockPool.query('DELETE FROM users');
    await mockPool.query('DELETE FROM pods');
    human = await User.create({ username: 'asker', email: 'asker@example.test', password: 'x'.repeat(12) });
    await mockPool.query('INSERT INTO users (_id, username, is_bot) VALUES ($1, $2, false)', [String(human._id), 'asker']);
    agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT.agentName, { instanceId: AGENT.instanceId });
    await mockPool.query('INSERT INTO users (_id, username, is_bot) VALUES ($1, $2, true)', [String(agentUser._id), agentUser.username]);
    pod = await makePod();
  });

  const say = (content, { root = null, inPod = pod } = {}) => PGMessage.create(
    String(inPod._id), String(human._id), content, 'text', null, null, root,
  );

  const wake = (message, inPod = pod) => AgentMentionService.enqueueMentions({
    podId: inPod._id,
    message: { ...message, _id: message.id, content: message.content },
    userId: human._id,
    username: human.username,
  });

  // The fetch that hands a turn its events: pending becomes delivered.
  const deliver = async (inPod = pod) => {
    const events = await AgentEventService.list({ ...AGENT, podIds: [inPod._id], limit: 50 });
    expect(events.length).toBeGreaterThan(0);
    return events;
  };

  const threadedWake = async () => {
    const root = await say('what should we name this?');
    const asked = await say('@d141 any thoughts?', { root: root.id });
    await wake(asked);
    return { root, asked };
  };

  const heldRow = (fields) => AgentEvent.create({
    ...AGENT, podId: pod._id, type: 'chat.mention', status: 'delivered', deliveredAt: new Date(), ...fields,
  });

  // What the CAP route sends for a plain post.
  const capPost = (fields = {}, inPod = pod) => AgentMessageService.postMessage({
    ...AGENT, podId: inPod._id, content: `reply ${Math.random()}`, inferAnswerThread: true, ...fields,
  });

  const rootOf = async (result) => {
    const { rows } = await mockPool.query('SELECT thread_root_id FROM messages WHERE id = $1', [result.message.id]);
    return rows[0].thread_root_id;
  };

  describe('the answer lands in the thread', () => {
    it('THE REPRO: a plain post with kind answer and no thread fields', async () => {
      const { root } = await threadedWake();
      await deliver();

      const result = await capPost({ kind: 'answer', content: 'Call it Harbor' });

      expect(await rootOf(result)).toBe(root.id);
      expect(result.message.thread_root_id).toBe(root.id);
      expect(result.warnings).toEqual([expect.objectContaining({ code: 'thread_root_from_wake' })]);
      // A filed post is not a root, so the warning names the one that is.
      expect(result.warnings[0].message).toContain(
        `To continue it, use threadRootId ${root.id}. To post in the main channel, send mainChannel: true.`,
      );
    });

    it('a post with no kind, because models leave it off', async () => {
      const { root } = await threadedWake();
      await deliver();
      expect(await rootOf(await capPost())).toBe(root.id);
    });

    it('both answers of a turn, as in the report', async () => {
      const { root } = await threadedWake();
      await deliver();
      expect(await rootOf(await capPost({ kind: 'answer' }))).toBe(root.id);
      expect(await rootOf(await capPost({ kind: 'answer' }))).toBe(root.id);
    });

    it('several wakes of one turn in the same thread agree', async () => {
      const { root } = await threadedWake();
      await deliver();
      const again = await say('@d141 also this', { root: root.id });
      await wake(again);
      await deliver();
      expect(await rootOf(await capPost())).toBe(root.id);
    });

    it('a full page reads the newest deliveries, not whichever rows came back first', async () => {
      const root = await say('what should we name this?');
      const now = Date.now();
      await AgentEvent.insertMany([
        { ...AGENT, podId: pod._id, type: 'heartbeat', status: 'delivered', deliveredAt: new Date(), createdAt: new Date(now - 60000) },
        ...Array.from({ length: 50 }, (_, index) => ({
          ...AGENT,
          podId: pod._id,
          type: 'chat.mention',
          status: 'delivered',
          deliveredAt: new Date(),
          createdAt: new Date(now - index),
          payload: { messageId: String(root.id + index + 1), threadRootId: root.id },
        })),
      ]);
      expect(await rootOf(await capPost())).toBe(root.id);
    });

    it('a wake in the same thread acked a moment ago agrees', async () => {
      const { root } = await threadedWake();
      await deliver();
      await AgentEvent.create({
        ...AGENT, podId: pod._id, type: 'chat.mention', status: 'acked', payload: { threadRootId: root.id },
      });
      expect(await rootOf(await capPost())).toBe(root.id);
    });

    it('a top-level ask acked before this turn says nothing about it', async () => {
      const { root } = await threadedWake();
      await deliver();
      const { insertedId } = await AgentEvent.collection.insertOne({
        ...AGENT,
        podId: pod._id,
        type: 'chat.mention',
        status: 'acked',
        payload: {},
        createdAt: new Date(Date.now() - 60 * 1000),
        updatedAt: new Date(Date.now() - JUST_ACKED_MS - 1000),
      });
      expect(insertedId).toBeDefined();
      expect(await rootOf(await capPost())).toBe(root.id);
    });

    it('a top-level digest row acked beside the wake says nothing about it', async () => {
      const { root } = await threadedWake();
      await deliver();
      await AgentEvent.create({
        ...AGENT, podId: pod._id, type: 'chat.mention', status: 'acked', deliveryMode: 'digest', payload: {},
      });
      expect(await rootOf(await capPost())).toBe(root.id);
    });

    it('a top-level wake that failed a moment ago says nothing about it', async () => {
      const { root } = await threadedWake();
      await deliver();
      await AgentEvent.create({
        ...AGENT, podId: pod._id, type: 'chat.mention', status: 'failed', payload: {},
      });
      expect(await rootOf(await capPost())).toBe(root.id);
    });

    it('a top-level ask another agent or pod just acked says nothing about it', async () => {
      const { root } = await threadedWake();
      await deliver();
      const otherPod = await makePod();
      await AgentEvent.create([
        { ...AGENT, instanceId: 'other', podId: pod._id, type: 'chat.mention', status: 'acked', payload: {} },
        { agentName: 'other', instanceId: AGENT.instanceId, podId: pod._id, type: 'chat.mention', status: 'acked', payload: {} },
        { ...AGENT, podId: otherPod._id, type: 'chat.mention', status: 'acked', payload: {} },
      ]);
      expect(await rootOf(await capPost())).toBe(root.id);
    });

    it('a follower woken by thread activity, not a mention', async () => {
      const root = await say('what should we name this?');
      await AgentEvent.create({
        ...AGENT, podId: pod._id, type: 'message.posted', status: 'delivered', deliveredAt: new Date(),
        payload: { messageId: String(root.id + 1), threadRootId: root.id },
      });
      expect(await rootOf(await capPost())).toBe(root.id);
    });
  });

  describe('the post stays in the channel', () => {
    it('with no way for the agent to say so otherwise: the CAP route clears the flag', async () => {
      await threadedWake();
      await deliver();
      const result = await capPost({ inferAnswerThread: false, kind: 'answer' });
      expect(await rootOf(result)).toBeNull();
      expect(result.warnings).toBeUndefined();
    });

    it.each(['fyi', 'progress'])('kind %s says the post is not the answer', async (kind) => {
      await threadedWake();
      await deliver();
      expect(await rootOf(await capPost({ kind }))).toBeNull();
    });

    it('a caller other than the CAP route: the kernel decides nothing for it', async () => {
      await threadedWake();
      await deliver();
      const result = await AgentMessageService.postMessage({ ...AGENT, podId: pod._id, content: 'system note' });
      expect(await rootOf(result)).toBeNull();
    });

    it('a top-level mention', async () => {
      const asked = await say('@d141 any thoughts?');
      await wake(asked);
      await deliver();
      expect(await rootOf(await capPost({ kind: 'answer' }))).toBeNull();
    });

    it('the limit: a turn holding a thread mention and a top-level one cannot be told apart', async () => {
      await threadedWake();
      await wake(await say('@d141 and a separate question'));
      await deliver();
      expect(await rootOf(await capPost({ kind: 'answer' }))).toBeNull();
    });

    it('the limit: a turn holding two threads cannot be told apart', async () => {
      await threadedWake();
      await threadedWake();
      await deliver();
      expect(await rootOf(await capPost({ kind: 'answer' }))).toBeNull();
    });

    it('a heartbeat beside the mention: a plain post may be about either', async () => {
      await threadedWake();
      await deliver();
      await AgentEvent.create({
        ...AGENT, podId: pod._id, type: 'heartbeat', status: 'delivered', deliveredAt: new Date(), payload: {},
      });
      expect(await rootOf(await capPost())).toBeNull();
    });

    it('a sibling instance of the same agent: its turn is not this one', async () => {
      const root = await say('what should we name this?');
      await heldRow({ instanceId: 'd142', payload: { messageId: String(root.id + 1), threadRootId: root.id } });
      expect(await rootOf(await capPost({ kind: 'answer' }))).toBeNull();
    });

    it('a digest row in the thread: nobody woke for it', async () => {
      const root = await say('what should we name this?');
      await heldRow({
        deliveryMode: 'digest', type: 'message.posted', payload: { messageId: String(root.id + 1), threadRootId: root.id },
      });
      expect(await rootOf(await capPost({ kind: 'answer' }))).toBeNull();
    });

    it('a heartbeat that carries a thread root is still not a message wake', async () => {
      const root = await say('what should we name this?');
      await heldRow({ type: 'heartbeat', payload: { threadRootId: root.id } });
      expect(await rootOf(await capPost({ kind: 'answer' }))).toBeNull();
    });

    it('a mention that has not been delivered: no turn is answering it yet', async () => {
      await threadedWake();
      expect(await rootOf(await capPost())).toBeNull();
    });

    it('after the event is acked: the turn has moved on', async () => {
      await threadedWake();
      await deliver();
      await AgentEvent.updateMany({ ...AGENT }, { $set: { status: 'acked' } });
      expect(await rootOf(await capPost())).toBeNull();
    });

    // F292, on a pi seat: the model sent a plain answer to a top-level ask and
    // commonly_checkpoint_event side by side. The checkpoint landed first, so
    // the only delivery left was the thread mention waiting behind the ask.
    it('THE REPRO: a post beside the checkpoint that acked a top-level ask', async () => {
      await threadedWake();
      await wake(await say('@d141 and a separate question'));
      const delivered = await deliver();
      const ask = delivered.find((event) => !event.payload.threadRootId);
      // A real ask waits before its ack, so only the ack can say it's recent.
      await AgentEvent.collection.updateOne(
        { _id: ask._id }, { $set: { createdAt: new Date(Date.now() - 60 * 1000) } },
      );
      await AgentEventService.acknowledge(ask._id, AGENT.agentName, AGENT.instanceId, null, ask.payload.deliveryId);
      expect((await AgentEvent.findById(ask._id).lean()).status).toBe('acked');

      expect(await rootOf(await capPost({ kind: 'answer' }))).toBeNull();
    });

    it('a heartbeat acked a moment ago that carries the thread is still not a wake', async () => {
      const { root } = await threadedWake();
      await deliver();
      await AgentEvent.create({
        ...AGENT, podId: pod._id, type: 'heartbeat', status: 'acked', payload: { threadRootId: root.id },
      });
      expect(await rootOf(await capPost())).toBeNull();
    });

    it('a failed read of what was just acked: the post still lands, in the channel', async () => {
      await threadedWake();
      await deliver();
      const real = AgentEvent.find.bind(AgentEvent);
      jest.spyOn(AgentEvent, 'find').mockImplementation((query, ...rest) => {
        if (query?.status === 'acked') throw new Error('operation exceeded time limit');
        return real(query, ...rest);
      });
      expect(await rootOf(await capPost())).toBeNull();
    });

    it('a heartbeat acked a moment ago: the post may be about either', async () => {
      await threadedWake();
      await deliver();
      await AgentEvent.create({
        ...AGENT, podId: pod._id, type: 'heartbeat', status: 'acked', payload: {},
      });
      expect(await rootOf(await capPost())).toBeNull();
    });

    it('a delivered row past the running-turn window', async () => {
      await threadedWake();
      await deliver();
      await AgentEvent.updateMany({ ...AGENT }, {
        $set: { deliveredAt: new Date(Date.now() - RUNNING_TURN_WINDOW_MS - 1000) },
      });
      expect(await rootOf(await capPost())).toBeNull();
    });

    it('a post to another pod in the same turn', async () => {
      await threadedWake();
      await deliver();
      const elsewhere = await makePod();
      expect(await rootOf(await capPost({ kind: 'answer' }, elsewhere))).toBeNull();
    });

    it('another agent\'s wake decides nothing for this one', async () => {
      await threadedWake();
      await AgentEvent.updateMany({ ...AGENT }, { $set: { agentName: 'claude-code', status: 'delivered', deliveredAt: new Date() } });
      expect(await rootOf(await capPost())).toBeNull();
    });

    it.each(['agent-room', 'agent-admin'])('a %s pod keeps its plain post as it was', async (type) => {
      const personal = await makePod(type);
      const root = await say('hello', { inPod: personal });
      await AgentEvent.create({
        ...AGENT, podId: personal._id, type: 'chat.mention', status: 'delivered', deliveredAt: new Date(),
        payload: { messageId: String(root.id + 1), threadRootId: root.id, source: 'dm' },
      });
      expect(await rootOf(await capPost({}, personal))).toBeNull();
    });

    it('a comment turn: its wake names a post, not a chat thread', async () => {
      await AgentEvent.create({
        ...AGENT, podId: pod._id, type: 'thread.mention', status: 'delivered', deliveredAt: new Date(),
        payload: { messageId: new mongoose.Types.ObjectId().toString(), thread: { postId: 'p1' } },
      });
      expect(await rootOf(await capPost())).toBeNull();
    });

    it('a root that is gone: the post still lands, in the channel', async () => {
      await AgentEvent.create({
        ...AGENT, podId: pod._id, type: 'chat.mention', status: 'delivered', deliveredAt: new Date(),
        payload: { messageId: '999', threadRootId: 998 },
      });
      const result = await capPost({ kind: 'answer' });
      expect(result.success).toBe(true);
      expect(await rootOf(result)).toBeNull();
    });

    it('a failed wake read: the post still lands, in the channel', async () => {
      await threadedWake();
      await deliver();
      const failed = jest.spyOn(AgentEvent, 'find').mockImplementation(() => { throw new Error('mongo down'); });
      const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await capPost({ kind: 'answer' });
      failed.mockRestore();
      warned.mockRestore();
      expect(result.success).toBe(true);
      expect(await rootOf(result)).toBeNull();
    });
  });

  describe('a post that names a target is left to the rules that already judge it', () => {
    it('threadRootId naming another thread wins over the wake', async () => {
      const other = await say('another topic');
      await threadedWake();
      await deliver();
      const result = await capPost({ threadRootId: String(other.id) });
      expect(await rootOf(result)).toBe(other.id);
      expect(result.warnings).toBeUndefined();
    });

    it('a named thread wins over mainChannel, which only speaks for a plain post', async () => {
      const other = await say('another topic');
      await threadedWake();
      await deliver();
      expect(await rootOf(await capPost({ threadRootId: String(other.id), inferAnswerThread: false }))).toBe(other.id);
    });

    it('a reply edge derives its own root', async () => {
      const other = await say('another topic');
      await threadedWake();
      await deliver();
      expect(await rootOf(await capPost({ replyToMessageId: String(other.id) }))).toBe(other.id);
    });
  });
});
