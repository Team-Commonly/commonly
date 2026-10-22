const controller = require('../../../controllers/pgStatusController');
const { pool } = require('../../../config/db-pg');
const User = require('../../../models/User');

jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn().mockResolvedValue({ rowCount: 1 }) } }));
jest.mock('../../../models/User');

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
});
