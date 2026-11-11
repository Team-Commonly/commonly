/**
 * F434: the reply join tells the wake path its parent is a system line.
 *
 * A platform system line ("sage isn't connected yet") is stored under the
 * agent it is about. In production the controller hands enqueueMentions the
 * row PGMessage.findById returns, and that row's replyTo.userId is always
 * filled for a reply, so the wake path's findById fallback never runs: the
 * only thing that stops a person's reply to the line from reaching sage as
 * "a reply to YOUR message" is replyTo.messageType. The wake tests build that
 * field by hand, so they pass whether the model selects it or not. This suite
 * runs the model's real SQL on pg-mem, the way threadRootDerivation does.
 */

const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();

jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const PGMessage = require('../../../models/pg/Message');

const POD = 'pod-1';

beforeAll(async () => {
  await mockPool.query(`CREATE TABLE users (
    _id VARCHAR(255) PRIMARY KEY,
    username VARCHAR(255),
    profile_picture TEXT,
    is_bot BOOLEAN
  )`);
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
    kind VARCHAR(50),
    receipt JSONB,
    reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    thread_root_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    top_level_answer BOOLEAN,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`);
  await mockPool.query(`CREATE TABLE pods (
    id VARCHAR(255) PRIMARY KEY, updated_at TIMESTAMP WITH TIME ZONE
  )`);
  await mockPool.query(`INSERT INTO pods (id) VALUES ('${POD}')`);
  await mockPool.query("INSERT INTO users (_id, username, is_bot) VALUES ('agent-1', 'sage', true)");
  await mockPool.query("INSERT INTO users (_id, username, is_bot) VALUES ('human-1', 'sam', false)");
});

// The line the platform writes: message_type 'system', stored under the agent.
const systemLine = async () => {
  const { rows } = await mockPool.query(
    `INSERT INTO messages (pod_id, user_id, content, message_type)
     VALUES ('${POD}', 'agent-1', 'sage isn''t connected yet', 'system') RETURNING id`,
  );
  return rows[0].id;
};

describe('a reply carries its parent\'s message_type (F434)', () => {
  test('findById: a person\'s reply to a system line says the parent is system', async () => {
    const parentId = await systemLine();
    const reply = await PGMessage.create(POD, 'human-1', 'why?', 'text', parentId);
    const row = await PGMessage.findById(String(reply.id));
    expect(row.replyTo).toMatchObject({ userId: 'agent-1', messageType: 'system' });
  });

  test('findById: a reply to the agent\'s own post says text, so the wake still counts it', async () => {
    const own = await PGMessage.create(POD, 'agent-1', 'here is the plan', 'text');
    const reply = await PGMessage.create(POD, 'human-1', 'why?', 'text', own.id);
    const row = await PGMessage.findById(String(reply.id));
    expect(row.replyTo).toMatchObject({ userId: 'agent-1', messageType: 'text' });
  });

  test('findByPodId: the same reply read from the pod says the parent is system', async () => {
    const parentId = await systemLine();
    const reply = await PGMessage.create(POD, 'human-1', 'still?', 'text', parentId);
    const rows = await PGMessage.findByPodId(POD, 50);
    const read = rows.find((m) => String(m.id) === String(reply.id));
    expect(read.replyTo).toMatchObject({ messageType: 'system' });
  });
});
