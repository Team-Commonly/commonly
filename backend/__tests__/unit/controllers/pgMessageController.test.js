const controller = require('../../../controllers/pgMessageController');
const PGPod = require('../../../models/pg/Pod');
const PGMessage = require('../../../models/pg/Message');
const AgentMentionService = require('../../../services/agentMentionService');
const { AgentInstallation } = require('../../../models/AgentRegistry');

jest.mock('../../../models/pg/Pod');
jest.mock('../../../models/pg/Message');
jest.mock('../../../services/agentMentionService');
jest.mock('../../../models/AgentRegistry');

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

  it('returns mention delivery feedback for a legacy PG message post', async () => {
    const message = { id: 'm1', content: 'hello @recorder', userId: { username: 'sam' } };
    PGPod.findById.mockResolvedValue({ type: 'chat' });
    PGPod.isMember.mockResolvedValue(true);
    PGMessage.create.mockResolvedValue({ id: 'm1', content: 'hello @recorder' });
    PGMessage.findById.mockResolvedValue(message);
    AgentMentionService.isAutoRoutedDmPod.mockReturnValue(false);
    AgentMentionService.enqueueMentions.mockResolvedValue({
      enqueued: [{ installationId: 'i1' }],
      implicit: ['recorder'],
      woken: [{ installationId: 'i2' }],
    });
    AgentInstallation.countDocuments.mockResolvedValue(2);
    const req = {
      params: { podId: 'p1' },
      body: { content: 'hello @recorder' },
      userId: 'u1',
      user: { id: 'u1', username: 'sam' },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await controller.createMessage(req, res);

    expect(AgentMentionService.enqueueMentions).toHaveBeenCalledWith({
      podId: 'p1', message, userId: 'u1', username: 'sam',
    });
    expect(res.json).toHaveBeenCalledWith({
      ...message,
      agentDelivery: {
        enqueued: 1,
        implicit: ['recorder'],
        agentsInPod: 2,
        woken: 1,
      },
    });
  });
});
