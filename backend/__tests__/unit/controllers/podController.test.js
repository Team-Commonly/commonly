process.env.PG_HOST = '';
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

  it('removeMember denies removal when user is not creator', async () => {
    Pod.findById.mockResolvedValue({
      createdBy: 'creator',
      members: ['creator', 'member'],
    });
    const req = { params: { id: 'p1', memberId: 'member' }, userId: 'other' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.removeMember(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('removeMember blocks removing creator', async () => {
    Pod.findById.mockResolvedValue({
      createdBy: 'creator',
      members: ['creator'],
    });
    const req = { params: { id: 'p1', memberId: 'creator' }, userId: 'creator' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.removeMember(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('removeMember removes member and returns updated pod', async () => {
    const pod = {
      createdBy: 'creator',
      members: ['creator', 'member'],
      save: jest.fn(),
      populate: jest.fn().mockResolvedValue(),
    };
    Pod.findById.mockResolvedValue(pod);
    const req = { params: { id: 'p1', memberId: 'member' }, userId: 'creator' };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await podController.removeMember(req, res);
    expect(pod.members).toEqual(['creator']);
    expect(pod.save).toHaveBeenCalled();
    expect(pod.populate).toHaveBeenCalledWith('createdBy', 'username profilePicture');
    expect(pod.populate).toHaveBeenCalledWith('members', 'username profilePicture');
    expect(res.json).toHaveBeenCalledWith(pod);
  });
});
