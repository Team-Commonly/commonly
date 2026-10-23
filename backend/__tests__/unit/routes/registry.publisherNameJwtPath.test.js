// The auth middleware now supplies username on both browser JWT and API-token
// requests. These tests pin publisher.name on both shapes; the model mock has
// no findById, so a redundant user lookup would fail the suite.

jest.mock('../../../middleware/auth', () => (req, res, next) => next());

jest.mock('../../../models/User', () => ({}));

const mockCreate = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    getByName: jest.fn().mockResolvedValue(null),
    create: (...a) => mockCreate(...a),
  },
  AgentInstallation: {},
}));

const publishRouter = require('../../../routes/registry/publish');

const handler = (() => {
  const layer = publishRouter.stack.find((e) => e.route && e.route.path === '/publish' && e.route.methods.post);
  if (!layer) throw new Error('POST /publish not found');
  return layer.route.stack[layer.route.stack.length - 1].handle;
})();

const manifest = { name: 'demo-agent', version: '1.0.0', description: 'd' };

const run = async (user, agentUser) => {
  mockCreate.mockClear();
  mockCreate.mockResolvedValue({ agentName: 'demo-agent' });
  const req = {
    user,
    agentUser,
    body: {
      manifest, displayName: 'Demo', readme: null, categories: [], tags: [], 
    }, 
  };
  const res = { status: () => res, json: () => res };
  await handler(req, res);
  expect(mockCreate).toHaveBeenCalledTimes(1);
  return mockCreate.mock.calls[0][0].publisher;
};

describe('registry publish — publisher.name across both auth shapes', () => {
  it('uses the browser-JWT username without a DB read', async () => {
    const publisher = await run({ id: 'u1', username: 'lily', email: 'lily@example.com', role: 'admin' });
    expect(publisher.name).toBe('lily');
  });

  it('uses the API-token username without a DB read', async () => {
    const publisher = await run({
      id: 'u1', username: 'sam', email: 'e', role: 'user', 
    });
    expect(publisher.name).toBe('sam');
  });

  it('keeps the explicit agentUser username fallback', async () => {
    const publisher = await run({ id: 'u1' }, { username: 'agent-one' });
    expect(publisher.name).toBe('agent-one');
  });

  it('persists null rather than undefined when no username is supplied', async () => {
    const publisher = await run({ id: 'u1' });
    expect(publisher.name).toBeNull();
    expect('name' in publisher).toBe(true);
  });
});
