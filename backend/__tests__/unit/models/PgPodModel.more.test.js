const fs = require('fs');
const path = require('path');

jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));
const { pool } = require('../../../config/db-pg');
const Pod = require('../../../models/pg/Pod');

describe('PG Pod model additional tests', () => {
  afterEach(() => jest.clearAllMocks());

  it('addMember inserts row and updates timestamp', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ pod_id: 'p1', user_id: 'u1' }] })
      .mockResolvedValueOnce({});

    const res = await Pod.addMember('p1', 'u1');

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0][0]).toMatch(/INSERT INTO pod_members/);
    expect(pool.query.mock.calls[0][1]).toEqual(['p1', 'u1']);
    expect(pool.query.mock.calls[1][0]).toMatch(/UPDATE pods/);
    expect(pool.query.mock.calls[1][1]).toEqual(['p1']);
    expect(res).toEqual({ pod_id: 'p1', user_id: 'u1' });
  });

  it('addMember throws when query fails', async () => {
    pool.query.mockRejectedValue(new Error('db'));
    await expect(Pod.addMember('p1', 'u1')).rejects.toThrow('db');
  });

  it('update returns updated row', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'p1', name: 'n' }] });
    const res = await Pod.update('p1', 'n', 'd');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pods'),
      ['n', 'd', 'p1'],
    );
    expect(res).toEqual({ id: 'p1', name: 'n' });
  });

  it('delete returns deleted row', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'p1' }] });
    const res = await Pod.delete('p1');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM pods'),
      ['p1'],
    );
    expect(res).toEqual({ id: 'p1' });
  });

  it('findById returns pod', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'p1' }] });
    const res = await Pod.findById('p1');
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), ['p1']);
    expect(res).toEqual({ id: 'p1' });
  });

  it('findAll returns pods with type filter', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'p1' }] });
    const res = await Pod.findAll('chat');
    expect(pool.query).toHaveBeenCalled();
    expect(res).toEqual([{ id: 'p1' }]);
  });

  it('removeMember deletes member', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: '1' }] });
    const res = await Pod.removeMember('p1', 'u1');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM pod_members'),
      ['p1', 'u1'],
    );
    expect(res).toEqual({ id: '1' });
  });

  it('exposes no membership reader: the mirror decides nothing (TASK-167)', () => {
    // The claim is absence, so the instrument is the source rather than a call:
    // no execution can show that a method is gone, and an `isMember` on this
    // model is exactly the shape the next author reaches for when they want a
    // membership answer. The second assertion is the positive control — without
    // it, a typo'd pattern matches nothing against a file where the code is
    // sitting in plain sight.
    const src = fs.readFileSync(path.join(__dirname, '../../../models/pg/Pod.ts'), 'utf8');
    expect(src).not.toMatch(/static\s+async\s+isMember\b/);
    expect(src).toMatch(/static\s+async\s+addMember\b/);
  });
});
