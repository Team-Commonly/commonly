jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

jest.mock('../../../models/Integration', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));

jest.mock('../../../models/Pod', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));

jest.mock('../../../integrations', () => ({
  get: jest.fn(),
}));

jest.mock('../../../services/socialPolicyService', () => ({
  getPolicy: jest.fn(),
  setPolicy: jest.fn(),
}));

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const registry = require('../../../integrations');
const router = require('../../../routes/admin/globalIntegrations');

function getRouteHandler(path, method) {
  const layer = router.stack.find(
    (entry) => entry.route && entry.route.path === path && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('admin global integrations route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Pod.findOne.mockResolvedValue({ _id: 'pod-global', name: 'Global Social Feed' });
  });

  it('tests X integration via registry.get(type, integration)', async () => {
    const handler = getRouteHandler('/x/test', 'post');
    const xIntegration = { _id: 'int-x', type: 'x', config: { accessToken: 'token' } };
    const provider = { validateConfig: jest.fn().mockResolvedValue(true) };
    const req = { userId: 'admin-1' };
    const res = createRes();

    Integration.findOne.mockResolvedValue(xIntegration);
    registry.get.mockReturnValue(provider);

    await handler(req, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: true, message: 'X connection successful' });
    expect(registry.get).toHaveBeenCalledWith('x', xIntegration);
    expect(provider.validateConfig).toHaveBeenCalledTimes(1);
  });

  it('tests Instagram integration via registry.get(type, integration)', async () => {
    const handler = getRouteHandler('/instagram/test', 'post');
    const instagramIntegration = { _id: 'int-ig', type: 'instagram', config: { accessToken: 'token' } };
    const provider = { validateConfig: jest.fn().mockResolvedValue(true) };
    const req = { userId: 'admin-1' };
    const res = createRes();

    Integration.findOne.mockResolvedValue(instagramIntegration);
    registry.get.mockReturnValue(provider);

    await handler(req, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Instagram connection successful' });
    expect(registry.get).toHaveBeenCalledWith('instagram', instagramIntegration);
    expect(provider.validateConfig).toHaveBeenCalledTimes(1);
  });

  it('enables agent/global agent access flags when saving X integration', async () => {
    const handler = getRouteHandler('/x', 'post');
    const req = {
      userId: 'admin-1',
      body: {
        enabled: true,
        accessToken: 'x-token',
        username: 'commonly',
        userId: 'x-user-id',
        followUsernames: '@openai, @github',
        followUserIds: '1,2',
      },
    };
    const res = createRes();
    const created = {
      _id: 'x-int-1',
      type: 'x',
      status: 'connected',
      config: {},
    };

    Integration.findOne.mockResolvedValueOnce(null);
    Integration.create.mockResolvedValueOnce(created);

    await handler(req, res);

    expect(Integration.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'x',
      config: expect.objectContaining({
        accessToken: 'x-token',
        agentAccessEnabled: true,
        globalAgentAccess: true,
      }),
    }));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      integration: created,
    });
  });
});
