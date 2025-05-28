const controller = require('../../../controllers/pgPodController');
const PGPod = require('../../../models/pg/Pod');
const PGMessage = require('../../../models/pg/Message');

jest.mock('../../../models/pg/Pod');
jest.mock('../../../models/pg/Message');

describe('pgPodController', () => {
  afterEach(() => jest.clearAllMocks());

  it('joinPod returns 404 when pod does not exist', async () => {
    PGPod.findById.mockResolvedValue(null);
    const req = { params: { id: 'p1' }, user: { id: 'u1' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() };
    await controller.joinPod(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('updatePod rejects if not creator', async () => {
    PGPod.findById.mockResolvedValue({ created_by: 'other' });
    const req = { params: { id: 'p1' }, body: { name: 'n' }, user: { id: 'u1' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() };
    await controller.updatePod(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
