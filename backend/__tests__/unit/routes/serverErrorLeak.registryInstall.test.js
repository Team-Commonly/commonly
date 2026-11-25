// F626
// F584: a real pod id now reaches the route's outsider-grant checks, which
// returned "clear" early for this suite's old non-id fixture. They stay clear
// here; their own suites cover them.
jest.mock('../../../services/outsiderGrantNarrowingPreview', () => ({
  ...jest.requireActual('../../../services/outsiderGrantNarrowingPreview'),
  previewInstallNarrowing: jest.fn().mockResolvedValue({ status: 'clear' }),
}));
jest.mock('../../../services/runtimeIdentityOwnership', () => ({
  ...jest.requireActual('../../../services/runtimeIdentityOwnership'),
  identityHoldsRuntimeToken: () => Promise.resolve(false),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    getByName: jest.fn(),
    incrementInstalls: jest.fn(),
  },
  AgentInstallation: {
    findOne: jest.fn(),
    rowInPod: jest.fn().mockResolvedValue(null),
    find: jest.fn(),
    install: jest.fn(),
  },
}));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));

jest.mock('../../../middleware/auth', () => (_req, _res, next) => next());

jest.mock('../../../services/globalModelConfigService', () => ({
  getConfig: jest.fn(),
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/User', () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
}));

jest.mock('../../../models/AgentProfile', () => ({
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../../../models/AgentTemplate', () => ({
  find: jest.fn(),
}));

// A template icon's upload references are looked up at install (F615).
jest.mock('../../../models/File', () => ({ findByFileName: jest.fn().mockResolvedValue(null) }));

jest.mock('../../../models/Activity', () => ({
  create: jest.fn(),
}));

jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
    instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
  )),
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'bot-1' }),
  ensureAgentInPod: jest.fn().mockResolvedValue(true),
  // Unknown agentName in these tests → no AGENT_TYPES runtime fallback.
  getAgentTypeConfig: jest.fn(() => null),
  // Faithful mirror of the real taxonomy so the entitlement gate behaves.
  // The real classifier, not a copy, so this file tests the rule the route runs.
  isCloudRuntime: jest.requireActual('../../../services/agentIdentityService').isCloudRuntime,
}));

jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../../services/firstContactService', () => ({
  maybeFireFirstContact: jest.fn().mockResolvedValue(undefined),
}));

const { AgentRegistry, AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentProfile = require('../../../models/AgentProfile');
const AgentTemplate = require('../../../models/AgentTemplate');
const Activity = require('../../../models/Activity');
const AgentIdentityService = require('../../../services/agentIdentityService');
const { podHasOutsiderWritableGrant } = require('../../../services/nativeOutsiderGrantPolicy');
const FirstContactService = require('../../../services/firstContactService');
const AgentMessageService = require('../../../services/agentMessageService');
const installRouter = require('../../../routes/registry/install');
const {
  DRIVER_TEXT, getRouteHandler, makeRes, expectNoLeak,
} = require('../../utils/routeHandler');

// F626: the install catch-all answers an unexpected failure with fixed text.
// A 400/403/409 refusal we wrote still carries its own message.
describe('registry install 500', () => {
  let errorSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const installReq = () => ({
    userId: 'user-1',
    user: { id: 'user-1' },
    body: { agentName: 'sample-agent', podId: 'a0000000000000000000000a' },
  });

  it('an unexpected failure answers fixed text and logs the cause', async () => {
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ role: 'user' }) }) });
    Pod.findById.mockReturnValue({ lean: () => Promise.reject(new Error(DRIVER_TEXT)) });
    const { res, out } = makeRes();
    await getRouteHandler(installRouter, '/install', 'post')(installReq(), res);
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: 'Failed to install agent' });
    expectNoLeak(out);
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('Error installing agent:');
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('db.internal.example');
  });

  it('a 403 refusal we wrote keeps its message', async () => {
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ role: 'user' }) }) });
    Pod.findById.mockReturnValue({
      lean: () => Promise.reject(Object.assign(new Error('You cannot install into this pod'), { status: 403 })),
    });
    const { res, out } = makeRes();
    await getRouteHandler(installRouter, '/install', 'post')(installReq(), res);
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: 'You cannot install into this pod' });
  });

  it('a message AgentInstallation.install threw on purpose keeps its text', async () => {
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ role: 'user' }) }) });
    Pod.findById.mockReturnValue({ lean: () => Promise.reject(new Error('Agent already installed')) });
    const { res, out } = makeRes();
    await getRouteHandler(installRouter, '/install', 'post')(installReq(), res);
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: 'Agent already installed' });
  });
});
