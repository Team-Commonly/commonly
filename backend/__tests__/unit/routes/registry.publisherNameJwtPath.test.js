// `middleware/auth.ts` dispatches on the token and the two branches leave
// DIFFERENT shapes on `req.user`: the `cm_` API-token path assigns
// `{ id, username, email, role }` (`:51`); the browser-JWT path assigns
// `{ id }` (`:81`). Neither errors. So the registry writers, which read
// `req.user.username` directly, persisted `publisher.name: undefined` for
// every browser-session publish — a silent data defect with nothing to go red.
//
// Per AX audit entry 42, the auth middleware is mocked to `next()` here on
// purpose and the shape is CONSTRUCTED on the request instead: the subject is
// the consumer's handling of each shape, not the dispatcher's choice between
// them, and a test that let the route pick would only ever exercise one.

jest.mock('../../../middleware/auth', () => (req, res, next) => next());

const mockFindById = jest.fn();
jest.mock('../../../models/User', () => ({ findById: (...a) => mockFindById(...a) }));

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

const run = async (user) => {
  mockCreate.mockClear();
  mockCreate.mockResolvedValue({ agentName: 'demo-agent' });
  const req = {
    user,
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
  beforeEach(() => {
    mockFindById.mockReset();
    mockFindById.mockReturnValue({ select: () => ({ lean: async () => ({ username: 'lily' }) }) });
  });

  // The regression case. Pre-fix this yielded `name: undefined`.
  it('resolves the username on the browser-JWT shape, which carries only { id }', async () => {
    const publisher = await run({ id: 'u1' });
    expect(publisher.name).toBe('lily');
    expect(mockFindById).toHaveBeenCalledWith('u1');
  });

  it('uses the token-supplied username on the cm_ shape without a DB read', async () => {
    const publisher = await run({
      id: 'u1', username: 'sam', email: 'e', role: 'user', 
    });
    expect(publisher.name).toBe('sam');
    expect(mockFindById).not.toHaveBeenCalled();
  });

  // A publisher row whose name is `undefined` is the defect itself, so no
  // shape may produce one: an unresolvable user must persist null, not a
  // missing key that reads as "not yet written".
  it('persists null rather than undefined when the user cannot be resolved', async () => {
    mockFindById.mockReturnValue({ select: () => ({ lean: async () => null }) });
    const publisher = await run({ id: 'u1' });
    expect(publisher.name).toBeNull();
    expect('name' in publisher).toBe(true);
  });
});
