/**
 * Per-user Guide identity fork.
 *
 * Identity is the join key for everything (ADR-003: one memory envelope per
 * (agentName, instanceId)). Installing every user's Guide as (guide,
 * 'default') gave the whole instance ONE shared memory doc — user A's
 * durable preferences readable from user B's workspace. Caught 2026-08-13
 * with zero bytes written; these pin the fork so it cannot regress.
 */

// jsonwebtoken must be mocked or it fails to load under the Node-26 drift
// (buffer-equal-constant-time) — same guard the sibling authController tests use.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 'tok'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('bcryptjs', () => ({ hash: jest.fn(), compare: jest.fn(), genSalt: jest.fn(() => 'salt') }));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../services/communityPodService', () => ({
  ensureUserInCommunityPod: jest.fn().mockResolvedValue(undefined),
}));

const mockSyncUser = jest.fn().mockResolvedValue(undefined);
const mockSyncPod = jest.fn().mockResolvedValue({});
const mockGetOrCreateAgentUser = jest.fn().mockResolvedValue({ _id: 'guide-bot-1' });
const mockInstallUpsert = jest.fn().mockResolvedValue({});
const mockPostMessage = jest.fn().mockResolvedValue({});
const mockPodUpdateOne = jest.fn().mockResolvedValue({});

jest.mock('../../../models/Pod', () => ({
  create: jest.fn().mockImplementation(async () => ({ _id: 'pod-123' })),
  updateOne: (...args) => mockPodUpdateOne(...args),
}));
jest.mock('../../../models/User', () => ({ findById: jest.fn().mockResolvedValue({ _id: 'user-1' }) }));
jest.mock('../../../models/Task', () => ({ create: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../services/agentIdentityService', () => ({
  syncUserToPostgreSQL: mockSyncUser,
  getOrCreateAgentUser: (...args) => mockGetOrCreateAgentUser(...args),
}));
jest.mock('../../../services/pgPodSyncService', () => ({ syncPodFromMongo: mockSyncPod }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOneAndUpdate: (...args) => mockInstallUpsert(...args) },
}));
jest.mock('../../../scripts/seed-native-agents', () => ({
  buildInstallationConfig: jest.fn(() => ({ runtime: { runtimeType: 'native' } })),
}));
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: (...args) => mockPostMessage(...args),
}));

const { createHash } = require('crypto');
const authController = require('../../../controllers/authController');

// The per-user-agent identity convention (Sam, 2026-08-13): short, stable,
// and OPAQUE — the raw userId must not survive into any identity tier.
const conventionId = (userId) => `u${createHash('sha256').update(String(userId)).digest('hex').slice(0, 10)}`;

describe('createDefaultWorkspacePod guide identity fork (2026-08-13)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('installs the guide under the convention instanceId — short, opaque, never default', async () => {
    await authController.createDefaultWorkspacePod('User-1');
    const expected = conventionId('User-1');

    const [filter, update] = mockInstallUpsert.mock.calls[0];
    expect(filter.instanceId).toBe(expected);
    expect(update.$setOnInsert.instanceId).toBe(expected);
    expect(filter.instanceId).not.toBe('default');
    // Convention shape: u + 10 hex. Neither the raw userId nor its lowercase
    // form may appear in the identity.
    expect(filter.instanceId).toMatch(/^u[a-f0-9]{10}$/);
    expect(filter.instanceId).not.toContain('user-1');

    expect(mockGetOrCreateAgentUser).toHaveBeenCalledWith('guide', expect.objectContaining({
      instanceId: expected,
    }));
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'guide',
      instanceId: expected,
    }));
  });

  test('two users get two distinct guide identities — the memory-envelope fork', async () => {
    await authController.createDefaultWorkspacePod('aaaa1111');
    await authController.createDefaultWorkspacePod('bbbb2222');

    const ids = mockInstallUpsert.mock.calls.map(([filter]) => filter.instanceId);
    expect(ids).toEqual([conventionId('aaaa1111'), conventionId('bbbb2222')]);
    expect(new Set(ids).size).toBe(2);
  });
});
