/**
 * Per-user Guide identity fork.
 *
 * Identity is the join key for everything (ADR-003: one memory envelope per
 * (agentName, instanceId)). Installing every user's Guide as (guide,
 * 'default') gave the whole instance ONE shared memory doc — user A's
 * durable preferences readable from user B's workspace. Caught 2026-08-13
 * with zero bytes written; these pin the fork so it cannot regress.
 *
 * TASK-149 moved the Guide's install into finishWorkspaceOnboarding, queued
 * from createDefaultWorkspacePod rather than awaited before the 201. These
 * tests therefore drive the tail directly — the identity is computed from the
 * userId, so the entry point is irrelevant to the property under test.
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
  create: jest.fn().mockImplementation(async (attrs) => ({
    _id: 'pod-123',
    type: attrs.type,
    members: attrs.members,
  })),
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
  buildInstallationConfig: jest.fn(() => ({
    runtime: { runtimeType: 'native' },
    wakeOnMessage: { enabled: true },
  })),
}));
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: (...args) => mockPostMessage(...args),
}));

const { createHash } = require('crypto');
const authController = require('../../../controllers/authController');

// The per-user-agent identity convention: short, stable,
// and OPAQUE — the raw userId must not survive into any identity tier.
const conventionId = (userId) => `u${createHash('sha256').update(String(userId)).digest('hex').slice(0, 10)}`;

describe('workspace onboarding guide identity fork (2026-08-13)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('installs the guide under the convention instanceId — short, opaque, never default', async () => {
    await authController.finishWorkspaceOnboarding({ _id: 'pod-123' }, 'User-1');
    const expected = conventionId('User-1');

    const [filter, update] = mockInstallUpsert.mock.calls[0];
    expect(filter.instanceId).toBe(expected);
    expect(update.$setOnInsert.instanceId).toBe(expected);
    expect(filter.instanceId).not.toBe('default');
    // Convention shape: u + 10 hex. Neither the raw userId nor its lowercase
    // form may appear in the identity.
    expect(filter.instanceId).toMatch(/^u[a-f0-9]{10}$/);
    expect(filter.instanceId).not.toContain('user-1');

    expect(mockGetOrCreateAgentUser).toHaveBeenCalledWith('scout', expect.objectContaining({
      instanceId: expected,
    }));
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'scout',
      instanceId: expected,
    }));
    // The setting is per installation, not a pod-shape policy. A later shared
    // room continues to honor this owner's explicit opt-in.
    expect(update.$set.config.wakeOnMessage.enabled).toBe(true);
  });

  // The writer side of /api/users/me/agent-connection's rule. The first-run
  // card shows only while the person has attached no agent, and that endpoint
  // skips SIGNUP_INSTALLED_AGENT_NAMES. An install signup makes in the person's
  // name outside that set would hide the card from every new signup, as Scout
  // did until #2190, with the endpoint's own tests still green.
  test('every install signup writes in the person\'s name is one the first-run check excludes', async () => {
    // eslint-disable-next-line global-require
    const { SIGNUP_INSTALLED_AGENT_NAMES } = require('../../../config/native-agents/apps');
    await authController.finishWorkspaceOnboarding({ _id: 'pod-123' }, 'User-1');

    const installedInTheirName = mockInstallUpsert.mock.calls
      .filter(([, update]) => String(update.$setOnInsert?.installedBy ?? update.$set?.installedBy) === 'User-1')
      .map(([filter]) => String(filter.agentName).toLowerCase());
    expect(installedInTheirName).toEqual(['scout']);
    installedInTheirName.forEach((name) => expect(SIGNUP_INSTALLED_AGENT_NAMES.has(name)).toBe(true));
  });

  // First session, direction B: the welcome offers the starts as buttons. They
  // ride the message as a server-composed payload, so the client renders them
  // from structure and never from Scout's text.
  test('the welcome carries the starts in its payload, with the copy they sit under', async () => {
    // eslint-disable-next-line global-require
    const { SCOUT_STARTS, SCOUT_WELCOME } = require('../../../config/native-agents/scout');
    await authController.finishWorkspaceOnboarding({ _id: 'pod-123' }, 'User-1');

    const welcome = mockPostMessage.mock.calls[0][0];
    expect(welcome.content).toBe(SCOUT_WELCOME);
    expect(welcome.content).toBe("I'm Scout, your first agent here. Pick one below, or just tell me what you're working on.");
    expect(welcome.payload).toEqual({
      kind: 'starts',
      starts: [
        { id: 'connect-agent', label: 'Connect an agent I already use' },
        { id: 'start-pod', label: 'Start a pod for a project' },
      ],
    });
    expect(welcome.payload.starts).toEqual(SCOUT_STARTS.map(({ id, label }) => ({ id, label })));
  });

  // QA walk 3 (2026-10-16): where the instance can host, the welcome leads with
  // hosting, nothing to install. It sends no message: on the person's own
  // welcome it runs in place (TASK-290), and its
  // link opens Bring your own with hosting chosen, in this workspace, for
  // anyone it does not run for.
  test('leads the starts with Run an agent here, aimed at this workspace, where the instance can host', async () => {
    const saved = { ...process.env };
    try {
      process.env.HOSTED_ENGINE = 'native';
      process.env.LITELLM_BASE_URL = 'http://litellm.test';
      process.env.LITELLM_MASTER_KEY = 'k';
      // eslint-disable-next-line global-require
      const { SCOUT_STARTS, SCOUT_HOSTED_START } = require('../../../config/native-agents/scout');
      await authController.finishWorkspaceOnboarding({ _id: 'pod-123' }, 'User-1');

      const { starts } = mockPostMessage.mock.calls[0][0].payload;
      expect(starts[0]).toEqual({
        id: 'run-hosted',
        label: SCOUT_HOSTED_START.label,
        href: '/v2/agents/byo?pod=pod-123&mode=hosted',
        action: 'run-hosted',
        caps: { agentsPerUser: 1, turnsPerDay: 30 },
      });
      expect(starts.slice(1)).toEqual(SCOUT_STARTS.map(({ id, label }) => ({ id, label })));
    } finally {
      process.env = saved;
    }
  });

  test('two users get two distinct guide identities — the memory-envelope fork', async () => {
    await authController.finishWorkspaceOnboarding({ _id: 'pod-123' }, 'aaaa1111');
    await authController.finishWorkspaceOnboarding({ _id: 'pod-123' }, 'bbbb2222');

    const ids = mockInstallUpsert.mock.calls.map(([filter]) => filter.instanceId);
    expect(ids).toEqual([conventionId('aaaa1111'), conventionId('bbbb2222')]);
    expect(new Set(ids).size).toBe(2);
  });

  // The dependency the tail's order exists for: the welcome is a message INSERT
  // against the pod's PG row, so the mirror has to have finished first. Call
  // order, not presence — presence alone would not notice the two being swapped.
  test('mirrors the pod into PG before the Guide posts its welcome', async () => {
    const oldPgHost = process.env.PG_HOST;
    process.env.PG_HOST = 'localhost';
    try {
      await authController.finishWorkspaceOnboarding({ _id: 'pod-123' }, 'User-1');

      expect(mockSyncPod).toHaveBeenCalledTimes(1);
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      expect(mockSyncPod.mock.invocationCallOrder[0])
        .toBeLessThan(mockPostMessage.mock.invocationCallOrder[0]);
    } finally {
      if (oldPgHost === undefined) delete process.env.PG_HOST;
      else process.env.PG_HOST = oldPgHost;
    }
  });
});
