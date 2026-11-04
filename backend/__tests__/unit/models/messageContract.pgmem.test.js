// D245: the message contract's columns, through the SHIPPED model SQL on pg-mem.
// The real-Postgres twin is __tests__/service/messageContract.realPg.test.js.
const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const PGMessage = require('../../../models/pg/Message');

const POD = 'pod-1';

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
    payload JSONB,
    reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    thread_root_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`);
  await mockPool.query('CREATE TABLE pods (id VARCHAR(255) PRIMARY KEY, updated_at TIMESTAMP WITH TIME ZONE)');
  await mockPool.query(`INSERT INTO pods (id) VALUES ('${POD}')`);
  await mockPool.query("INSERT INTO users (_id, username, is_bot) VALUES ('agent-1', 'nova', true)");
});

const create = (contract) => PGMessage.create(POD, 'agent-1', 'Fixed the redirect.', 'text', null, null, null, null, null, contract);

describe('message contract columns (D245)', () => {
  it('stores summary and kind and returns them on every message read', async () => {
    const row = await create({ summary: 'Fixed it', kind: 'result' });
    expect(row).toMatchObject({ summary: 'Fixed it', kind: 'result' });

    expect(await PGMessage.findById(String(row.id))).toMatchObject({ summary: 'Fixed it', kind: 'result' });
    const page = await PGMessage.findByPodId(POD, 50);
    expect(page.find((m) => m.pgId === String(row.id))).toMatchObject({ summary: 'Fixed it', kind: 'result' });
  });

  it('writes only the field that is present', async () => {
    const row = await create({ summary: null, kind: 'fyi' });
    expect(row).toMatchObject({ summary: null, kind: 'fyi' });
  });

  it('a post without the contract stores NULL for both', async () => {
    const row = await PGMessage.create(POD, 'agent-1', 'plain', 'text');
    expect(row).toMatchObject({ summary: null, kind: null });
  });

  it('an edit clears the summary, so it never outlives the text it described', async () => {
    const row = await create({ summary: 'The old claim', kind: 'result' });
    const edited = await PGMessage.update(String(row.id), 'corrected text');
    expect(edited).toMatchObject({ content: 'corrected text', summary: null, kind: 'result' });
    expect((await PGMessage.findById(String(row.id))).summary).toBeNull();
  });
});
