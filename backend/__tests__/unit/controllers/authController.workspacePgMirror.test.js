// createDefaultWorkspacePod must mirror the new "My Workspace" pod into
// PostgreSQL at registration. Before the 2026-07-24 fix it only wrote Mongo,
// so a fresh user's workspace was missing from PG until its first chat message
// (the messageController lazy backfill) — and any *non-message* PG op on it
// (adding a member/agent first) FK-failed on the absent `pods` row. Registration
// also hasn't synced the user to PG by this point, so the pod's member insert
// would fail its user_id FK unless the user is synced FIRST. This guards both.

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

describe('createDefaultWorkspacePod PG mirror (2026-07-24 incident)', () => {
  const OLD_PG = process.env.PG_HOST;
  afterAll(() => {
    if (OLD_PG === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = OLD_PG;
  });
  beforeEach(() => jest.clearAllMocks());

  test('mirrors the workspace into PG — user synced BEFORE the pod (FK-safe order)', async () => {
    process.env.PG_HOST = 'localhost';
    await authController.createDefaultWorkspacePod('user-1');

    expect(mockSyncUser).toHaveBeenCalledTimes(1);
    expect(mockSyncPod).toHaveBeenCalledWith('pod-123', 'user-1');
    // The user MUST sync first, or PGPod.create's member insert FK-fails.
    expect(mockSyncUser.mock.invocationCallOrder[0])
      .toBeLessThan(mockSyncPod.mock.invocationCallOrder[0]);
  });

  test('skips the PG mirror entirely when PG_HOST is unset (Mongo-only dev)', async () => {
    delete process.env.PG_HOST;
    await authController.createDefaultWorkspacePod('user-1');
    expect(mockSyncPod).not.toHaveBeenCalled();
  });
});
