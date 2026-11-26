/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * F644: a decision card a person must answer is never hidden inside a
 * collapsed thread. On prod (11-26) a card raised from a turn answering a
 * thread landed in that thread; the v2 pod collapses threads after a reload,
 * so the pod showed no option buttons. The card is now always top-level,
 * while a plain post from the same turn still lands in the thread (F245).
 *
 * Real pod chat, the real wake (enqueueMentions), the real claim, the real
 * postMessage and the real requestDecision / chooseDecision. The assertions
 * read stored thread_root_id and the SQL reply-root derivation, so the store
 * is the tier's: real Postgres on the migrated schema (a private schema via
 * realPgSchema) at Tier 1, pg-mem at Tier 0. Mongo is the tier's through
 * testUtils either way.
 */
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const REAL_PG = process.env.INTEGRATION_TEST === 'true';

// The models read `pool` from config/db-pg when they load; this holder is
// filled with the tier's pool before they are required.
const mockDbPg = {};
jest.mock('../../config/db-pg', () => mockDbPg);
// Plain functions, not jest.fn(): the config's restoreMocks resets mocks before each test.
jest.mock('../../services/attentionItemService', () => ({
  recordDecision: async () => undefined,
  resolve: async () => undefined,
}));
jest.mock('../../services/messageAgentDeliveryService', () => ({
  deliverMessageToAgents: async () => ({}),
}));
jest.mock('../../config/socket', () => ({ getIO: () => null }));

// Tier 0: the slice of the schema these paths touch, by hand.
const createPgMemPool = async () => {
  // eslint-disable-next-line global-require
  const { newDb } = require('pg-mem');
  const pool = new (newDb().adapters.createPg().Pool)();
  await pool.query(`CREATE TABLE users (
    _id VARCHAR(255) PRIMARY KEY, username VARCHAR(255), profile_picture TEXT, is_bot BOOLEAN
  )`);
  await pool.query(`CREATE TABLE pods (
    id VARCHAR(255) PRIMARY KEY, name VARCHAR(100), type VARCHAR(50), created_by VARCHAR(255),
    updated_at TIMESTAMP WITH TIME ZONE
  )`);
  await pool.query(`CREATE TABLE messages (
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
  return { pool, close: async () => undefined };
};

const createTierPg = async () => {
  if (!REAL_PG) return createPgMemPool();
  /* eslint-disable global-require */
  const { createRealPgSchema } = require('../utils/realPgSchema');
  const { runPgMigrations } = require('../../config/run-pg-migrations');
  /* eslint-enable global-require */
  const database = await createRealPgSchema();
  await runPgMigrations(database.pool);
  return database;
};

const AGENT = { agentName: 'claude-code', instanceId: 'demo' };

describe('a decision card raised from a turn answering a thread is top-level (F644)', () => {
  const pgHost = process.env.PG_HOST;
  let database;
  let pool;
  let PGMessage;
  let PGPod;
  let AgentMessageService;
  let AgentMentionService;
  let AgentEventService;
  let AgentIdentityService;
  let AgentInstallation;
  let Pod;
  let User;
  let requestDecision;
  let chooseDecision;
  let human;
  let pod;
  let agentUser;

  beforeAll(async () => {
    if (!REAL_PG) process.env.PG_HOST = 'pg-mem';
    await setupMongoDb();
    database = await createTierPg();
    pool = database.pool;
    mockDbPg.pool = pool;
    /* eslint-disable global-require -- loaded after the pool holder is filled */
    PGMessage = require('../../models/pg/Message');
    PGPod = require('../../models/pg/Pod');
    AgentMessageService = require('../../services/agentMessageService');
    AgentMentionService = require('../../services/agentMentionService');
    AgentEventService = require('../../services/agentEventService');
    AgentIdentityService = require('../../services/agentIdentityService');
    ({ AgentInstallation } = require('../../models/AgentRegistry'));
    Pod = require('../../models/Pod');
    User = require('../../models/User');
    ({ requestDecision, chooseDecision } = require('../../services/decisionRequestService'));
    /* eslint-enable global-require */
  });
  afterAll(async () => {
    if (pgHost === undefined) delete process.env.PG_HOST; else process.env.PG_HOST = pgHost;
    jest.restoreAllMocks();
    if (database) await database.close();
    await closeMongoDb();
  });
  beforeEach(async () => {
    // In beforeEach because the config's restoreMocks undoes spies before each test.
    jest.spyOn(AgentIdentityService, 'syncUserToPostgreSQL').mockResolvedValue(undefined);
    // The pg-mem schema has no pod_members; requestDecision only asks that the
    // pod exists. Real Postgres answers with the real query.
    if (!REAL_PG) jest.spyOn(PGPod, 'findById').mockImplementation(async (id) => ({ id }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await clearMongoDb();
    if (REAL_PG) {
      await pool.query('TRUNCATE TABLE messages, pod_members, pods, users RESTART IDENTITY CASCADE');
    } else {
      await pool.query('DELETE FROM messages');
      await pool.query('DELETE FROM users');
      await pool.query('DELETE FROM pods');
    }
    human = await User.create({ username: 'asker', email: 'asker@example.test', password: 'x'.repeat(12) });
    await pool.query(
      'INSERT INTO users (_id, username, is_bot) VALUES ($1, $2, false)', [String(human._id), 'asker'],
    );
    agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT.agentName, { instanceId: AGENT.instanceId });
    await pool.query(
      'INSERT INTO users (_id, username, is_bot) VALUES ($1, $2, true)', [String(agentUser._id), agentUser.username],
    );
    pod = await Pod.create({
      name: 'demo', type: 'team', createdBy: human._id, members: [human._id, agentUser._id],
    });
    await pool.query(
      'INSERT INTO pods (id, name, type, created_by) VALUES ($1, $2, $3, $4)',
      [String(pod._id), 'demo', 'team', String(human._id)],
    );
    await AgentInstallation.create({
      ...AGENT, podId: pod._id, displayName: 'Claude Code', version: '1.0.0', status: 'active', installedBy: human._id,
    });
  });

  const say = (content, root = null) => PGMessage.create(
    String(pod._id), String(human._id), content, 'text', null, null, root,
  );

  // The take-2 shape: a person asks the agent inside a thread, and the turn
  // that answers it holds that wake.
  const turnAnsweringAThread = async () => {
    const root = await say('should we ship the demo today?');
    const asked = await say('@demo what do you think?', root.id);
    await AgentMentionService.enqueueMentions({
      podId: pod._id,
      message: { ...asked, _id: asked.id, content: asked.content },
      userId: human._id,
      username: human.username,
    });
    const events = await AgentEventService.list({ ...AGENT, podIds: [pod._id], limit: 50 });
    expect(events.length).toBeGreaterThan(0);
    return root;
  };

  const raise = (fields = {}) => requestDecision({
    ...AGENT,
    podId: String(pod._id),
    agentUserId: String(agentUser._id),
    displayName: 'Claude Code',
    decisionClass: 'strategy',
    title: 'Ship the demo?',
    question: '@asker which way?',
    options: [{ label: 'Ship today', recommended: true }, { label: 'Wait a day' }],
    ...fields,
  });

  const rootOf = async (messageId) => {
    const { rows } = await pool.query('SELECT thread_root_id FROM messages WHERE id = $1', [Number(messageId)]);
    return rows[0].thread_root_id;
  };

  it('THE REPRO: the agent names the thread, and the card still posts top-level', async () => {
    const root = await turnAnsweringAThread();

    const result = await raise({ threadRootId: String(root.id) });

    expect(await rootOf(result.messageId)).toBeNull();
    expect(result.threadRootId).toBe(result.messageId);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'decision_card_top_level' })]);
  });

  it.each(['not-a-message', '0', '-5', '12abc'])(
    'a threadRootId that is not a positive message id (%s) is refused and nothing is stored',
    async (threadRootId) => {
      await turnAnsweringAThread();
      const { rows: [before] } = await pool.query('SELECT COUNT(*)::int AS n FROM messages');

      await expect(raise({ threadRootId })).rejects.toMatchObject({ status: 400, code: 'thread_root_invalid' });

      const { rows: [after] } = await pool.query('SELECT COUNT(*)::int AS n FROM messages');
      expect(after.n).toBe(before.n);
    },
  );

  it('a card with no thread fields from the same turn is top-level, not filed by the F245 inference', async () => {
    await turnAnsweringAThread();
    const result = await raise();
    expect(await rootOf(result.messageId)).toBeNull();
    expect(result.warnings).toBeUndefined();
  });

  it('a plain reply from the same turn still lands in the thread (F245 unchanged)', async () => {
    const root = await turnAnsweringAThread();
    await raise({ threadRootId: String(root.id) });

    const reply = await AgentMessageService.postMessage({
      ...AGENT, podId: pod._id, content: 'Shipping is fine, I raised a card.', inferAnswerThread: true,
    });

    expect(await rootOf(reply.message.id)).toBe(root.id);
    expect(reply.warnings).toEqual([expect.objectContaining({ code: 'thread_root_from_wake' })]);
  });

  it('the ruling threads under the top-level card, and the wake names the card as its thread', async () => {
    const root = await turnAnsweringAThread();
    const card = await raise({ threadRootId: String(root.id) });

    const ruled = await chooseDecision({
      decisionId: card.decisionId, callerUserId: String(human._id), value: 'Ship today',
    });

    expect(ruled.status).toBe(200);
    const rulingId = ruled.body.decision.ruling.messageId;
    const { rows } = await pool.query(
      'SELECT reply_to_message_id, thread_root_id FROM messages WHERE id = $1', [Number(rulingId)],
    );
    expect(rows[0].reply_to_message_id).toBe(Number(card.messageId));
    expect(rows[0].thread_root_id).not.toBe(root.id);
    const events = await AgentEventService.list({ ...AGENT, podIds: [pod._id], limit: 50 });
    const wake = events.find((event) => event.type === 'decision.ruled');
    expect(wake.payload.threadRootId).toBe(card.messageId);
  });
});
