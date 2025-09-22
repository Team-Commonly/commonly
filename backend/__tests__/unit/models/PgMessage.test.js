jest.mock('../../../config/db-pg', () => ({
  pool: {
    query: jest.fn(),
  },
}));

const { pool } = require('../../../config/db-pg');
const Message = require('../../../models/pg/Message');

describe('PG Message model', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('create inserts message and updates pod timestamp', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: '1',
            pod_id: 'p',
            user_id: 'u',
            content: 'c',
            message_type: 'text',
          },
        ],
      })
      .mockResolvedValueOnce({});
    const result = await Message.create('p', 'u', 'c', 'text');
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO messages'),
      ['p', 'u', 'c', 'text'],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE pods'),
      ['p'],
    );
    expect(result).toEqual({
      id: '1',
      pod_id: 'p',
      user_id: 'u',
      content: 'c',
      message_type: 'text',
    });
  });

  it('findByPodId formats returned rows', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          pod_id: 'p',
          user_id: 'u',
          content: 'hi',
          message_type: 'text',
          created_at: new Date(),
          username: 'name',
          profile_picture: 'pic',
        },
      ],
    });
    const res = await Message.findByPodId('p');
    expect(pool.query).toHaveBeenCalled();
    expect(res[0]).toHaveProperty('_id', '1');
    expect(res[0]).toHaveProperty('userId');
    expect(res[0]).toHaveProperty('messageType', 'text');
  });

  it('findById returns formatted message', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          pod_id: 'p',
          user_id: 'u',
          content: 'hi',
          message_type: 'text',
          created_at: new Date(),
          username: 'name',
          profile_picture: 'pic',
        },
      ],
    });
    const msg = await Message.findById('1');
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), ['1']);
    expect(msg).toHaveProperty('id', '1');
    expect(msg).toHaveProperty('messageType');
  });

  it('update runs update query', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: '1' }] });
    await Message.update('1', 'new');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE messages'),
      ['new', '1'],
    );
  });

  it('delete runs delete query', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: '1' }] });
    await Message.delete('1');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM messages'),
      ['1'],
    );
  });

  it('deleteByPodId runs delete by pod query', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await Message.deleteByPodId('p');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM messages'),
      ['p'],
    );
  });
});
