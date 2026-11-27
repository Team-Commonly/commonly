/**
 * F578. A hosted agent's first-contact greeting opens with @<person> so their
 * plain answer reaches it, and that address put "Needs you: 1 waiting on
 * you" in a brand-new person's Activity. A greeting is an invitation, not an
 * ask: the first-contact run's own post opens no row for the person it
 * greets. Anyone else it names, any post from another run of the same agent,
 * and a person's own post keep their rows.
 *
 * Real Mongo (memory server) for users, pods, installations and attention
 * rows; pg-mem for the messages the shipped model SQL writes. Only the model
 * is mocked: the turn, the post, the PG write and the attention writer are
 * the shipped code.
 */
/* eslint-disable import/extensions, import/no-unresolved */
const { newDb } = require('pg-mem');

const pg = newDb();
pg.public.none(`CREATE TABLE users (
  _id VARCHAR(255) PRIMARY KEY, username VARCHAR(255), profile_picture TEXT, is_bot BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
)`);
pg.public.none('CREATE TABLE pods (id VARCHAR(255) PRIMARY KEY, name TEXT, type TEXT, created_by TEXT, updated_at TIMESTAMPTZ)');
pg.public.none(`CREATE TABLE messages (
  id SERIAL PRIMARY KEY, legacy_mongo_id VARCHAR(24), pod_id VARCHAR(255) NOT NULL, user_id VARCHAR(255) NOT NULL,
  content TEXT, message_type VARCHAR(50) DEFAULT 'text', author_kind VARCHAR(20), summary TEXT, kind VARCHAR(20),
  -- pg-mem types the model's payload parameter as text, so the column is TEXT here.
  receipt JSONB, payload TEXT, reply_to_message_id INTEGER, thread_root_id INTEGER, top_level_answer BOOLEAN,
  owner_user_id VARCHAR(24), on_behalf_of_user_id VARCHAR(24),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
)`);
pg.public.none(`CREATE TABLE message_claims (
  message_id TEXT PRIMARY KEY, pod_id TEXT NOT NULL, claimed_by TEXT NOT NULL, instance_id TEXT NOT NULL DEFAULT 'default',
  expires_at TIMESTAMPTZ NOT NULL, state TEXT NOT NULL DEFAULT 'claimed', declined_by TEXT[], created_at TIMESTAMPTZ
)`);
const { Pool } = pg.adapters.createPg();
const mockPool = new Pool();
jest.mock('../../config/db-pg', () => ({ pool: mockPool }));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../config/socket', () => {
  const room = { emit: () => undefined };
  return { getIO: () => ({ to: () => room, in: () => room, emit: () => undefined }) };
});

const mongoose = require('mongoose');
const axios = require('axios').default;
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AttentionItem = require('../../models/AttentionItem');
const { AgentInstallation } = require('../../models/AgentRegistry');
const PGMessage = require('../../models/pg/Message');
const AgentMessageService = require('../../services/agentMessageService');
const { runAgent } = require('../../services/nativeRuntimeService');

const AGENT = 'greet-agent';

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

let seq = 0;
let lee;
let quinn;
let pod;
let installation;

beforeAll(async () => {
  await setupMongoDb();
  process.env.LITELLM_BASE_URL = 'http://litellm.test';
  process.env.LITELLM_MASTER_KEY = 'test-key';
  // The post path writes Postgres only when a host is configured; pg-mem
  // stands behind the mocked pool.
  process.env.PG_HOST = 'pg-mem';
});
afterAll(async () => {
  delete process.env.PG_HOST;
  await closeMongoDb();
});

beforeEach(async () => {
  jest.clearAllMocks();
  // eslint-disable-next-line global-require
  require('../../services/cloudRuntimeOwnership').clearCloudRuntimeCache();
  seq += 1;
  lee = await User.create({
    username: `lee${seq}`, email: `lee${seq}@example.test`, password: 'not-a-real-password-1', entitlements: { cloudAgents: true },
  });
  quinn = await User.create({ username: `quinn${seq}`, email: `quinn${seq}@example.test`, password: 'not-a-real-password-1' });
  pod = await Pod.create({
    name: `Greet ${seq}`, type: 'chat', createdBy: lee._id, members: [lee._id, quinn._id],
  });
  await mockPool.query('INSERT INTO pods (id, name, type, created_by) VALUES ($1, $2, $3, $4)', [String(pod._id), pod.name, 'chat', String(lee._id)]);
  installation = await AgentInstallation.create({
    agentName: AGENT,
    instanceId: 'default',
    podId: pod._id,
    version: '1.0.0',
    installedBy: lee._id,
    status: 'active',
    displayName: 'Greet Agent',
    config: { runtime: { runtimeType: 'native' }, tools: ['commonly_post_message'], model: 'test/model' },
  });
});

const rowsFor = (user) => AttentionItem.find({ recipientUserId: user._id, kind: 'mention' }).lean();
const greet = (content) => {
  axios.post.mockResolvedValueOnce(toolCall(content)).mockResolvedValueOnce(done);
  return runAgent(installation.toObject(), {
    type: 'first_contact',
    eventId: new mongoose.Types.ObjectId().toString(),
    payload: { content: 'A person just started you in this pod.', userId: String(lee._id), kind: 'first-contact' },
  });
};
const posted = async (needle) => {
  const sql = 'SELECT id FROM messages WHERE pod_id = $1 AND content LIKE $2';
  return (await mockPool.query(sql, [String(pod._id), `%${needle}%`])).rows;
};

test("the first-contact run's greeting opens no row for the person it greets, and one for anyone else it names", async () => {
  await greet(`@${lee.username} hi! What should we start on this week? @${quinn.username} you're welcome to join in.`);

  expect(await posted('start on this week')).toHaveLength(1);
  expect(await rowsFor(lee)).toHaveLength(0);
  expect(await rowsFor(quinn)).toHaveLength(1);
});

test('a post from a different run of the same agent, at the same moment, opens the row', async () => {
  // While the greeting run is still open, another of the agent's turns (one
  // carrying no greeting) asks lee something. It is posted from inside the
  // greeting run's second model call, so the two overlap on every run.
  axios.post
    .mockResolvedValueOnce(toolCall(`@${lee.username} hi! What should we start on?`))
    .mockImplementationOnce(async () => {
      await AgentMessageService.postMessage({
        agentName: AGENT,
        instanceId: 'default',
        podId: String(pod._id),
        content: `@${lee.username} which repo should I use?`,
        messageType: 'text',
        displayName: 'Greet Agent',
        installationConfig: installation.config,
        metadata: { source: 'native-runtime' },
        runId: new mongoose.Types.ObjectId().toString(),
        runPodId: String(pod._id),
      });
      return done;
    });
  await runAgent(installation.toObject(), {
    type: 'first_contact',
    eventId: new mongoose.Types.ObjectId().toString(),
    payload: { content: 'A person just started you in this pod.', userId: String(lee._id), kind: 'first-contact' },
  });

  expect(await posted('which repo')).toHaveLength(1);
  const rows = await rowsFor(lee);
  expect(rows).toHaveLength(1);
  expect(rows[0].detail).toContain('which repo');
});

test("a person's post is unchanged", async () => {
  await PGMessage.create(String(pod._id), String(quinn._id), `@${lee.username} can you look at this?`, 'text');

  const rows = await rowsFor(lee);
  expect(rows).toHaveLength(1);
});
