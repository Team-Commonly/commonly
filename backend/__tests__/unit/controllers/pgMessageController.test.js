const controller = require('../../../controllers/pgMessageController');
const PGPod = require('../../../models/pg/Pod');
const PGMessage = require('../../../models/pg/Message');

jest.mock('../../../models/pg/Pod');
jest.mock('../../../models/pg/Message');

describe('pgMessageController', () => {
  afterEach(() => jest.clearAllMocks());

  it('createMessage returns 400 if podId missing', async () => {
    const req = { params: {}, body: { content: 'hi' }, userId: 'u1' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.createMessage(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('getMessages returns 404 if pod not found', async () => {
    PGPod.findById.mockResolvedValue(null);
    const req = {
      params: { podId: 'p1' },
      query: {},
      userId: 'u1',
      user: { id: 'u1' },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.getMessages(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
