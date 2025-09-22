const podController = require('../../../controllers/podController');
const Pod = require('../../../models/Pod');
const Message = require('../../../models/Message');

jest.mock('../../../models/Pod');
jest.mock('../../../models/Message');

describe('podController', () => {
  afterEach(() => jest.clearAllMocks());

  it('getPodsByType returns 400 for invalid type', async () => {
    const req = { params: { type: 'invalid' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.getPodsByType(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('deletePod denies delete if user is not creator', async () => {
    Pod.findById.mockResolvedValue({ createdBy: 'creator' });
    const req = { params: { id: 'p1' }, userId: 'other' };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
    };
    await podController.deletePod(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
