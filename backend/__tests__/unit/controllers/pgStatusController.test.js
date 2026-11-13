const controller = require('../../../controllers/pgStatusController');
const { pool } = require('../../../config/db-pg');
const User = require('../../../models/User');

jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn().mockResolvedValue({ rowCount: 1 }) } }));
jest.mock('../../../models/User');
jest.mock('../../../services/accountDeletionState', () => ({ isAccountDeleting: jest.fn().mockResolvedValue(false) }));

const { isAccountDeleting } = require('../../../services/accountDeletionState');

describe('pgStatusController', () => {
  afterEach(() => jest.clearAllMocks());

  it('checkStatus responds with available true', async () => {
    const req = {};
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await controller.checkStatus(req, res);
    expect(res.json).toHaveBeenCalledWith({ available: true });
  });

  it('syncUser returns 404 if user missing', async () => {
    User.findById.mockResolvedValue(null);
    const req = { userId: 'u1' };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
    };
    await controller.syncUser(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  // Every signed-in page load calls syncUser (frontend SocketContext), and chat
  // reads each author's name from Postgres users.username. Writing the handle
  // here put a person's handle back in chat on the load after they chose a
  // display name (10-21: 4 of the 5 people with one showed their handle).
  describe('syncUser writes the name chat shows', () => {
    const run = async (user) => {
      User.findById.mockResolvedValue({ _id: { toString: () => 'u1' }, profilePicture: null, ...user });
      pool.query.mockResolvedValue({ rows: [{ _id: 'u1' }] });
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() };
      await controller.syncUser({ userId: 'u1' }, res);
      return pool.query.mock.calls[0][1];
    };

    it('the display name a person chose, not their handle', async () => {
      expect(await run({ username: 'laruiss', displayName: 'Stan O.' })).toEqual(['u1', 'Stan O.', null]);
    });

    it('the handle when they chose none', async () => {
      expect(await run({ username: 'laruiss' })).toEqual(['u1', 'laruiss', null]);
    });

    it("an agent's display name", async () => {
      expect(await run({ username: 'scout-u123', isBot: true, botMetadata: { displayName: 'Scout' } }))
        .toEqual(['u1', 'Scout', null]);
    });
  });

  // F478: the upsert overwrites, so a page load landing after account deletion
  // anonymized the row would put the person's name back, and the row outlives
  // their Mongo user as an orphan.
  describe('syncUser during account deletion', () => {
    const sync = async () => {
      User.findById.mockResolvedValue({ _id: { toString: () => 'u1' }, username: 'laruiss', profilePicture: 'p.png' });
      pool.query.mockResolvedValue({ rows: [{ _id: 'u1' }] });
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() };
      await controller.syncUser({ userId: 'u1' }, res);
      return res;
    };

    it('anonymizes the row it just wrote when the account is being deleted', async () => {
      isAccountDeleting.mockResolvedValueOnce(true);
      const res = await sync();
      expect(isAccountDeleting).toHaveBeenCalledWith('u1');
      expect(pool.query).toHaveBeenCalledTimes(2);
      const [sql, params] = pool.query.mock.calls[1];
      expect(sql).toMatch(/UPDATE users SET username = \$2, profile_picture = NULL/);
      expect(params.slice(0, 2)).toEqual(['u1', 'Deleted user']);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('writes nothing more for a live account', async () => {
      await sync();
      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });
});
