/**
 * F664: a grant whose owner account is gone is refused at use, and the tool list
 * a hosted run is offered applies the same owner checks the call does: a pod
 * grant needs its owner in the pod, a seat grant needs its owner's account to
 * exist. A grant with no recorded owner is not judged by either.
 *
 * RoomGrant, ApprovalAction, Pod, User, Integration and AgentInstallation run
 * on memory Mongo; the GitHub client is stubbed so no vendor is reached.
 */
process.env.PG_HOST = '';
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const mockListIssues = jest.fn();
const mockCreateIssue = jest.fn();
jest.mock('../../services/githubAppService', () => ({
  listOpenIssues: (...args) => mockListIssues(...args),
  createIssue: (...args) => mockCreateIssue(...args),
  getInstallationToken: jest.fn(),
}));
jest.mock('../../models/ToolCall', () => {
  const actual = jest.requireActual('../../models/ToolCall');
  const create = jest.fn(async (row) => row);
  return {
    __esModule: true,
    ...actual,
    default: { ...actual.default, create, digestArgs: actual.digestArgs },
    create,
    digestArgs: actual.digestArgs,
    reserveBudgetLineage: jest.fn(async () => true),
  };
});
jest.mock('../../services/agentMessageService', () => ({
  postMessage: jest.fn(async () => ({ success: true, message: { _id: new (require('mongoose').Types.ObjectId)().toString() } })),
}));
jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn(async () => ({})) }));
jest.mock('../../services/attentionItemService', () => ({
  recordActionApproval: jest.fn(async () => undefined),
  resolve: jest.fn(async () => undefined),
  resolveExpired: jest.fn(async () => undefined),
}));
jest.mock('../../config/socket', () => ({ getIO: jest.fn(() => ({ to: () => ({ emit: jest.fn() }) })) }));
jest.mock('../../models/Message', () => ({ updateOne: jest.fn(async () => ({})) }));
jest.mock('../../services/brokerRecordService', () => ({
  recordBrokerCall: jest.fn(), recordApprovalOutcome: jest.fn(),
  recordGrantExpired: jest.fn(), recordGrantsRevoked: jest.fn(), recordGrantIssued: jest.fn(),
}));

const mongoose = require('mongoose');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Integration = require('../../models/Integration');
const RoomGrant = require('../../models/RoomGrant');
const ApprovalAction = require('../../models/ApprovalAction');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { mintGrant } = require('../../services/roomGrantService');
const { GRANT_BROKER_ID } = require('../../services/installable/toolInstallables');
const { listToolsForGrant } = require('../../services/toolBrokerService');
const {
  dispatchHostedBrokerTool, hostedBrokerToolsForRun, selectLiveGrantsForIdentities,
} = require('../../services/grantBrokerProjectionService');

jest.setTimeout(60000);
beforeAll(setupMongoDb);
afterAll(closeMongoDb);

let owner;
let seat;
let pod;
let connection;

const mint = (over = {}) => mintGrant({
  connectionId: String(connection._id),
  installationId: String(connection._id),
  target: { kind: 'seat', id: String(seat._id) },
  tools: ['github.list_issues', 'github.create_issue'],
  writeMode: 'write-with-confirm',
  audience: [String(seat._id)],
  expiresAt: new Date(Date.now() + 7 * 86400000),
  brokerId: GRANT_BROKER_ID,
  ownerId: String(owner._id),
  connectionRowId: String(connection._id),
  ...over,
});

const project = () => hostedBrokerToolsForRun({ identityId: String(seat._id), podId: String(pod._id) });
const grantsOffered = (projection) => [...new Set([...projection.dispatch.values()].map((entry) => entry.grantId))];
const forged = (grantId, tool) => ({ tools: [], dispatch: new Map([['forged', { grantId, tool }]]) });
const hostedCall = (projection, name, args = {}) => dispatchHostedBrokerTool({
  projection, name, args, agentUserId: String(seat._id),
  agentName: 'helper', instanceId: 'default', runPodId: String(pod._id),
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockListIssues.mockReset().mockResolvedValue([]);
  mockCreateIssue.mockReset().mockResolvedValue({ number: 1 });
  await Promise.all([User.deleteMany({}), Pod.deleteMany({}), Integration.deleteMany({}), RoomGrant.deleteMany({}),
    ApprovalAction.deleteMany({}), AgentInstallation.deleteMany({})]);
  owner = await User.create({ username: 'grant-owner', email: 'grant-owner@example.test', password: 'pw-123456' });
  seat = await User.create({ username: 'helper-seat', email: 'helper@agents.commonly.local', password: 'pw-123456',
    isBot: true, botType: 'agent', botMetadata: { agentName: 'helper', instanceId: 'default' } });
  pod = await Pod.create({ name: 'Owner checks pod', type: 'team', createdBy: owner._id,
    members: [owner._id, seat._id], publicRead: false, joinPolicy: 'invite-only' });
  connection = await Integration.create({ type: 'github-app', scope: 'user', status: 'connected', createdBy: owner._id,
    isActive: true, config: { app: 'tools', installationId: '777', owner: 'acme', repo: 'widgets', repoKey: 'acme/widgets' } });
  await AgentInstallation.create({ agentName: 'helper', instanceId: 'default', podId: pod._id, installedBy: owner._id,
    version: '1.0.0', status: 'active', config: { runtime: { runtimeType: 'native' } } });
  await new Promise((resolve) => { setTimeout(resolve, 5); });
});

describe('a seat grant whose owner account is gone', () => {
  test('is refused at use with grant_owner_deleted, before any vendor call or approval card', async () => {
    const grant = await mint();
    await User.deleteOne({ _id: owner._id });

    const read = await hostedCall(forged(grant.grantId, 'github.list_issues'), 'forged');
    expect(read).toMatchObject({ outcome: 'refused', content: { error: 'grant_owner_deleted' } });
    const write = await hostedCall(forged(grant.grantId, 'github.create_issue'), 'forged', { title: 't', body: 'b' });
    expect(write).toMatchObject({ outcome: 'refused', content: { error: 'grant_owner_deleted' } });

    expect(mockListIssues).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(await ApprovalAction.countDocuments({})).toBe(0);
    // The refusal writes nothing to the grant.
    expect((await RoomGrant.findOne({ grantId: grant.grantId }).lean()).revokedAt).toBeNull();
  });

  test('with its owner present, the same grant is not refused by the owner check', async () => {
    // A seat grant then meets the broker's later checks (the pod gate), which
    // are not this suite's subject; only the owner refusal is pinned here.
    const grant = await mint();
    const read = await hostedCall(forged(grant.grantId, 'github.list_issues'), 'forged');
    expect(read.content?.error).not.toBe('grant_owner_deleted');
  });

  test('a grant with no recorded owner is not judged by the owner check', async () => {
    const grant = await mint({ ownerId: undefined, connectionRowId: undefined });
    await User.deleteOne({ _id: owner._id });
    const read = await hostedCall(forged(grant.grantId, 'github.list_issues'), 'forged');
    expect(read.content?.error).not.toBe('grant_owner_deleted');
  });
});

describe('the tool list a hosted run is offered', () => {
  test('omits a seat grant whose owner was deleted and a pod grant whose owner left, and keeps a healthy one', async () => {
    const other = await User.create({ username: 'other-owner', email: 'other-owner@example.test', password: 'pw-123456' });
    await Pod.updateOne({ _id: pod._id }, { $push: { members: other._id } });
    const healthy = await mint({ ownerId: String(other._id), tools: ['github.list_issues'] });
    const deletedSeat = await mint({ tools: ['github.list_issues'] });
    const leftPod = await mint({
      ownerId: String(other._id),
      target: { kind: 'pod', id: String(pod._id) },
      tools: ['github.list_issues'],
    });

    const selected = async () => ((await selectLiveGrantsForIdentities({
      identityIds: [String(seat._id)], podIds: [String(pod._id)],
    })).get(String(seat._id)) || []).map((grant) => grant.grantId).sort();

    // Before anyone goes, all three are selected.
    expect(await selected()).toEqual([healthy.grantId, deletedSeat.grantId, leftPod.grantId].sort());

    await User.deleteOne({ _id: owner._id });
    await Pod.updateOne({ _id: pod._id }, { $pull: { members: other._id } });

    // `healthy` is a seat grant: its owner left the pod, but their account
    // exists, and a seat grant's census is the seat.
    expect(await selected()).toEqual([healthy.grantId]);
    expect(grantsOffered(await project())).toEqual([healthy.grantId]);
  });

  test('keeps listing a grant with no recorded owner', async () => {
    const unbound = await mint({ ownerId: undefined, connectionRowId: undefined, tools: ['github.list_issues'] });
    await User.deleteOne({ _id: owner._id });
    expect(grantsOffered(await project())).toEqual([unbound.grantId]);
  });
});

describe('a pod grant whose owner account is gone, in every room', () => {
  const dmRoomGrant = async () => {
    // Deletion keeps the person in their DM rooms, so the member check alone
    // would still pass here.
    const room = await Pod.create({ name: 'Owner and helper', type: 'agent-room', createdBy: owner._id,
      members: [owner._id, seat._id], publicRead: false, joinPolicy: 'invite-only' });
    pod = room;
    return mint({ target: { kind: 'pod', id: String(room._id) } });
  };

  test('a DM-room pod grant is refused with grant_owner_deleted, with no vendor call or card', async () => {
    const grant = await dmRoomGrant();
    await User.deleteOne({ _id: owner._id });

    const read = await hostedCall(forged(grant.grantId, 'github.list_issues'), 'forged');
    expect(read).toMatchObject({ outcome: 'refused', content: { error: 'grant_owner_deleted' } });
    const write = await hostedCall(forged(grant.grantId, 'github.create_issue'), 'forged', { title: 't', body: 'b' });
    expect(write).toMatchObject({ outcome: 'refused', content: { error: 'grant_owner_deleted' } });
    expect(mockListIssues).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(await ApprovalAction.countDocuments({})).toBe(0);
    expect(grantsOffered(await project())).toEqual([]);
  });

  test('an owner with a deletion request counts as gone, for pod and seat grants alike', async () => {
    const podGrant = await mint({ target: { kind: 'pod', id: String(pod._id) } });
    const seatGrant = await mint();
    await User.updateOne({ _id: owner._id }, { $set: { accountDeletionRequestedAt: new Date() } });

    for (const grant of [podGrant, seatGrant]) {
      // eslint-disable-next-line no-await-in-loop
      const read = await hostedCall(forged(grant.grantId, 'github.list_issues'), 'forged');
      expect(read).toMatchObject({ outcome: 'refused', content: { error: 'grant_owner_deleted' } });
    }
    expect(mockListIssues).not.toHaveBeenCalled();
    expect(grantsOffered(await project())).toEqual([]);
  });

  test('the MCP tools/list path (not a hosted turn) refuses it too', async () => {
    const grant = await mint({ target: { kind: 'pod', id: String(pod._id) } });
    await User.deleteOne({ _id: owner._id });
    await expect(listToolsForGrant({
      grantId: grant.grantId, agentUserId: String(seat._id), agentName: 'helper', instanceId: 'default',
    })).rejects.toMatchObject({ code: 'grant_owner_deleted', statusCode: 403 });
  });
});
