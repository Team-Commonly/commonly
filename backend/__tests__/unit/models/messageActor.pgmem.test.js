// F655: an agent's message records whose agent it is and the person it
// answered (migration 0030), through the SHIPPED model SQL on pg-mem. The ids
// are written by the server and never leave it: no model read or write hands
// them back, so no serializer built on the model can send them.
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const PGMessage = require('../../../models/pg/Message');

const POD = 'pod-1';
const OWNER = '64b000000000000000000001';
const ASKER = '64b000000000000000000002';
const MIGRATION = fs.readFileSync(path.join(__dirname, '../../../config/migrations/0030_message_actor.sql'), 'utf8');
const ACTOR_COLUMNS = ['owner_user_id', 'on_behalf_of_user_id'];

const expectNoActor = (value) => {
  ACTOR_COLUMNS.forEach((column) => expect(value).not.toHaveProperty(column));
  const text = JSON.stringify(value);
  expect(text).not.toContain(OWNER);
  expect(text).not.toContain(ASKER);
};

beforeAll(async () => {
  await mockPool.query(`CREATE TABLE users (
    _id VARCHAR(255) PRIMARY KEY, username VARCHAR(255), profile_picture TEXT, is_bot BOOLEAN
  )`);
  await mockPool.query(`CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    legacy_mongo_id VARCHAR(24),
    pod_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    content TEXT,
    message_type VARCHAR(50) DEFAULT 'text',
    author_kind VARCHAR(20),
    summary TEXT,
    kind VARCHAR(20),
    receipt JSONB,
    payload JSONB,
    top_level_answer BOOLEAN,
    reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    thread_root_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`);
  // The shipped migration, so its SQL is what this suite runs on.
  await mockPool.query(MIGRATION);
  await mockPool.query('CREATE TABLE pods (id VARCHAR(255) PRIMARY KEY, updated_at TIMESTAMP WITH TIME ZONE)');
  await mockPool.query(`INSERT INTO pods (id) VALUES ('${POD}')`);
  await mockPool.query("INSERT INTO users (_id, username, is_bot) VALUES ('agent-1', 'nova', true)");
  await mockPool.query(`INSERT INTO users (_id, username, is_bot) VALUES ('${ASKER}', 'sam', false)`);
});

const stored = async (id) => (await mockPool.query(
  'SELECT owner_user_id, on_behalf_of_user_id FROM messages WHERE id = $1', [Number(id)],
)).rows[0];

const createWithActor = (actor, extra = {}) => PGMessage.create(
  POD, 'agent-1', extra.content || 'Done: the redirect is fixed.', 'text', null, null, null, null, null, null,
  false, null, actor,
);

describe('message actor columns', () => {
  it('stores the owner and the person answered, and the write hands neither back', async () => {
    const row = await createWithActor({ ownerUserId: OWNER, onBehalfOfUserId: ASKER });
    expect(await stored(row.id)).toEqual({ owner_user_id: OWNER, on_behalf_of_user_id: ASKER });
    expectNoActor(row);
  });

  it('a pod read and a single read never return the columns', async () => {
    const row = await createWithActor({ ownerUserId: OWNER, onBehalfOfUserId: ASKER });
    expectNoActor(await PGMessage.findById(String(row.id)));
    const page = await PGMessage.findByPodId(POD, 50);
    expect(page.length).toBeGreaterThan(0);
    page.forEach(expectNoActor);
  });

  it('edits, payload updates and deletes never return the columns', async () => {
    const row = await createWithActor({ ownerUserId: OWNER, onBehalfOfUserId: ASKER });
    expectNoActor(await PGMessage.update(String(row.id), 'corrected'));
    expectNoActor(await PGMessage.updatePayload(String(row.id), { kind: 'note' }));
    expect(await stored(row.id)).toEqual({ owner_user_id: OWNER, on_behalf_of_user_id: ASKER });
    expectNoActor(await PGMessage.delete(String(row.id)));
  });

  it('stores only the owner when no person asked (a heartbeat, an agent-to-agent turn)', async () => {
    const row = await createWithActor({ ownerUserId: OWNER });
    expect(await stored(row.id)).toEqual({ owner_user_id: OWNER, on_behalf_of_user_id: null });
  });

  it('a post with no actor (a person posting, an older caller) stores NULL for both', async () => {
    const row = await PGMessage.create(POD, 'agent-1', 'plain', 'text');
    expect(await stored(row.id)).toEqual({ owner_user_id: null, on_behalf_of_user_id: null });
  });

  it('refuses an actor id that is not a user id rather than storing it', async () => {
    const row = await createWithActor({ ownerUserId: 'Lily Shen', onBehalfOfUserId: '' });
    expect(await stored(row.id)).toEqual({ owner_user_id: null, on_behalf_of_user_id: null });
  });

  it('names the author and pod of a message for the actor lookup', async () => {
    const asked = await PGMessage.create(POD, ASKER, 'can you fix the redirect?', 'text');
    expect(await PGMessage.findAuthor(String(asked.id))).toEqual({ userId: ASKER, podId: POD });
    expect(await PGMessage.findAuthor('999999')).toBeNull();
    expect(await PGMessage.findAuthor('not-a-number')).toBeNull();
  });
});
