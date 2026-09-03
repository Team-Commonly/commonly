/**
 * TASK-099 site 3 — `{ marked: 0 }` must not mean both "nothing was stale" and
 * "every staleness check threw".
 *
 * The per-item catch logs and continues, so the returned count is a LOWER BOUND
 * reported as a total. That is loud at the log and silent at the return value,
 * and the return value is what the runner prints and what a caller could gate on.
 *
 * Closes a gap @sprint-review found by mutation on #1519: stopping the failure
 * counter left the suite green, because the existing staleness suite only ever
 * destructures `marked`.
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

const givenActiveInstalls = (n) => {
  const rows = Array.from({ length: n }, (_, i) => ({
    _id: `i${i}`, agentName: 'telegram-app', instanceId: `inst-${i}`, podId: 'p1',
  }));
  AgentInstallation.find.mockReturnValue({ select: () => ({ lean: async () => rows }) });
};

// A live token: unexpired, so the pair is spared and nothing is marked. This is
// the SUCCESS TWIN of the failure case — both return `marked: 0`.
const givenLiveToken = () => {
  User.findOne.mockReturnValue({
    select: () => ({ lean: async () => ({ agentRuntimeTokens: [{ expiresAt: new Date(Date.now() + 864e5) }] }) }),
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  AgentInstallation.updateMany.mockResolvedValue({ modifiedCount: 0 });
  AgentEvent.findOne.mockReturnValue({ select: () => ({ sort: () => ({ lean: async () => null }) }) });
});

describe('markStaleInstallations — a failed sweep differs from a clean one', () => {
  it('a clean sweep with nothing stale reports zero failures', async () => {
    givenActiveInstalls(2);
    givenLiveToken();
    const result = await markStaleInstallations(7);
    expect(result).toEqual({ marked: 0, evaluationFailures: 0 });
  });

  it('a sweep that threw on every pair reports the same marked:0 AND its failures', async () => {
    givenActiveInstalls(2);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    User.findOne.mockImplementation(() => { throw new Error('mongo down'); });

    const result = await markStaleInstallations(7);

    // The count alone is indistinguishable from the clean sweep above — which is
    // why the second field has to exist.
    expect(result.marked).toBe(0);
    expect(result.evaluationFailures).toBe(2);
    expect(err).toHaveBeenCalledTimes(2);

    err.mockRestore();
  });

  it('a PARTIAL failure is reported as partial, not rounded to either end', async () => {
    givenActiveInstalls(2);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    let call = 0;
    User.findOne.mockImplementation(() => {
      call += 1;
      if (call === 1) throw new Error('mongo down');
      return { select: () => ({ lean: async () => ({ agentRuntimeTokens: [{ expiresAt: new Date(Date.now() + 864e5) }] }) }) };
    });

    const result = await markStaleInstallations(7);

    expect(result.evaluationFailures).toBe(1);
    err.mockRestore();
  });
});
