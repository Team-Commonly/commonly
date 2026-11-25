// F626: POST /api/apps and GET /api/github/status answer an unexpected failure
// with fixed text. Driver text goes to the server log only.
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/dualAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/platformRateLimit', () => ({
  platformIpRateLimit: () => (req, res, next) => next(),
}));
jest.mock('../../../models/App', () => ({ create: jest.fn() }));
jest.mock('../../../models/AppInstallation', () => ({}));
jest.mock('../../../models/Pod', () => ({}));
jest.mock('../../../services/appService', () => ({}));
jest.mock('../../../services/outboundUrlGuard', () => ({ webhookUrlRegistrationRefusal: jest.fn(() => null) }));
jest.mock('../../../utils/secret', () => ({ hash: jest.fn(() => 'h'), randomSecret: jest.fn(() => 's') }));
jest.mock('../../../services/githubAppService', () => ({
  isConfigured: jest.fn(),
  isPatConfigured: jest.fn(),
}));

const App = require('../../../models/App');
const GitHubAppService = require('../../../services/githubAppService');
const appsRouter = require('../../../routes/apps');
const statusRouter = require('../../../routes/github');
const {
  DRIVER_TEXT, getRouteHandler, makeRes, expectNoLeak,
} = require('../../utils/routeHandler');

let errorSpy;
beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('apps and status 500s', () => {
  it('POST /api/apps: a Mongo failure answers fixed text and logs the cause', async () => {
    App.create.mockRejectedValue(new Error(DRIVER_TEXT));
    const { res, out } = makeRes();
    await getRouteHandler(appsRouter, '/', 'post')(
      { user: { id: 'u1' }, body: { name: 'a', webhookUrl: 'https://hooks.example.com/x' } },
      res,
    );
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: 'Internal server error' });
    expectNoLeak(out);
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('Error creating app');
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('db.internal.example');
  });

  it('POST /api/apps: a 400 we wrote still passes through', async () => {
    const { res, out } = makeRes();
    await getRouteHandler(appsRouter, '/', 'post')({ user: { id: 'u1' }, body: {} }, res);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: 'name and webhookUrl are required' });
  });

  it('GET /api/github/status: an unexpected failure answers fixed text and logs the cause', async () => {
    GitHubAppService.isConfigured.mockImplementation(() => { throw new Error(DRIVER_TEXT); });
    const { res, out } = makeRes();
    await getRouteHandler(statusRouter, '/status', 'get')({ user: { id: 'a1', role: 'admin' } }, res);
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ configured: false, error: 'Failed to check GitHub App status' });
    expectNoLeak(out);
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('GitHub App status check failed:');
  });

  it('GET /api/github/status: a 403 we wrote still passes through', async () => {
    const { res, out } = makeRes();
    await getRouteHandler(statusRouter, '/status', 'get')({ user: { id: 'u1', role: 'user' } }, res);
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ message: 'Admin only' });
  });
});
