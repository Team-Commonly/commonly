const {
  setupPgDb,
  clearPgDb,
  closePgDb,
} = require('../../utils/testUtils');

let pgPool;
let Message;

jest.mock('../../../config/db-pg', () => ({
  get pool() {
    return pgPool;
  },
}));

beforeAll(async () => {
  pgPool = await setupPgDb();
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      _id VARCHAR(24) PRIMARY KEY,
      username VARCHAR(100) NOT NULL,
      profile_picture TEXT
    )
  `);
  Message = require('../../../models/pg/Message');
});

afterAll(async () => {
  await closePgDb();
});

afterEach(async () => {
  await clearPgDb();
  await pgPool.query('DELETE FROM users');
});

describe('PostgreSQL Message Model', () => {
  it('creates and retrieves a message', async () => {
    const userId = 'user123';
    await pgPool.query(
      'INSERT INTO users (_id, username) VALUES ($1, $2)',
      [userId, 'testuser'],
    );
    const podId = 'pod123';
    await pgPool.query(
      'INSERT INTO pods (id, name, type, created_by) VALUES ($1, $2, $3, $4)',
      [podId, 'Test Pod', 'chat', userId],
    );

    const created = await Message.create(podId, userId, 'hello world');
    expect(created.content).toBe('hello world');
    expect(created.pod_id).toBe(podId);

    const found = await Message.findById(created.id);
    expect(found.text).toBe('hello world');
    expect(found.userId.username).toBe('testuser');

    const list = await Message.findByPodId(podId, 10);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
  });

  it('updates and deletes a message', async () => {
    const userId = 'userA';
    await pgPool.query(
      'INSERT INTO users (_id, username) VALUES ($1, $2)',
      [userId, 'tester'],
    );
    const podId = 'podA';
    await pgPool.query(
      'INSERT INTO pods (id, name, type, created_by) VALUES ($1, $2, $3, $4)',
      [podId, 'Another Pod', 'chat', userId],
    );

    const msg = await Message.create(podId, userId, 'first');

    const updated = await Message.update(msg.id, 'updated');
    expect(updated.content).toBe('updated');

    const removed = await Message.delete(msg.id);
    expect(removed.id).toBe(msg.id);

    const afterDelete = await Message.findById(msg.id);
    expect(afterDelete).toBeNull();
  });
});
