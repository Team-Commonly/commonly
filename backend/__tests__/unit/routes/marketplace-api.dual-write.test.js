// Dual-write drift-warning paths in backend/routes/marketplace-api.ts.
// Covers the two review-comment fixes from PR #215: update path
// (existing.save failure after AR succeeded) and fork path
// (Installable.create failure after AR succeeded).

jest.mock('../../../middleware/auth', () => (req, res, next) => next());

jest.mock('../../../models/User', () => ({}));

jest.mock('../../../models/Installable', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  updateOne: jest.fn(),
  deleteOne: jest.fn(),
  countDocuments: jest.fn(),
  find: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    findOneAndUpdate: jest.fn(),
    deleteOne: jest.fn(),
    updateOne: jest.fn(),
  },
  AgentInstallation: {
    countDocuments: jest.fn(),
  },
}));

const Installable = require('../../../models/Installable');
const { AgentRegistry } = require('../../../models/AgentRegistry');
const router = require('../../../routes/marketplace-api');

const getRouteHandler = (path, method) => {
  const layer = router.stack.find((entry) => (
    entry.route
    && entry.route.path === path
    && entry.route.methods[method]
  ));
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

describe('marketplace-api dual-write drift warnings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('update path: returns drift warning when AR sync succeeds but Installable.save throws', async () => {
    const handler = getRouteHandler('/publish', 'post');

    // Existing manifest owned by the requesting user. save() rejects to
    // simulate a transient mongo error after AR sync has already committed.
    const saveError = new Error('duplicate key on versions.version index');
    const existing = {
      installableId: '@nova/my-agent',
      publisher: { userId: 'user-1' },
      status: 'active',
      versions: [{ version: '1.0.0' }],
      components: [],
      save: jest.fn().mockRejectedValue(saveError),
    };

    Installable.findOne.mockResolvedValue(existing);
    AgentRegistry.findOneAndUpdate.mockResolvedValue({ agentName: '@nova/my-agent' });

    const req = {
      userId: 'user-1',
      user: { id: 'user-1', username: 'nova' },
      body: {
        installableId: '@nova/my-agent',
        name: 'My Agent',
        version: '2.0.0',
        kind: 'agent',
        scope: 'pod',
      },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);

    // AR sync fired, save was attempted
    expect(AgentRegistry.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(existing.save).toHaveBeenCalledTimes(1);

    // Drift warning path: 201 with an explicit warnings array so the client
    // doesn't assume full success when the catalog is behind the registry.
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      warnings: expect.arrayContaining([
        expect.stringMatching(/Installable catalog write failed/i),
      ]),
      manifest: expect.objectContaining({
        installableId: '@nova/my-agent',
        version: '2.0.0',
        isNew: false,
      }),
    }));
  });

  it('fork path: returns drift warning and skips forkCount bump when Installable.create throws', async () => {
    const handler = getRouteHandler('/fork', 'post');

    const source = {
      installableId: '@alice/legal-agent',
      name: 'Legal Agent',
      description: 'Finds case law',
      version: '1.2.0',
      kind: 'agent',
      scope: 'user',
      requires: ['chat:write'],
      components: [],
      marketplace: { category: 'professional', tags: ['legal'] },
      status: 'active',
    };

    // First Installable.findOne: source lookup → returns the source.
    // Second: existence check on newInstallableId → returns null (no collision).
    Installable.findOne
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(null);
    AgentRegistry.findOneAndUpdate.mockResolvedValue({ agentName: '@nova/legal-fork' });
    const createError = new Error('E11000 duplicate key on installableId');
    Installable.create.mockRejectedValue(createError);

    const req = {
      userId: 'user-1',
      user: { id: 'user-1', username: 'nova' },
      body: {
        sourceInstallableId: '@alice/legal-agent',
        newInstallableId: '@nova/legal-fork',
      },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);

    expect(AgentRegistry.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(Installable.create).toHaveBeenCalledTimes(1);

    // forkCount bump must be skipped — otherwise a retry would double-count.
    expect(Installable.updateOne).not.toHaveBeenCalled();

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      warnings: expect.arrayContaining([
        expect.stringMatching(/fork is registered but not yet browsable/i),
      ]),
      manifest: expect.objectContaining({
        installableId: '@nova/legal-fork',
        version: '1.0.0',
        forkedFrom: expect.objectContaining({
          installableId: '@alice/legal-agent',
          version: '1.2.0',
        }),
      }),
    }));
  });
});
