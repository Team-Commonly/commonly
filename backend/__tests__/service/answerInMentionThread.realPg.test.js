/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * D278 (2026-11-09): in a shared pod, the answer to a top-level @mention lands
 * in that message's thread, however the agent addresses it. This reversed F212
 * (#3536), which kept it in the main channel. Real Postgres and real Mongo: the
 * wake comes from the real enqueueMentions, the post from the real postMessage,
 * and each assertion reads the row back.
 */
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

// The models read `pool` from config/db-pg when they load; this holder is
// filled with the test schema's pool before they are required.
const mockDbPg = {};
jest.mock('../../config/db-pg', () => mockDbPg);

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const AGENT = { agentName: 'claude-code', instanceId: 'd278' };

real('an answer to a top-level mention lands in that message\'s thread (D278)', () => {
  let database;
  let pool;
  let PGMessage;
  let AgentMessageService;
  let AgentMentionService;
  let AgentEventService;
  let AgentIdentityService;
  let AgentEvent;
  let AgentInstallation;
  let Pod;
  let User;
  let human;
  let pod;
  let agentUser;

  const makePod = async (type = 'team') => {
    const made = await Pod.create({
      name: `room-${type}`, type, createdBy: human._id, members: [human._id, agentUser._id],
    });
    await pool.query(
      'INSERT INTO pods (id, name, type, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [String(made._id), 'room', type, String(human._id)],
    );
    await AgentInstallation.create({
      ...AGENT, podId: made._id, displayName: 'D278', version: '1.0.0', status: 'active', installedBy: human._id,
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
    AgentMentionService = require('../../services/agentMentionService');
    AgentEventService = require('../../services/agentEventService');
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
    agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT.agentName, { instanceId: AGENT.instanceId });
    await AgentIdentityService.syncUserToPostgreSQL(agentUser);
    pod = await makePod();
  });

  const say = (content, { inPod = pod } = {}) => PGMessage.create(
    String(inPod._id), String(human._id), content, 'text', null, null, null,
  );

  // Through the real producer, so the payload placement reads is the one the
  // kernel writes rather than a copy of it.
  const wake = async (message, inPod = pod) => {
    await AgentMentionService.enqueueMentions({
      podId: inPod._id,
      message: { ...message, _id: message.id, content: message.content },
      userId: human._id,
      username: human.username,
    });
    const events = await AgentEvent.find({ agentName: AGENT.agentName, instanceId: AGENT.instanceId }).lean();
    const event = events.find((row) => String(row.payload?.messageId) === String(message.id));
    expect(event).toBeDefined();
    return event;
  };

  // The fetch that hands a turn its events: pending becomes delivered.
  const deliver = (inPod = pod) => AgentEventService.list({ ...AGENT, podIds: [inPod._id], limit: 50 });

  const post = (fields, inPod = pod) => AgentMessageService.postMessage({
    ...AGENT, podId: inPod._id, content: `reply ${Math.random()}`, ...fields,
  });

  const row = async (result) => {
    const { rows } = await pool.query(
      'SELECT reply_to_message_id, thread_root_id, top_level_answer FROM messages WHERE id = $1::int',
      [result.message.id],
    );
    return rows[0];
  };

  const noF212 = (result) => expect((result.warnings || []).map((w) => w.code)).not.toContain('thread_root_dropped');

  it('THE REPRO: replyToMessageId + kind=answer on a top-level mention files the answer in its thread, quote kept', async () => {
    const asked = await say('@d278 name one ocean, one word');
    await wake(asked);

    const result = await post({ replyToMessageId: String(asked.id), kind: 'answer', content: 'Pacific' });

    expect(await row(result)).toEqual({ reply_to_message_id: asked.id, thread_root_id: asked.id, top_level_answer: null });
    expect(result.message.thread_root_id).toBe(asked.id);
    expect(result.message.replyTo).toMatchObject({ id: String(asked.id) });
    noF212(result);
  });

  it('threadRootId alone files it there, and no reply edge is invented', async () => {
    const asked = await say('@d278 ping');
    await wake(asked);
    const result = await post({ threadRootId: String(asked.id), kind: 'answer' });
    expect(await row(result)).toEqual({ reply_to_message_id: null, thread_root_id: asked.id, top_level_answer: null });
    noF212(result);
  });

  it('a plain CAP post from a turn holding only that mention lands in its thread', async () => {
    const asked = await say('@d278 one line on what you are working on, please.');
    await wake(asked);
    await deliver();

    const result = await post({ inferAnswerThread: true, content: 'Reviewing the queue.' });

    expect(await row(result)).toEqual({ reply_to_message_id: null, thread_root_id: asked.id, top_level_answer: null });
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'thread_root_from_wake' })]);
  });

  it('the kernel tells the agent so in the wake itself', async () => {
    const asked = await say('@d278 ping');
    const event = await wake(asked);
    expect(event.payload.content).toContain(
      `[This message is top-level in the channel. Answer it in its thread: send threadRootId ${asked.id}`,
    );
  });

  it('mainChannel (the CAP route clears the flag) keeps a separate topic in the channel', async () => {
    const asked = await say('@d278 ping');
    await wake(asked);
    await deliver();
    const result = await post({ inferAnswerThread: false });
    expect((await row(result)).thread_root_id).toBeNull();
  });

  it('a 1:1 agent room keeps a plain post plain', async () => {
    const room = await makePod('agent-room');
    const asked = await say('hello', { inPod: room });
    await AgentEvent.create({
      ...AGENT, podId: room._id, type: 'chat.mention', status: 'delivered', deliveredAt: new Date(),
      payload: { messageId: String(asked.id), source: 'dm' },
    });
    const result = await post({ inferAnswerThread: true }, room);
    expect((await row(result)).thread_root_id).toBeNull();
  });
});
