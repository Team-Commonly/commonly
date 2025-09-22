const controller = require('../../../controllers/pgStatusController');
const { pool } = require('../../../config/db-pg');
const User = require('../../../models/User');

jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));
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
});
