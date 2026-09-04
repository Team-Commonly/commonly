// An agent-room is a projection of an agent that already has an install
// somewhere. Its install must carry that agent's runtime, or the event router
// finds the pod-scoped row, sees no runtimeType, and parks every wake in the
// external queue where nothing consumes it — which is how every hosted Scout
// DM went silent between 2026-08-28 and 2026-09-02.
const mockFindOne = jest.fn();

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: mockFindOne, install: jest.fn() },
  AgentRegistry: { findOne: jest.fn() },
}));

const chain = (value) => ({ sort: () => ({ lean: async () => value }) });

describe('dmService.resolveInstallInheritance', () => {
  beforeEach(() => jest.clearAllMocks());

  it('copies everything the native runtime reads from the agent\'s active install, minus the projection\'s own keys', async () => {
    mockFindOne.mockReturnValue(chain({ config: { runtime: { runtimeType: 'native' }, model: 'deepseek-v4-flash', systemPrompt: 'You are Scout.', heartbeat: { enabled: true }, autoJoinSource: 'signup' } }));
    const { resolveInstallInheritance } = require('../../../services/dmService');
    await expect(resolveInstallInheritance('scout', 'u20f7e33728')).resolves.toEqual({ runtime: { runtimeType: 'native' }, model: 'deepseek-v4-flash', systemPrompt: 'You are Scout.' });
    expect(mockFindOne).toHaveBeenCalledWith({
      agentName: 'scout', instanceId: 'u20f7e33728', status: 'active', 'config.runtime.runtimeType': { $exists: true },
    });
  });

  it('reads a Mongoose Map config the way the router does', async () => {
    const config = new Map([['runtime', { runtimeType: 'native', host: 'cloud' }], ['model', 'deepseek-v4-flash'], ['heartbeat', { enabled: false }]]);
    mockFindOne.mockReturnValue(chain({ config }));
    const { resolveInstallInheritance, resolveInstallRuntime } = require('../../../services/dmService');
    await expect(resolveInstallInheritance('scout', 'abc')).resolves.toEqual({ runtime: { runtimeType: 'native', host: 'cloud' }, model: 'deepseek-v4-flash' });
    await expect(resolveInstallRuntime('scout', 'abc')).resolves.toEqual({ runtimeType: 'native', host: 'cloud' });
  });

  it('returns null when the agent has no install with a runtime, keeping the external queue', async () => {
    mockFindOne.mockReturnValue(chain(null));
    const { resolveInstallInheritance } = require('../../../services/dmService');
    await expect(resolveInstallInheritance('byo-agent', 'default')).resolves.toBeNull();
  });
});
