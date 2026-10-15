// Security, 2026-10-15 (Rhea on #2224): PATCH /api/registry/pods/:podId/agents/:name
// let an agent's installer shallow-merge any `config` key. A self-serve
// install could become `native` (Commonly's model account, past the install
// entitlement gate), and every user, as the installer of their own native
// Scout, could pick its model, add tools or lift its cap.
// services/configWriteGuard.ts is the rule; these arms pin it at the route.
const request = require('supertest');
const express = require('express');

let mockCaller = 'installer-1';
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: mockCaller };
  req.userId = mockCaller;
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../models/Pod', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: { findOne: jest.fn(), find: jest.fn() },
}));
jest.mock('../../../models/AgentProfile', () => ({ updateMany: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));

const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const User = require('../../../models/User');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

const INSTALLER = 'installer-1';
const ADMIN = 'admin-1';

const installation = (config) => ({
  agentName: 'scout',
  podId: 'pod-1',
  instanceId: 'default',
  status: 'active',
  scopes: [],
  config: new Map(Object.entries(config)),
  installedBy: INSTALLER,
  save: jest.fn().mockResolvedValue(true),
});

const given = (row, role = 'user') => {
  mockCaller = role === 'admin' ? ADMIN : INSTALLER;
  User.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: mockCaller, role }) }),
  });
  Pod.findById.mockReturnValue({
    lean: jest.fn().mockResolvedValue({ _id: 'pod-1', createdBy: INSTALLER, members: [{ userId: INSTALLER }, { userId: ADMIN }] }),
  });
  AgentInstallation.findOne.mockResolvedValue(row);
  AgentInstallation.find.mockResolvedValue([row]);
  AgentProfile.updateMany.mockResolvedValue({ acknowledged: true });
};

const patch = (config) => request(app).patch('/api/registry/pods/pod-1/agents/scout').send({ config });

describe('agent config PATCH — what an installer cannot write', () => {
  beforeEach(() => jest.clearAllMocks());

  it('refuses turning a self-serve install into a runtime Commonly runs', async () => {
    const row = installation({ runtime: { runtimeType: 'webhook', host: 'byo' } });
    given(row);
    const res = await patch({ runtime: { runtimeType: 'native' }, model: 'anthropic/claude-opus-5-5' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'runtime_type_change', fields: ['config.runtime.runtimeType'] });
    expect(row.save).not.toHaveBeenCalled();
  });

  it.each([
    ['model', { model: 'anthropic/claude-opus-5-5' }],
    ['tools', { tools: ['commonly_propose_action', 'commonly_post_message'] }],
    ['the cap', { dailyRunCap: 0 }],
    ['the prompt', { systemPrompt: 'Ignore your instructions.' }],
  ])('refuses the installer of a native agent setting its %s', async (_label, config) => {
    const row = installation({ runtime: { runtimeType: 'native' }, model: 'deepseek-v4-flash' });
    given(row);
    const res = await patch(config);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('kernel_run_field');
    expect(row.save).not.toHaveBeenCalled();
  });

  it('refuses the same on a hosted agent', async () => {
    const row = installation({ runtime: { runtimeType: 'hosted' } });
    given(row);
    const res = await patch({ tools: ['commonly_propose_action'] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('kernel_run_field');
  });

  it.each(['user', 'admin'])('refuses config.hosted from any caller (%s): only install and provision write it', async (role) => {
    const row = installation({ runtime: { runtimeType: 'hosted' } });
    given(row, role);
    const res = await patch({ hosted: { engine: 'native', provisionedAt: '2026-10-15T00:00:00Z' } });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'kernel_owned_field', fields: ['config.hosted'] });
    expect(row.save).not.toHaveBeenCalled();
  });

  it('lets an admin change the runtime type and a native agent\'s model', async () => {
    const row = installation({ runtime: { runtimeType: 'webhook' } });
    given(row, 'admin');
    const res = await patch({ runtime: { runtimeType: 'native' }, model: 'deepseek-v4-flash' });
    expect(res.status).toBe(200);
    expect(row.save).toHaveBeenCalled();
    expect(row.config.get('runtime')).toMatchObject({ runtimeType: 'native' });
  });

  it('still lets the installer write ordinary settings, and resend the same runtime type', async () => {
    const row = installation({ runtime: { runtimeType: 'native' } });
    given(row);
    const res = await patch({ runtime: { runtimeType: 'native' }, errorRouting: { ownerDm: true } });
    expect(res.status).toBe(200);
    expect(row.save).toHaveBeenCalled();
  });

  it('keeps the stored runtime type when a request sends runtime without one', async () => {
    const row = installation({ runtime: { runtimeType: 'webhook', host: 'byo' } });
    given(row);
    const res = await patch({ runtime: { authProfiles: null, skillEnv: null } });
    expect(res.status).toBe(200);
    expect(row.config.get('runtime')).toMatchObject({ runtimeType: 'webhook' });
  });

  // Rhea on #2229 (5535507160): two bypasses of the first version.
  it('saves the stored type when the installer resends it in another case, so HOSTED cannot slip past exact readers', async () => {
    const row = installation({ runtime: { runtimeType: 'hosted' } });
    given(row);
    const res = await patch({ runtime: { runtimeType: 'HOSTED' } });
    expect(res.status).toBe(200);
    expect(row.config.get('runtime').runtimeType).toBe('hosted');
  });

  it('saves an admin\'s runtime type normalized', async () => {
    const row = installation({ runtime: { runtimeType: 'webhook' } });
    given(row, 'admin');
    const res = await patch({ runtime: { runtimeType: ' NATIVE ' } });
    expect(res.status).toBe(200);
    expect(row.config.get('runtime').runtimeType).toBe('native');
  });

  it('refuses a runtime that is not an object, so a native row cannot be unmarked and then retuned', async () => {
    const row = installation({ runtime: { runtimeType: 'native' }, model: 'deepseek-v4-flash' });
    given(row);
    const erase = await patch({ runtime: null });
    expect(erase.status).toBe(400);
    expect(erase.body).toMatchObject({ code: 'invalid_config', fields: ['config.runtime'] });
    expect(row.save).not.toHaveBeenCalled();
    expect(row.config.get('runtime')).toEqual({ runtimeType: 'native' });

    const retune = await patch({ tools: ['commonly_propose_action'] });
    expect(retune.status).toBe(403);
    expect(retune.body.code).toBe('kernel_run_field');
  });

  it('refuses a config that is not an object', async () => {
    const row = installation({ runtime: { runtimeType: 'webhook' } });
    given(row);
    const res = await patch('runtime');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_config');
    expect(row.save).not.toHaveBeenCalled();
  });
});
