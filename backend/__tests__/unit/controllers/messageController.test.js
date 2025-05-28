const messageController = require('../../../controllers/messageController');
const Pod = require('../../../models/Pod');
const Message = require('../../../models/Message');

jest.mock('../../../models/Pod');
jest.mock('../../../models/Message');

describe('messageController', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('getMessages returns 400 if podId is missing', async () => {
    const req = { params: {}, query: {}, user: { id: 'u1' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await messageController.getMessages(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('deleteMessage returns 404 when message not found', async () => {
    Message.findById.mockResolvedValue(null);
    const req = { params: { id: 'm1' }, userId: 'u1', user: { id: 'u1' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await messageController.deleteMessage(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
