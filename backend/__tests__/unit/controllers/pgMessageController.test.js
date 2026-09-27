const controller = require('../../../controllers/pgMessageController');
const PGPod = require('../../../models/pg/Pod');
const PGMessage = require('../../../models/pg/Message');
const MongoPod = require('../../../models/Pod');
const AgentMentionService = require('../../../services/agentMentionService');
const { AgentInstallation } = require('../../../models/AgentRegistry');

jest.mock('../../../models/pg/Pod');
jest.mock('../../../models/pg/Message');
jest.mock('../../../models/Pod');
jest.mock('../../../services/agentMentionService');
jest.mock('../../../models/AgentRegistry');

// Mongo membership is the decision since TASK-162, so every arm that expects a
// status other than 404 has to say what the pod's `members` holds. `null` is a
// pod Mongo does not have (the orphan-row class), not an empty member list.
const mongoPod = (members) => {
  MongoPod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(members === null ? null : { members }),
    }),
  });
};

const jsonRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

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
    mongoPod(null);
    const req = {
      params: { podId: 'p1' },
      query: {},
      userId: 'u1',
      user: { id: 'u1' },
    };
    const res = jsonRes();
    await controller.getMessages(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns mention delivery feedback for a legacy PG message post', async () => {
    const message = { id: 'm1', content: 'hello @recorder', userId: { username: 'sam' } };
    PGPod.findById.mockResolvedValue({ type: 'chat' });
    mongoPod(['u1']);
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
    const res = jsonRes();

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

  // TASK-162. The defect was a stale positive: the PG `pod_members` row was
  // checked first and concluded membership, so a row that outlived the
  // membership granted write access. A "leave then post is 401" arm cannot see
  // that — it passes while the row is absent. The arm that discriminates is the
  // SURVIVOR: the ghost row still present, Mongo membership gone.
  it('refuses a post from a member whose PG row survived their departure', async () => {
    PGPod.findById.mockResolvedValue({ type: 'chat' }); // the ghost row is there
    // No mirror reader to mock against any more: TASK-167 deleted
    // `PGPod.isMember`, so the Mongo answer below is the only one this arm can
    // turn on — which is the property, not a weakening of it.
    mongoPod([]); // Mongo is the truth, and this caller is not in it
    const req = {
      params: { podId: 'p1' },
      body: { content: 'still here?' },
      userId: 'u1',
      user: { id: 'u1', username: 'sam' },
    };
    const res = jsonRes();

    await controller.createMessage(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(PGMessage.create).not.toHaveBeenCalled();
  });

  it('refuses a read from the same stale row, so the ghost does not leak history', async () => {
    PGPod.findById.mockResolvedValue({ type: 'chat' });
    mongoPod([]);
    const req = {
      params: { podId: 'p1' },
      query: {},
      userId: 'u1',
      user: { id: 'u1' },
    };
    const res = jsonRes();

    await controller.getMessages(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(PGMessage.findByPodId).not.toHaveBeenCalled();
  });

  it('refuses a departed CREATOR whose PG row is present', async () => {
    // 36 of the 77 ghost rows are the pod's own creator (Vera 74648), which is
    // the population where the creator clause and the stale row reinforce each
    // other. `createdBy` is not membership: it says who made the pod, not who is
    // in it.
    PGPod.findById.mockResolvedValue({ type: 'chat' });
    mongoPod([]);
    MongoPod.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ createdBy: 'u1', members: [] }),
      }),
    });
    const req = {
      params: { podId: 'p1' },
      body: { content: 'hello' },
      userId: 'u1',
      user: { id: 'u1', username: 'sam' },
    };
    const res = jsonRes();

    await controller.createMessage(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(PGMessage.create).not.toHaveBeenCalled();
  });

  it('refuses a post into a pod Mongo no longer has, however old its PG row is', async () => {
    // The 140-row orphan class: the PG pod row exists, Mongo's does not, so
    // there is no membership list left to be in.
    PGPod.findById.mockResolvedValue({ type: 'chat' });
    mongoPod(null);
    const req = {
      params: { podId: 'p1' },
      body: { content: 'hello' },
      userId: 'u1',
      user: { id: 'u1', username: 'sam' },
    };
    const res = jsonRes();

    await controller.createMessage(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(PGMessage.create).not.toHaveBeenCalled();
  });

  it('admits a listed member who has no PG row at all — the lazily-synced mirror must not refuse', async () => {
    // The inverse direction, and the reason Mongo decides rather than the
    // mirror: community auto-join and other join paths write Mongo only, so an
    // absent PG row is not evidence against membership.
    PGPod.findById.mockResolvedValue({ type: 'chat' });
    PGMessage.create.mockResolvedValue({ id: 'm2', content: 'hi' });
    PGMessage.findById.mockResolvedValue({ id: 'm2', content: 'hi' });
    AgentMentionService.isAutoRoutedDmPod.mockReturnValue(false);
    AgentMentionService.enqueueMentions.mockResolvedValue({ enqueued: [], implicit: [], woken: [] });
    AgentInstallation.countDocuments.mockResolvedValue(0);
    mongoPod(['u1']);
    const req = {
      params: { podId: 'p1' },
      body: { content: 'hi' },
      userId: 'u1',
      user: { id: 'u1', username: 'sam' },
    };
    const res = jsonRes();

    await controller.createMessage(req, res);

    expect(PGMessage.create).toHaveBeenCalledWith('p1', 'u1', 'hi');
    // The mirror is warmed for the PG listing surfaces, and that write decides
    // nothing.
    expect(PGPod.addMember).toHaveBeenCalledWith('p1', 'u1');
  });

  it('admits a listed member even when the mirror write is rejected', async () => {
    PGPod.findById.mockResolvedValue({ type: 'chat' });
    mongoPod(['u1']);
    // The FK on pod_members.pod_id rejects ordinarily when the pod has no PG row
    // yet, which is a state a legitimate member can be in. Warming the mirror is
    // a cache write, so its failure must not deny the member — removing the
    // inner try/catch in isPodMemberInMongo sends this rejection to the outer
    // catch, which answers 401 to someone Mongo lists as a member.
    PGPod.addMember.mockRejectedValue(
      new Error('insert or update on table "pod_members" violates foreign key constraint "pod_members_pod_id_fkey"'),
    );
    PGMessage.findByPodId.mockResolvedValue([{ id: 'm1' }]);
    const req = {
      params: { podId: 'p1' },
      query: {},
      userId: 'u1',
      user: { id: 'u1' },
    };
    const res = jsonRes();

    await controller.getMessages(req, res);

    // The attempt happened, and its failure did not become the answer.
    expect(PGPod.addMember).toHaveBeenCalledWith('p1', 'u1');
    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith([{ id: 'm1' }]);
  });
});
