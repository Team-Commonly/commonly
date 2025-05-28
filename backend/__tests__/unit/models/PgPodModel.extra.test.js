jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));
const { pool } = require('../../../config/db-pg');
const Pod = require('../../../models/pg/Pod');

describe('PG Pod model', () => {
  afterEach(() => jest.clearAllMocks());

  it('create inserts pod and adds creator as member', async () => {
    jest.spyOn(Pod, 'addMember').mockResolvedValue();
    pool.query.mockResolvedValue({ rows: [{ id: 'p1' }] });
    const result = await Pod.create('n', 'd', 'chat', 'u1');
    expect(pool.query).toHaveBeenCalled();
    expect(Pod.addMember).toHaveBeenCalledWith('p1', 'u1');
    expect(result.id).toBe('p1');
  });

  it('isMember checks membership', async () => {
    pool.query.mockResolvedValue({ rows: [{ pod_id: 'p1' }] });
    const res = await Pod.isMember('p1', 'u1');
    expect(pool.query).toHaveBeenCalled();
    expect(res).toBe(true);
  });
});
