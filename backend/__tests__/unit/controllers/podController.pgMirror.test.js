// F183: joinPod and leavePod wrote Mongo only, so PG `pod_members` drifted
// (623 missing memberships and 23 ghosts on 2026-11-05). Each now follows its
// Mongo write with a best-effort mirror write that never fails the request.
process.env.PG_HOST = '';
const mongoose = require('mongoose');
const podController = require('../../../controllers/podController');
const { DEFAULT_LISTING_HIDDEN_POD_TYPES } = require('../../../services/podListing');
const Pod = require('../../../models/Pod');
const Message = require('../../../models/Message');
const Post = require('../../../models/Post');
const Summary = require('../../../models/Summary');
const PodAsset = require('../../../models/PodAsset');
const Integration = require('../../../models/Integration');
const { AgentRegistry, AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const AgentIdentityService = require('../../../services/agentIdentityService');
const User = require('../../../models/User');

jest.mock('../../../models/Pod');
jest.mock('../../../models/Message');
jest.mock('../../../models/Post', () => ({ deleteMany: jest.fn() }));
jest.mock('../../../models/Summary', () => ({ deleteMany: jest.fn() }));
jest.mock('../../../models/PodAsset', () => ({ deleteMany: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ deleteMany: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    findOne: jest.fn(),
    create: jest.fn(),
    incrementInstalls: jest.fn(),
  },
  AgentInstallation: {
    isInstalled: jest.fn(),
    install: jest.fn(),
    deleteMany: jest.fn(),
    // deletePodCascade reads the pod's agents before deleting them.
    find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
    updateMany: jest.fn(),
  },
}));
jest.mock('../../../models/AgentProfile', () => ({
  updateOne: jest.fn(),
  deleteMany: jest.fn(),
}));
jest.mock('../../../services/dmService', () => ({
  __esModule: true,
  default: { canViewPod: jest.fn() },
}));
jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(),
  getOrCreateAgentUser: jest.fn(),
  ensureAgentInPod: jest.fn(),
  // joinPod does `require('../services/agentIdentityService').DM_POD_TYPES_GUARD`
  // at runtime to enforce ADR-001 §3.10 (no third-party joins on DM pods).
  // Mirror the production set so the test exercises the real guard.
  DM_POD_TYPES_GUARD: new Set(['agent-room', 'agent-dm']),
}));
jest.mock('../../../services/pgMirrorWrite', () => ({
  mirrorMemberAdded: jest.fn().mockResolvedValue(true),
  mirrorMemberRemoved: jest.fn().mockResolvedValue(true),
  mirrorPodRenamed: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../../services/outsiderGrantAgentJoinPolicy', () => ({
  assertInstalledAgentMayJoinPod: jest.fn(),
}));
const { mirrorMemberAdded, mirrorMemberRemoved } = require('../../../services/pgMirrorWrite');

describe('podController PG mirror writes (F183)', () => {
  const CREATOR_ID = new mongoose.Types.ObjectId();
  const MEMBER_ID = new mongoose.Types.ObjectId();
  const hydratedPod = (members) => {
    const RealPod = jest.requireActual('../../../models/Pod');
    const doc = new RealPod({ _id: new mongoose.Types.ObjectId(), name: 'Pod', type: 'chat', createdBy: CREATOR_ID, members });
    doc.save = jest.fn().mockResolvedValue(doc);
    doc.populate = jest.fn().mockResolvedValue(doc);
    return doc;
  };
  const openPod = (members) => ({
    _id: 'chat-1',
    type: 'chat',
    members: members.map((m) => ({ toString: () => m })),
    createdBy: { toString: () => 'creator-id' },
    joinPolicy: 'open',
    publicRead: true,
    communityListed: true,
  });
  const reread = (pod) => ({
    populate: jest.fn().mockReturnValue({ populate: jest.fn().mockResolvedValue(pod) }),
  });
  const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

  beforeEach(() => {
    User.findById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });
  });
  afterEach(() => jest.clearAllMocks());

  it('joinPod mirrors the new membership after the Mongo update', async () => {
    const pod = openPod(['creator-id']);
    Pod.findById.mockResolvedValueOnce(pod).mockReturnValueOnce(reread(pod));
    const r = res();
    await podController.joinPod({ params: { id: 'chat-1' }, userId: 'new-user-id', user: {} }, r);
    expect(Pod.updateOne).toHaveBeenCalled();
    expect(mirrorMemberAdded).toHaveBeenCalledWith('chat-1', 'new-user-id');
    expect(Pod.updateOne.mock.invocationCallOrder[0]).toBeLessThan(mirrorMemberAdded.mock.invocationCallOrder[0]);
  });

  it('joinPod still answers when the mirror write fails', async () => {
    mirrorMemberAdded.mockResolvedValueOnce(false);
    const pod = openPod(['creator-id']);
    Pod.findById.mockResolvedValueOnce(pod).mockReturnValueOnce(reread(pod));
    const r = res();
    await podController.joinPod({ params: { id: 'chat-1' }, userId: 'new-user-id', user: {} }, r);
    expect(r.status).not.toHaveBeenCalled();
    expect(r.json).toHaveBeenCalledWith(pod);
  });

  it('joinPod writes no mirror row when the join is refused', async () => {
    const pod = { ...openPod(['creator-id']), joinPolicy: 'invite-only', communityListed: false };
    Pod.findById.mockResolvedValueOnce(pod);
    const r = res();
    await podController.joinPod({ params: { id: 'chat-1' }, userId: 'new-user-id', user: {} }, r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(mirrorMemberAdded).not.toHaveBeenCalled();
  });

  it('leavePod removes the mirror row after the Mongo save', async () => {
    const pod = hydratedPod([CREATOR_ID, MEMBER_ID]);
    Pod.findById.mockResolvedValue(pod);
    const r = res();
    await podController.leavePod({ params: { id: String(pod._id) }, userId: String(MEMBER_ID) }, r);
    expect(pod.save).toHaveBeenCalled();
    expect(mirrorMemberRemoved).toHaveBeenCalledWith(String(pod._id), String(MEMBER_ID));
    expect(r.json).toHaveBeenCalledWith(pod);
  });

  it('leavePod still answers when the mirror write fails', async () => {
    mirrorMemberRemoved.mockResolvedValueOnce(false);
    const pod = hydratedPod([CREATOR_ID, MEMBER_ID]);
    Pod.findById.mockResolvedValue(pod);
    const r = res();
    await podController.leavePod({ params: { id: String(pod._id) }, userId: String(MEMBER_ID) }, r);
    expect(r.status).not.toHaveBeenCalled();
    expect(r.json).toHaveBeenCalledWith(pod);
  });

  it('leavePod writes no mirror change when the creator is refused', async () => {
    const pod = hydratedPod([CREATOR_ID, MEMBER_ID]);
    Pod.findById.mockResolvedValue(pod);
    const r = res();
    await podController.leavePod({ params: { id: String(pod._id) }, userId: String(CREATOR_ID) }, r);
    expect(r.status).toHaveBeenCalledWith(409);
    expect(mirrorMemberRemoved).not.toHaveBeenCalled();
  });
});
