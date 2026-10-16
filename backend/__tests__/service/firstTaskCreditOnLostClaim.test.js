/**
 * TASK-002 credit when the addressed agent LOSES the claim — executed against
 * real PostgreSQL + MongoDB (Tier 1).
 *
 * The two halves shipped separately and are unit-tested separately:
 *  - #2273: a native turn passes `answeringMessageId` (the trigger's own
 *    messageId) on every post it makes, whether or not it won the claim;
 *  - #2274: `postMessage` hands it to `completeFirstTaskOnAnswer` and to the
 *    attention writer, and `humansAnsweredBy` counts its author when the
 *    message is in the same pod.
 *
 * Neither unit suite can show the join. On production the case is a race:
 * Scout's wake and the addressed agent's mention are queued about 150 ms apart
 * and either can claim first (2 of 5 measured first asks, 2026-10-16), so it
 * cannot be produced on demand. Here Scout holds the claim as a FIXTURE: a
 * row written before the turn, not an agent acting.
 *
 * Only the model is mocked. The turn, the post, the PG write, the answer
 * rule, the starter-task update and the attention writer are the shipped code.
 */

/* eslint-disable import/extensions, import/no-unresolved -- backend TypeScript
   modules are required by path, as in the other tier-1 suites. */

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
// Typing indicators and live updates need a socket server; nothing here reads them.
jest.mock('../../config/socket', () => {
  const room = { emit: () => undefined };
  return { getIO: () => ({ to: () => room, in: () => room, emit: () => undefined }) };
});

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const axios = require('axios').default;

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const { pool } = require('../../config/db-pg');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const AttentionItem = require('../../models/AttentionItem');
const { AgentInstallation } = require('../../models/AgentRegistry');
const PGMessage = require('../../models/pg/Message');
const MessageClaimService = require('../../services/messageClaimService');
const AgentMessageService = require('../../services/agentMessageService');
const { FIRST_TASK_SOURCE_REF } = require('../../services/starterTaskService');
const { runAgent } = require('../../services/nativeRuntimeService');

const RUN = process.env.INTEGRATION_TEST === 'true';
const d = RUN ? describe : describe.skip;

const AGENT = 'join-agent';

const toolCall = (content) => ({
  status: 200,
  headers: {},
  data: {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'commonly_post_message', arguments: JSON.stringify({ content }) } }],
      },
    }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  },
});
const done = {
  status: 200,
  headers: {},
  data: { choices: [{ message: { role: 'assistant', content: 'NO_REPLY' } }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
};

// completeFirstTaskOnAnswer is fire-and-forget after the post returns.
const settled = async (read, accept, ms = 4000) => {
  const until = Date.now() + ms;
  let value = await read();
  while (!accept(value) && Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    // eslint-disable-next-line no-await-in-loop
    value = await read();
  }
  return value;
};

d('TASK-002 credit when the addressed agent lost the claim (real PG + Mongo)', () => {
  let owner;
  let pod;
  let installation;
  let seq = 0;

  beforeAll(async () => {
    await setupMongoDb();
    await pool.query(fs.readFileSync(path.join(__dirname, '../../config/schema.sql'), 'utf8'));
    process.env.LITELLM_BASE_URL = 'http://litellm.test';
    process.env.LITELLM_MASTER_KEY = 'test-key';
  });

  afterAll(async () => {
    await pool.query('DELETE FROM message_claims').catch(() => undefined);
    await pool.end();
    await closeMongoDb();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    seq += 1;
    owner = await User.create({
      username: `owner${seq}x`, email: `owner${seq}x@example.test`, password: 'not-a-real-password-1', isBot: false,
    });
    pod = await Pod.create({
      name: `Join ${seq}`, type: 'chat', createdBy: owner._id, members: [owner._id], 
    });
    await pool.query('INSERT INTO users (_id, username) VALUES ($1, $2) ON CONFLICT (_id) DO NOTHING', [String(owner._id), owner.username]);
    await pool.query(
      'INSERT INTO pods (id, name, type, created_by) VALUES ($1, $2, \'chat\', $3) ON CONFLICT (id) DO NOTHING',
      [String(pod._id), pod.name, String(owner._id)],
    );
    installation = await AgentInstallation.create({
      agentName: AGENT,
      instanceId: 'default',
      podId: pod._id,
      version: '1.0.0',
      installedBy: owner._id,
      status: 'active',
      displayName: 'Join Agent',
      config: { runtime: { runtimeType: 'native' }, tools: ['commonly_post_message'], model: 'test/model' },
    });
    await Task.create({
      podId: pod._id, taskNum: 2, taskId: 'TASK-002', title: 'Give your agent its first task', status: 'pending', sourceRef: FIRST_TASK_SOURCE_REF,
    });
  });

  const ownerAsks = async () => PGMessage.create(String(pod._id), String(owner._id), `@${AGENT} what is this pod for?`, 'text');
  const holdAsScout = async (messageId) => {
    const held = await MessageClaimService.claim({
      messageId: String(messageId), podId: String(pod._id), agentName: 'scout', instanceId: `u-scout-${seq}`,
    });
    expect(held.claimed).toBe(true);
  };
  const firstTask = () => Task.findOne({ podId: pod._id, sourceRef: FIRST_TASK_SOURCE_REF }).lean();
  const ownerRows = () => AttentionItem.find({ recipientUserId: owner._id, kind: 'mention' }).lean();

  test('beaten to the claim by Scout, the agent\'s answer completes TASK-002 and opens no needs-you row', async () => {
    const ask = await ownerAsks();
    await holdAsScout(ask.id);
    // The answer names the owner, so the attention writer has a row to open
    // unless the answer rule says this post answers them.
    axios.post.mockResolvedValueOnce(toolCall(`@${owner.username} This pod is for planning the launch.`)).mockResolvedValueOnce(done);

    await runAgent(installation.toObject(), {
      type: 'chat.mention',
      eventId: new mongoose.Types.ObjectId().toString(),
      payload: { messageId: String(ask.id), userId: String(owner._id), content: `@${AGENT} what is this pod for?` },
    });

    const posted = await pool.query('SELECT id FROM messages WHERE pod_id = $1 AND content LIKE $2', [String(pod._id), '%planning the launch%']);
    expect(posted.rows).toHaveLength(1);
    // Still held by Scout: the agent ran unclaimed, which is the case under test.
    const claim = await pool.query('SELECT claimed_by FROM message_claims WHERE message_id = $1', [String(ask.id)]);
    expect(claim.rows[0]?.claimed_by).toBe('scout');

    const task = await settled(firstTask, (t) => t?.status === 'done');
    expect(task.status).toBe('done');
    expect(task.updates.at(-1).text).toMatch(/answered your first request/);
    expect(await ownerRows()).toHaveLength(0);
  });

  test('CONTROL: the same unclaimed answer without the answering id leaves TASK-002 open and opens the row', async () => {
    const ask = await ownerAsks();
    await holdAsScout(ask.id);

    // What the turn sent before #2273: no claim held, no reply edge, no id.
    await AgentMessageService.postMessage({
      agentName: AGENT,
      instanceId: 'default',
      podId: String(pod._id),
      content: `@${owner.username} This pod is for planning the launch.`,
      messageType: 'text',
      displayName: 'Join Agent',
      installationConfig: installation.config,
      metadata: { source: 'native-runtime' },
    });

    const rows = await settled(ownerRows, (r) => r.length > 0);
    expect(rows).toHaveLength(1);
    // Give the fire-and-forget completion the same time it gets above.
    const task = await settled(firstTask, (t) => t?.status === 'done', 2000);
    expect(task.status).toBe('pending');
  });
});
