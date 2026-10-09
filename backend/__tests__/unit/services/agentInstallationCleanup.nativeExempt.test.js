/**
 * markStaleInstallations — native runtimes are exempt (TASK-041).
 *
 * Both liveness signals the mark step reads are runtime-token signals: an
 * unexpired token, or a token used since the cutoff, with AgentEvent recency
 * as the fallback. A native seat runs in-process, holds no runtime token, and
 * gets an AgentEvent only when a person addresses it — so a pod that is quiet
 * for a week reads as a dead agent. Measured 2026-09-18: 21 of 30 Scout
 * installs were 'stale', and pod authorization requires 'active', so every
 * @-mention in those pods 403'd.
 *
 * `internal` is the legacy in-process runtime type and is deliberately NOT
 * exempt: it stays swept exactly as before.
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
const {
  markStaleInstallations,
  isStalenessExempt,
  STALENESS_EXEMPT_RUNTIME_TYPES,
} = require('../../../services/agentInstallationCleanupService');

const install = (agentName, runtimeType, podId = 'p1') => ({
  _id: `${agentName}-${podId}`,
  agentName,
  instanceId: 'default',
  podId,
  config: runtimeType ? { runtime: { runtimeType } } : {},
});

let selectedFields;

function givenActiveInstalls(rows) {
  AgentInstallation.find.mockReturnValue({
    select: (fields) => {
      selectedFields = fields;
      return { lean: async () => rows };
    },
  });
}

/** The owning user reads dead on every token signal: no token at all. */
function givenNoTokens() {
  User.findOne.mockReturnValue({
    select: () => ({ lean: async () => ({ agentRuntimeTokens: [] }) }),
  });
}

function givenNoEvents() {
  AgentEvent.findOne.mockReturnValue({
    select: () => ({ sort: () => ({ lean: async () => null }) }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  selectedFields = undefined;
  AgentInstallation.updateMany.mockResolvedValue({ modifiedCount: 1 });
  givenNoTokens();
  givenNoEvents();
});

describe('markStaleInstallations native exemption', () => {
  it('exempts exactly the native runtime type', () => {
    expect(STALENESS_EXEMPT_RUNTIME_TYPES).toEqual(['native']);
    expect(isStalenessExempt(install('scout', 'native'))).toBe(true);
    expect(isStalenessExempt(install('scout', 'Native'))).toBe(true);
    expect(isStalenessExempt(install('legacy', 'internal'))).toBe(false);
    expect(isStalenessExempt(install('remote', 'moltbot'))).toBe(false);
    expect(isStalenessExempt(install('bare', undefined))).toBe(false);
    expect(isStalenessExempt(null)).toBe(false);
  });

  it('leaves a native install active past the window with no token and no events', async () => {
    givenActiveInstalls([install('scout', 'native')]);

    const { marked, evaluationFailures } = await markStaleInstallations(7);

    expect(marked).toBe(0);
    expect(evaluationFailures).toBe(0);
    expect(AgentInstallation.updateMany).not.toHaveBeenCalled();
    // Never even looked up: an exempt pair does not enter the evaluation.
    expect(User.findOne).not.toHaveBeenCalled();
    expect(AgentEvent.findOne).not.toHaveBeenCalled();
  });

  it('still marks an internal install in the same dead state', async () => {
    givenActiveInstalls([install('legacy', 'internal')]);

    const { marked } = await markStaleInstallations(7);

    expect(marked).toBe(1);
    expect(AgentInstallation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', $or: [{ agentName: 'legacy', instanceId: 'default' }] }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'stale' }) }),
    );
  });

  it('projects config.runtime so the exemption reads a real value', async () => {
    givenActiveInstalls([]);

    await markStaleInstallations(7);

    expect(String(selectedFields)).toContain('config.runtime');
  });

  it('keeps the write off native rows of a pair that is also installed non-natively', async () => {
    // Same (agentName, instanceId) in two pods, one native and one not: the
    // non-native row decides staleness, and the updateMany filter must exclude
    // the native row from the write.
    givenActiveInstalls([install('scout', 'native', 'p1'), install('scout', 'moltbot', 'p2')]);

    const { marked } = await markStaleInstallations(7);

    expect(marked).toBe(1);
    expect(AgentInstallation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ 'config.runtime.runtimeType': { $nin: ['native'] } }),
      expect.anything(),
    );
  });
});
