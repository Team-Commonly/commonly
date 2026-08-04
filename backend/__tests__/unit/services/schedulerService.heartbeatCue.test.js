// The inline heartbeat cue (ADR-012 §10.3) had NO test before this file, and
// it has been rewritten twice in one day — once to stop naming a shape no tool
// can emit (AX audit #6), once to tell a caller without the tool to skip rather
// than substitute. Both rewrites were invisible to CI.
//
// These assert the DELIVERED payload, not the source constant: they read what
// `AgentEventService.enqueue` actually receives, so extracting the cue into a
// module or building it differently cannot make them pass vacuously.

jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn().mockResolvedValue({ _id: 'evt' }),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
  },
}));

const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');

const schedulerServiceInstance = require('../../../services/schedulerService');
const SchedulerService = schedulerServiceInstance.constructor;

const INSTALLATION = {
  agentName: 'openclaw',
  instanceId: 'nova',
  podId: '69b7ddff0ce64c9648365fc4',
  config: { autonomy: { heartbeat: true } },
};

const mockInstallations = (installations) => {
  const lean = jest.fn().mockResolvedValue(installations);
  const select = jest.fn().mockReturnValue({ lean });
  AgentInstallation.find.mockReturnValue({ select });
};

const dispatchAndReadCue = async () => {
  mockInstallations([INSTALLATION]);
  jest.spyOn(SchedulerService, 'buildHeartbeatActivityHint').mockResolvedValue(null);
  await SchedulerService.dispatchAgentHeartbeats({ trigger: 'scheduled-interval' });
  expect(AgentEventService.enqueue).toHaveBeenCalled();
  const [{ payload }] = AgentEventService.enqueue.mock.calls[0];
  return String(payload?.content || '');
};

describe('heartbeat cue — the tool it names and the escape it offers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('names commonly_log_cycle, the only tool that can append to cycles', async () => {
    const content = await dispatchAndReadCue();
    // Non-vacuity: a cue that stopped mentioning any tool would otherwise pass
    // every "does not name X" assertion below by emptiness.
    expect(content.length).toBeGreaterThan(200);
    expect(content).toContain('commonly_log_cycle');
  });

  it('does not name a tool that cannot write cycles', async () => {
    const content = await dispatchAndReadCue();
    // `commonly_save_my_memory` shipped here for three months with a nested
    // `{sections:{cycles:{append}}}` body its schema rejects; three agents
    // concluded the section was unwritable and one misfiled into `daily`.
    expect(content).not.toContain('commonly_save_my_memory');
    expect(content).not.toContain('commonly_write_agent_memory');
  });

  it('tells a caller without the tool to skip rather than substitute', async () => {
    const content = await dispatchAndReadCue();
    // The load-bearing clause: `commonly_log_cycle` is absent from the openclaw
    // extension's 25-tool block, so ~20 moltbots receive this cue naming a tool
    // they do not have. Without this, a diligent agent exhausts the schema of
    // whatever memory tool it *does* have and burns its turn budget — the exact
    // failure that forced the #296 rollback.
    expect(content).toMatch(/not in your tool list/i);
    expect(content).toMatch(/do not substitute/i);
  });

  it('caps the takeaway and says the cap is enforced', async () => {
    const content = await dispatchAndReadCue();
    expect(content).toContain('500 chars');
    expect(content).toMatch(/truncated/i);
  });
});
