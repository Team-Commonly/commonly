/**
 * markStaleInstallations — liveness signal regression tests.
 *
 * Guards the fix for a live outage (2026-07-18): the Telegram bridge agents
 * (telegram-app, yunus) were marked stale by this cron while actively
 * relaying messages, which made every send 403 with
 * "Agent token not authorized for this pod" — pod authorization requires
 * status 'active'.
 *
 * Root cause was a liveness blind spot, not a bug in the marking logic:
 *   - their tokens are long-lived file-based tokens with NO expiresAt, and
 *     hasValidRuntimeToken deliberately treats null-expiry as invalid;
 *   - posting a pod message emits NO AgentEvent, so a send-only integration
 *     shows zero event activity no matter how much traffic it pushes.
 * Both "dead" signals fired for an agent that was demonstrably alive.
 *
 * The surviving signal is agentRuntimeTokens[].lastUsedAt, which
 * agentRuntimeAuth writes on every authenticated request.
 */

jest.mock('node-cron', () => ({ schedule: jest.fn() }));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
}));
jest.mock('../../../models/AgentEvent', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/User', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ updateOne: jest.fn() }));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: (name, instanceId) => `${name}__${instanceId}`,
}));

const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentEvent = require('../../../models/AgentEvent');
const User = require('../../../models/User');
const { markStaleInstallations } = require('../../../services/agentInstallationCleanupService');

const DAY = 24 * 60 * 60 * 1000;

/** One active installation for the agent under test. */
function givenOneActiveInstall() {
  AgentInstallation.find.mockReturnValue({
    select: () => ({ lean: async () => [{ _id: 'i1', agentName: 'telegram-app', instanceId: 'default', podId: 'p1' }] }),
  });
}

/** The owning user's token state: what expiry it carries and when it was last used. */
function givenToken({ expiresAt = null, lastUsedAt = null }) {
  User.findOne.mockReturnValue({
    select: () => ({ lean: async () => ({ agentRuntimeTokens: [{ expiresAt, lastUsedAt }] }) }),
  });
}

/** No AgentEvent has ever been recorded — true for send-only integrations. */
function givenNoEvents() {
  AgentEvent.findOne.mockReturnValue({
    select: () => ({ sort: () => ({ lean: async () => null }) }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  AgentInstallation.updateMany.mockResolvedValue({ modifiedCount: 1 });
  givenOneActiveInstall();
  givenNoEvents();
});

describe('markStaleInstallations liveness signals', () => {
  it('spares a non-expiring token that was used recently (the outage case)', async () => {
    givenToken({ expiresAt: null, lastUsedAt: new Date(Date.now() - 1 * DAY) });

    const { marked } = await markStaleInstallations(7);

    expect(marked).toBe(0);
    expect(AgentInstallation.updateMany).not.toHaveBeenCalled();
  });

  it('still marks a non-expiring token unused past the cutoff', async () => {
    givenToken({ expiresAt: null, lastUsedAt: new Date(Date.now() - 30 * DAY) });

    const { marked } = await markStaleInstallations(7);

    expect(marked).toBe(1);
    expect(AgentInstallation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'stale' }) }),
    );
  });

  it('still marks a token that was never used at all', async () => {
    givenToken({ expiresAt: null, lastUsedAt: null });

    const { marked } = await markStaleInstallations(7);

    expect(marked).toBe(1);
  });

  it('does not mark installations younger than the staleness window', async () => {
    // A freshly provisioned agent reads "dead" on both signals purely because
    // nobody has @-mentioned it yet. The createdAt floor must exclude it.
    givenToken({ expiresAt: null, lastUsedAt: null });

    await markStaleInstallations(7);

    expect(AgentInstallation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: { $lt: expect.any(Date) } }),
      expect.anything(),
    );
  });

  it('spares an unexpired token regardless of use (pre-existing behavior)', async () => {
    givenToken({ expiresAt: new Date(Date.now() + 30 * DAY), lastUsedAt: null });

    const { marked } = await markStaleInstallations(7);

    expect(marked).toBe(0);
  });
});
