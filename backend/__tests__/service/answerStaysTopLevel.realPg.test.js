/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * F212: the answer to a main-channel @mention lands in the main channel, even
 * when the model threads its own post. Real Postgres and real Mongo: the wake
 * comes from the real enqueueMentions, the post from the real postMessage, and
 * each assertion reads the row back.
 */
const mongoose = require('mongoose');
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

// The models read `pool` from config/db-pg when they load; this holder is
// filled with the test schema's pool before they are required.
const mockDbPg = {};
jest.mock('../../config/db-pg', () => mockDbPg);

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const AGENT = { agentName: 'claude-code', instanceId: 'd141' };
const OTHER_AGENT_USER = 'cccccccccccccccccccccc01';

real('an answer to a main-channel mention stays in the channel (F212)', () => {
  let database;
  let pool;
  let PGMessage;
  let AgentMessageService;
  let WAKE_LOOKUP_WINDOW_MS;
  let WAKE_LOOKUP_MAX_TIME_MS;
  let answerStaysTopLevel;
  let AgentMentionService;
  let AgentIdentityService;
  let AgentEvent;
  let AgentInstallation;
  let Pod;
  let User;
  let human;
  let pod;
  let agentUser;

  const pgPod = async (id, type, createdBy) => pool.query(
    'INSERT INTO pods (id, name, type, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
    [id, 'room', type, createdBy],
  );

  const makePod = async (type = 'team') => {
    const made = await Pod.create({
      name: `room-${type}`, type, createdBy: human._id, members: [human._id, agentUser._id],
    });
    await pgPod(String(made._id), type, String(human._id));
    await AgentInstallation.create({
      ...AGENT, podId: made._id, displayName: 'D141', version: '1.0.0', status: 'active', installedBy: human._id,
    });
    return made;
  };

  beforeAll(async () => {
    await setupMongoDb();
    database = await createRealPgSchema();
    pool = database.pool;
    mockDbPg.pool = pool;
    await runPgMigrations(pool);
    /* eslint-disable global-require -- loaded after the pool holder is filled */
    PGMessage = require('../../models/pg/Message');
    AgentMessageService = require('../../services/agentMessageService');
    ({
      WAKE_LOOKUP_WINDOW_MS, WAKE_LOOKUP_MAX_TIME_MS, answerStaysTopLevel,
    } = require('../../services/agentAnswerService'));
    AgentMentionService = require('../../services/agentMentionService');
    AgentIdentityService = require('../../services/agentIdentityService');
    AgentEvent = require('../../models/AgentEvent');
    ({ AgentInstallation } = require('../../models/AgentRegistry'));
    Pod = require('../../models/Pod');
    User = require('../../models/User');
    /* eslint-enable global-require */
  });
  afterAll(async () => {
    if (database) await database.close();
    await closeMongoDb();
  });
  beforeEach(async () => {
    await clearMongoDb();
    await pool.query('TRUNCATE TABLE messages, pod_members, pods, users RESTART IDENTITY CASCADE');
    human = await User.create({ username: 'asker', email: 'asker@example.test', password: 'x'.repeat(12) });
    await pool.query('INSERT INTO users (_id, username, is_bot) VALUES ($1, $2, false)', [String(human._id), 'asker']);
    await pool.query("INSERT INTO users (_id, username, is_bot) VALUES ($1, 'peer', true)", [OTHER_AGENT_USER]);
    agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT.agentName, { instanceId: AGENT.instanceId });
    await AgentIdentityService.syncUserToPostgreSQL(agentUser);
    pod = await makePod();
  });

  const say = (content, reply = null, { root = null, inPod = pod, author = human } = {}) => PGMessage.create(
    String(inPod._id), String(author._id), content, 'text', reply, null, root,
  );

  // Through the real producer, so the payload the guard reads is the one the
  // kernel writes rather than a copy of it.
  const wake = async (message, inPod = pod, from = human) => {
    await AgentMentionService.enqueueMentions({
      podId: inPod._id,
      message: { ...message, _id: message.id, content: message.content },
      userId: from._id,
      username: from.username,
    });
    const events = await AgentEvent.find({ agentName: AGENT.agentName, instanceId: AGENT.instanceId }).lean();
    expect(events.map((event) => String(event.payload?.messageId))).toContain(String(message.id));
  };

  const post = (fields, inPod = pod) => AgentMessageService.postMessage({
    ...AGENT, podId: inPod._id, content: `reply ${Math.random()}`, ...fields,
  });

  const row = async (result) => {
    const { rows } = await pool.query(
      'SELECT reply_to_message_id, thread_root_id FROM messages WHERE id = $1::int',
      [result.message.id],
    );
    return rows[0];
  };

  describe('the answer lands in the channel', () => {
    it('THE REPRO: replyToMessageId + kind=answer on a top-level mention keeps the quote and no thread', async () => {
      const asked = await say('@d141 name one ocean, one word');
      await wake(asked);

      const result = await post({ replyToMessageId: String(asked.id), kind: 'answer', content: 'Pacific' });

      expect(await row(result)).toEqual({ reply_to_message_id: asked.id, thread_root_id: null });
      expect(result.message.thread_root_id).toBeNull();
      expect(result.message.replyTo).toMatchObject({ id: String(asked.id) });
      expect(result.warnings).toEqual([expect.objectContaining({ code: 'thread_root_dropped' })]);
      expect((await PGMessage.findById(String(result.message.id))).replyTo).toMatchObject({ id: String(asked.id) });
    });

    it('both fields naming the mention', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const result = await post({
        replyToMessageId: String(asked.id), threadRootId: String(asked.id), kind: 'answer',
      });
      expect(await row(result)).toEqual({ reply_to_message_id: asked.id, thread_root_id: null });
    });

    it('threadRootId alone: top-level, and no reply edge is invented', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const result = await post({ threadRootId: String(asked.id) });
      expect(await row(result)).toEqual({ reply_to_message_id: null, thread_root_id: null });
      expect(result.warnings).toEqual([expect.objectContaining({ code: 'thread_root_dropped' })]);
    });

    // ADR-018 D6.5: a second mention from the same person joins the first row,
    // so its id is in `payload.coalesced`, not `payload.messageId`, and the
    // `wake` helper's check does not hold for it.
    const askTwice = async () => {
      const first = await say('@d141 first question');
      await wake(first);
      const second = await say('@d141 and a second one');
      await AgentMentionService.enqueueMentions({
        podId: pod._id,
        message: { ...second, _id: second.id, content: second.content },
        userId: human._id,
        username: human.username,
      });
      const events = await AgentEvent.find({ agentName: AGENT.agentName, instanceId: AGENT.instanceId }).lean();
      expect(events).toHaveLength(1);
      expect(String(events[0].payload.messageId)).toBe(String(first.id));
      expect(events[0].payload.coalesced.map((entry) => String(entry.messageId))).toEqual([String(second.id)]);
      return second;
    };

    it('a joined mention: threadRootId alone lands top-level', async () => {
      const second = await askTwice();
      const result = await post({ threadRootId: String(second.id) });
      expect(await row(result)).toEqual({ reply_to_message_id: null, thread_root_id: null });
      expect(result.warnings).toEqual([expect.objectContaining({ code: 'thread_root_dropped' })]);
    });

    it('a joined mention: replyToMessageId + kind=answer keeps the quote and no thread', async () => {
      const second = await askTwice();
      const result = await post({ replyToMessageId: String(second.id), kind: 'answer' });
      expect(await row(result)).toEqual({ reply_to_message_id: second.id, thread_root_id: null });
      expect(result.warnings).toEqual([expect.objectContaining({ code: 'thread_root_dropped' })]);
    });

    it('a mention answered with no kind at all', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const result = await post({ replyToMessageId: String(asked.id) });
      expect(await row(result)).toEqual({ reply_to_message_id: asked.id, thread_root_id: null });
    });

    it('a question back to the person is not filed away either (kind=ask)', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const result = await post({ replyToMessageId: String(asked.id), kind: 'ask' });
      expect((await row(result)).thread_root_id).toBeNull();
    });

    it('a reconciled message, whose mention names its legacy id, not its Postgres id', async () => {
      const asked = await say('@d141 ping');
      const legacyId = 'abcdefabcdefabcdefabcdef';
      await pool.query('UPDATE messages SET legacy_mongo_id = $1 WHERE id = $2', [legacyId, asked.id]);
      await wake({ ...asked, id: legacyId });
      const result = await post({ replyToMessageId: String(asked.id) });
      expect(await row(result)).toEqual({ reply_to_message_id: asked.id, thread_root_id: null });
    });

    it('kind=answer on a reply edge counts with no wake on record', async () => {
      const asked = await say('anyone know the largest ocean?');
      const result = await post({ replyToMessageId: String(asked.id), kind: 'answer' });
      expect(await row(result)).toEqual({ reply_to_message_id: asked.id, thread_root_id: null });
    });

    it('a person replying to the answer opens a thread under the answer', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const result = await post({ replyToMessageId: String(asked.id), kind: 'answer' });
      const followUp = await say('thanks', String(result.message.id));
      expect(Number(followUp.thread_root_id)).toBe(Number(result.message.id));
    });

    it('a retention repair does not pull it back into a thread', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const result = await post({ replyToMessageId: String(asked.id), kind: 'answer' });
      await PGMessage.reRootOrphanedChains();
      expect((await row(result)).thread_root_id).toBeNull();
    });
  });

  describe('only a person\'s message pulls the answer out of a thread', () => {
    const peer = { _id: OTHER_AGENT_USER, username: 'peer' };

    it('a peer agent\'s top-level @mention keeps the thread', async () => {
      const asked = await say('@d141 can you check this', null, { author: peer });
      await wake(asked, pod, peer);
      const result = await post({ replyToMessageId: String(asked.id), kind: 'answer' });
      expect(await row(result)).toEqual({ reply_to_message_id: asked.id, thread_root_id: asked.id });
      expect(result.warnings || []).toEqual([]);
    });

    it('kind=answer on a reply to a peer keeps the thread', async () => {
      const said = await say('the build is red', null, { author: peer });
      const result = await post({ replyToMessageId: String(said.id), kind: 'answer' });
      expect(await row(result)).toEqual({ reply_to_message_id: said.id, thread_root_id: said.id });
    });

    it('an author of unknown kind keeps the thread', async () => {
      await pool.query('UPDATE users SET is_bot = NULL WHERE _id = $1', [String(human._id)]);
      const asked = await say('@d141 ping');
      await wake(asked);
      const result = await post({ replyToMessageId: String(asked.id), kind: 'answer' });
      expect((await row(result)).thread_root_id).toBe(asked.id);
    });

    it('a two-hop exchange between agents ends in one thread', async () => {
      const peerAgent = { agentName: 'peer-agent', instanceId: 'default' };
      const peerUser = await AgentIdentityService.getOrCreateAgentUser(peerAgent.agentName, {
        instanceId: peerAgent.instanceId,
      });
      await AgentIdentityService.syncUserToPostgreSQL(peerUser);
      const from = { _id: peerUser._id, username: peerUser.username };

      const hop0 = await AgentMessageService.postMessage({ ...peerAgent, podId: pod._id, content: '@d141 first' });
      const opening = { ...hop0.message, id: hop0.message.id };
      await wake(opening, pod, from);
      const hop1 = await post({ replyToMessageId: String(opening.id), kind: 'answer' });
      const hop2 = await AgentMessageService.postMessage({
        ...peerAgent, podId: pod._id, content: '@d141 second', replyToMessageId: String(hop1.message.id), kind: 'answer',
      });
      await wake({ ...hop2.message, id: hop2.message.id }, pod, from);
      const hop3 = await post({ replyToMessageId: String(hop2.message.id), kind: 'answer' });

      const root = Number(opening.id);
      expect((await row(hop1)).thread_root_id).toBe(root);
      expect((await row(hop2)).thread_root_id).toBe(root);
      expect((await row(hop3)).thread_root_id).toBe(root);
    });
  });

  describe('the wake lookup is bounded', () => {
    const ageWake = async (asked, ageMs) => {
      await AgentEvent.collection.updateMany(
        { 'payload.messageId': String(asked.id) },
        { $set: { createdAt: new Date(Date.now() - ageMs) } },
      );
    };
    const MINUTE = 60 * 1000;

    it('is a two-hour window, so a long turn is covered', () => {
      expect(WAKE_LOOKUP_WINDOW_MS).toBe(120 * MINUTE);
    });

    it('a mention just inside the window still decides', async () => {
      const asked = await say('@d141 a long job');
      await wake(asked);
      await ageWake(asked, WAKE_LOOKUP_WINDOW_MS - MINUTE);
      const result = await post({ replyToMessageId: String(asked.id) });
      expect((await row(result)).thread_root_id).toBeNull();
    });

    it('a mention just outside the window no longer decides', async () => {
      const asked = await say('@d141 last week');
      await wake(asked);
      await ageWake(asked, WAKE_LOOKUP_WINDOW_MS + MINUTE);
      const result = await post({ replyToMessageId: String(asked.id) });
      expect(await row(result)).toEqual({ reply_to_message_id: asked.id, thread_root_id: asked.id });
    });

    it('an in-thread wake past the window still keeps the post threaded', async () => {
      const asked = await say('@d141 first question');
      await wake(asked);
      const followUp = await say('@d141 and a follow-up', null, { root: asked.id });
      await wake({ ...followUp, thread_root_id: asked.id });
      await ageWake(followUp, WAKE_LOOKUP_WINDOW_MS + MINUTE);
      await ageWake(asked, WAKE_LOOKUP_WINDOW_MS + 2 * MINUTE);
      const result = await post({ replyToMessageId: String(asked.id), kind: 'answer' });
      expect(await row(result)).toEqual({ reply_to_message_id: asked.id, thread_root_id: asked.id });
    });

    it('the read carries a short server-side time limit', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const findOne = AgentEvent.findOne.bind(AgentEvent);
      let query;
      const spy = jest.spyOn(AgentEvent, 'findOne').mockImplementation((...args) => {
        query = findOne(...args);
        return query;
      });
      try {
        await post({ replyToMessageId: String(asked.id) });
        expect(query.getOptions().maxTimeMS).toBe(WAKE_LOOKUP_MAX_TIME_MS);
        expect(WAKE_LOOKUP_MAX_TIME_MS).toBeLessThanOrEqual(500);
      } finally {
        spy.mockRestore();
      }
    });

    it('a failed lookup still lets a declared answer on a reply edge land top-level', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const spy = jest.spyOn(AgentEvent, 'findOne').mockImplementation(() => { throw new Error('store down'); });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await post({ replyToMessageId: String(asked.id), kind: 'answer' });
        expect(await row(result)).toEqual({ reply_to_message_id: asked.id, thread_root_id: null });
        expect(warn.mock.calls.flat().join(' ')).toContain('[agent-answer]');
      } finally {
        spy.mockRestore();
        warn.mockRestore();
      }
    });

    it('a failed lookup leaves a bare threadRootId declared answer threaded', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const spy = jest.spyOn(AgentEvent, 'findOne').mockImplementation(() => { throw new Error('store down'); });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await post({ threadRootId: String(asked.id), kind: 'answer' });
        expect((await row(result)).thread_root_id).toBe(asked.id);
      } finally {
        spy.mockRestore();
        warn.mockRestore();
      }
    });

    it('a query operator in place of an identity value matches nothing', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const fields = {
        podId: pod._id, agentName: AGENT.agentName, instanceId: AGENT.instanceId, agentUserId: agentUser._id,
        replyToMessageId: String(asked.id),
      };
      expect(await answerStaysTopLevel(fields)).toBe(true);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(await answerStaysTopLevel({ ...fields, instanceId: { $ne: null } })).toBe(false);
        expect(await answerStaysTopLevel({ ...fields, podId: { $ne: null } })).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });

    it('a read that hits the limit leaves the post as sent', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const { exec } = mongoose.Query.prototype;
      const spy = jest.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(function execOrTimeOut(...args) {
        if (this.model?.modelName === 'AgentEvent') {
          return Promise.reject(Object.assign(new Error('operation exceeded time limit'), { code: 50 }));
        }
        return exec.apply(this, args);
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await post({ replyToMessageId: String(asked.id) });
        expect((await row(result)).thread_root_id).toBe(asked.id);
        expect(result.warnings || []).toEqual([]);
      } finally {
        spy.mockRestore();
        warn.mockRestore();
      }
    });
  });

  it('a reply edge alone wakes neither a peer agent nor a person, as the cue says', async () => {
    const peerUser = await AgentIdentityService.getOrCreateAgentUser('peer-agent', { instanceId: 'default' });
    await AgentIdentityService.syncUserToPostgreSQL(peerUser);
    await AgentInstallation.create({
      agentName: 'peer-agent', instanceId: 'default', podId: pod._id, displayName: 'Peer', version: '1.0.0',
      status: 'active', installedBy: human._id,
    });
    const peerSaid = await AgentMessageService.postMessage({
      agentName: 'peer-agent', instanceId: 'default', podId: pod._id, content: 'the build is red',
    });
    const reply = await post({ replyToMessageId: String(peerSaid.message.id), content: 'on it' });
    await AgentMentionService.enqueueAgentPost({
      podId: pod._id, message: reply.message, userId: agentUser._id, username: agentUser.username,
    });
    expect(await AgentEvent.countDocuments({
      agentName: 'peer-agent', type: { $in: ['chat.mention', 'thread.mention'] },
    })).toBe(0);
  });

  it('the threading backfill roots an old reply and leaves a top-level answer alone', async () => {
    const asked = await say('asked');
    await say('a reply written since threading shipped', String(asked.id));
    const answer = await PGMessage.create(
      String(pod._id), String(agentUser._id), 'answer', 'text', String(asked.id), null, null, null, null, null, true,
    );
    const { rows: [old] } = await pool.query(
      `INSERT INTO messages (pod_id, user_id, content, reply_to_message_id, created_at)
       VALUES ($1, $2, 'pre-threading reply', $3, now() - interval '1 day') RETURNING id`,
      [String(pod._id), String(human._id), asked.id],
    );
    const argv = [...process.argv];
    process.argv.push('--apply');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let backfill;
      // eslint-disable-next-line global-require -- --apply is read when the script loads
      jest.isolateModules(() => { backfill = require('../../scripts/backfill-thread-root-id'); });
      await backfill.main(pool);
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(/still|leftover/i);
    } finally {
      process.argv.splice(0, process.argv.length, ...argv);
      log.mockRestore();
      warn.mockRestore();
      await pool.query('DELETE FROM migration_records');
    }
    const threadRootOf = async (id) => (
      await pool.query('SELECT thread_root_id FROM messages WHERE id = $1::int', [id])
    ).rows[0].thread_root_id;
    expect(await threadRootOf(old.id)).toBe(asked.id);
    expect(await threadRootOf(answer.id)).toBeNull();
  });

  describe('everything else stays where it was put', () => {
    const noDrop = (result) => expect(result.warnings || []).toEqual([]);

    it('an agent continuing under its own root (the overflow rule)', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const point = await post({ kind: 'answer' });
      const own = String(point.message.id);
      const detail = await post({ threadRootId: own, kind: 'answer' });
      expect(await row(detail)).toEqual({ reply_to_message_id: null, thread_root_id: Number(own) });
      noDrop(detail);
      const quoted = await post({ replyToMessageId: own, threadRootId: own });
      expect(await row(quoted)).toEqual({ reply_to_message_id: Number(own), thread_root_id: Number(own) });
    });

    it('kind=answer quoting its own post stays under it: no wake is needed to say so', async () => {
      const point = await post({ kind: 'answer' });
      const own = String(point.message.id);
      // The check runs before this post syncs the agent's row, so a drifted
      // mirror row is what it can meet. The overflow rule must not rest on it.
      await pool.query('UPDATE users SET is_bot = false WHERE _id = $1', [String(agentUser._id)]);
      const detail = await post({ replyToMessageId: own, kind: 'answer' });
      expect(await row(detail)).toEqual({ reply_to_message_id: Number(own), thread_root_id: Number(own) });
      noDrop(detail);
    });

    it('kind=answer on a message inside a thread, with no wake on record', async () => {
      const root = await say('a topic');
      const inside = await say('a question in the thread', null, { root: root.id });
      const result = await post({ replyToMessageId: String(inside.id), kind: 'answer' });
      expect(await row(result)).toEqual({ reply_to_message_id: inside.id, thread_root_id: root.id });
      noDrop(result);
    });

    it('a reply to a mention made inside a thread', async () => {
      const root = await say('a topic');
      const asked = await say('@d141 thoughts?', null, { root: root.id });
      await wake({ ...asked, thread_root_id: root.id });
      const result = await post({ replyToMessageId: String(asked.id), kind: 'answer' });
      expect(await row(result)).toEqual({ reply_to_message_id: asked.id, thread_root_id: root.id });
      noDrop(result);
    });

    it('threadRootId alone with kind=answer, after a mention inside that thread', async () => {
      const root = await say('a topic');
      const asked = await say('@d141 thoughts?', null, { root: root.id });
      await wake({ ...asked, thread_root_id: root.id });
      const result = await post({ threadRootId: String(root.id), kind: 'answer' });
      expect(await row(result)).toEqual({ reply_to_message_id: null, thread_root_id: root.id });
      noDrop(result);
    });

    it('the conversation moved into the thread after a top-level mention: the newest wake decides', async () => {
      const asked = await say('@d141 first question');
      await wake(asked);
      const followUp = await say('@d141 and a follow-up', null, { root: asked.id });
      await wake({ ...followUp, thread_root_id: asked.id });
      const result = await post({ threadRootId: String(asked.id), kind: 'answer' });
      expect(await row(result)).toEqual({ reply_to_message_id: null, thread_root_id: asked.id });
      noDrop(result);
    });

    it('a threaded mention of a person stays threaded, and the human path is untouched', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const humanReply = await say('@asker adding context', String(asked.id));
      expect(Number(humanReply.thread_root_id)).toBe(Number(asked.id));
    });

    it('a note under a message the agent was not woken for', async () => {
      const someone = await say('shipping the release now');
      const result = await post({ replyToMessageId: String(someone.id) });
      expect(await row(result)).toEqual({ reply_to_message_id: someone.id, thread_root_id: someone.id });
      noDrop(result);
    });

    it('threadRootId alone with kind=answer and no wake: no reply edge names what it answers', async () => {
      const someone = await say('shipping the release now');
      const result = await post({ threadRootId: String(someone.id), kind: 'answer' });
      expect((await row(result)).thread_root_id).toBe(someone.id);
      noDrop(result);
    });

    it.each(['progress', 'fyi'])('a declared non-answer under the mention (kind=%s)', async (kind) => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const result = await post({ replyToMessageId: String(asked.id), kind });
      expect(await row(result)).toEqual({ reply_to_message_id: asked.id, thread_root_id: asked.id });
      noDrop(result);
    });

    it('a 1:1 DM, which the wrapper cue leaves out too', async () => {
      const dm = await makePod('agent-room');
      const asked = await say('hello', null, { inPod: dm });
      await AgentEvent.create({
        ...AGENT, podId: dm._id, type: 'chat.mention', payload: { messageId: String(asked.id), source: 'dm' },
      });
      const result = await post({ replyToMessageId: String(asked.id), kind: 'answer' }, dm);
      expect((await row(result)).thread_root_id).toBe(asked.id);
      noDrop(result);
    });

    it('a post the kernel files in a thread on purpose', async () => {
      const asked = await say('@d141 pick one');
      await wake(asked);
      const result = await post({ threadRootId: String(asked.id), threadIsDeliberate: true });
      expect((await row(result)).thread_root_id).toBe(asked.id);
      noDrop(result);
    });

    it('a kernel-authored post', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const result = await post({ threadRootId: String(asked.id), authorKind: 'kernel' });
      expect((await row(result)).thread_root_id).toBe(asked.id);
      noDrop(result);
    });

    it('a top-level message that only reached the agent as ambient chat', async () => {
      const someone = await say('shipping the release now');
      await AgentEvent.create({
        ...AGENT, podId: pod._id, type: 'message.posted', payload: { messageId: String(someone.id) },
      });
      const result = await post({ replyToMessageId: String(someone.id) });
      expect((await row(result)).thread_root_id).toBe(someone.id);
      noDrop(result);
    });

    it('a failed wake lookup leaves the post as sent', async () => {
      const asked = await say('@d141 ping');
      await wake(asked);
      const spy = jest.spyOn(AgentEvent, 'findOne').mockImplementation(() => { throw new Error('store down'); });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await post({ replyToMessageId: String(asked.id) });
        expect((await row(result)).thread_root_id).toBe(asked.id);
        noDrop(result);
      } finally {
        spy.mockRestore();
        warn.mockRestore();
      }
    });
  });

  it('CONTROL: the fixture is on a real database with the agent in the pod', async () => {
    expect(mongoose.connection.readyState).toBe(1);
    const { rows } = await pool.query('SELECT 1 AS one FROM users WHERE _id = $1', [String(agentUser._id)]);
    expect(rows).toEqual([{ one: 1 }]);
  });
});
