// createDefaultWorkspacePod must mirror the new "My Workspace" pod into
// PostgreSQL at registration. Before the 2026-07-24 fix it only wrote Mongo,
// so a fresh user's workspace was missing from PG until its first chat message
// (the messageController lazy backfill) — and any *non-message* PG op on it
// (adding a member/agent first) FK-failed on the absent `pods` row. Registration
// also hasn't synced the user to PG by this point, so the pod's member insert
// would fail its user_id FK unless the user is synced FIRST. This guards both.
//
// TASK-149 split the mirror (and everything else after the pod row) into
// finishWorkspaceOnboarding, which createDefaultWorkspacePod now queues rather
// than awaits. The subject of the order/failure assertions below is therefore
// the tail itself; the queuing is asserted separately, at the bottom.

// jsonwebtoken must be mocked or it fails to load under the Node-26 drift
// (buffer-equal-constant-time) — same guard the sibling authController test uses.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 'tok'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('bcryptjs', () => ({ hash: jest.fn(), compare: jest.fn(), genSalt: jest.fn(() => 'salt') }));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../services/communityPodService', () => ({
  ensureUserInCommunityPod: jest.fn().mockResolvedValue(undefined),
}));

const mockSyncUser = jest.fn().mockResolvedValue(undefined);
const mockSyncPod = jest.fn().mockResolvedValue({});
jest.mock('../../../models/Pod', () => ({ create: jest.fn().mockResolvedValue({ _id: 'pod-123' }) }));
jest.mock('../../../models/User', () => ({ findById: jest.fn().mockResolvedValue({ _id: 'user-1' }) }));
jest.mock('../../../models/Task', () => ({ create: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../services/agentIdentityService', () => ({ syncUserToPostgreSQL: mockSyncUser }));
jest.mock('../../../services/pgPodSyncService', () => ({ syncPodFromMongo: mockSyncPod }));

const authController = require('../../../controllers/authController');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');

describe('workspace onboarding PG mirror (2026-07-24 incident)', () => {
  const OLD_PG = process.env.PG_HOST;
  afterAll(() => {
    if (OLD_PG === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = OLD_PG;
  });
  beforeEach(() => jest.clearAllMocks());

  test('mirrors the workspace into PG — user synced BEFORE the pod (FK-safe order)', async () => {
    process.env.PG_HOST = 'localhost';
    await authController.finishWorkspaceOnboarding({ _id: 'pod-123' }, 'user-1');

    expect(mockSyncUser).toHaveBeenCalledTimes(1);
    expect(mockSyncPod).toHaveBeenCalledWith('pod-123', 'user-1');
    // The user MUST sync first, or PGPod.create's member insert FK-fails.
    expect(mockSyncUser.mock.invocationCallOrder[0])
      .toBeLessThan(mockSyncPod.mock.invocationCallOrder[0]);
  });

  test('skips the PG mirror entirely when PG_HOST is unset (Mongo-only dev)', async () => {
    delete process.env.PG_HOST;
    await authController.finishWorkspaceOnboarding({ _id: 'pod-123' }, 'user-1');
    expect(mockSyncPod).not.toHaveBeenCalled();
  });

  // TASK-149: the whole tail is queued, not awaited, so the 201 does not carry
  // its ~1.0 s. The tail's first step is parked on a promise that never
  // settles: if createDefaultWorkspacePod awaited it, this test would time out
  // on the line below rather than fail an assertion. The pod row must still be
  // on the path — the V2 landing guard reads GET /api/pods at the 201
  // (TASK-144) — so its create is asserted here too.
  test('createDefaultWorkspacePod creates the pod, then only queues the tail', async () => {
    process.env.PG_HOST = 'localhost';
    User.findById.mockImplementationOnce(() => new Promise(() => {}));

    await authController.createDefaultWorkspacePod('user-1');

    // The pod is on the response path ...
    expect(Pod.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'My Workspace',
      createdBy: 'user-1',
      members: ['user-1'],
    }));

    // ... and the tail is still parked at its first step two macrotask turns
    // after the queued call, which is the whole assertion.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(mockSyncUser).not.toHaveBeenCalled();
    expect(mockSyncPod).not.toHaveBeenCalled();
  });
});
