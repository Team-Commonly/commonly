// F627: the X connection test failing is logged as message and status, never
// the AxiosError config (which carries `Authorization: Bearer <access token>`).
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../models/Integration', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/OAuthState', () => ({}));
jest.mock('../../../models/Pod', () => ({ findOne: jest.fn(), findById: jest.fn(), updateOne: jest.fn() }));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/externalFeedService', () => ({ syncExternalFeeds: jest.fn() }));
jest.mock('axios', () => ({ get: jest.fn() }));

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const registry = require('../../../integrations');
const router = require('../../../routes/admin/globalIntegrations');
const { fakeAxiosError, printed, expectNoSecrets } = require('../../utils/fakeAxiosError');

const handlerFor = (path) => {
  const layer = router.stack.find((e) => e.route && e.route.path === path && e.route.methods.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const createRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('global integrations failure logging (F627)', () => {
  it('/x/test logs the label and message, not the request, and still answers 500', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    Pod.findOne.mockResolvedValue({ _id: 'pod-global' });
    Integration.findOne.mockResolvedValue({ _id: 'int-x', type: 'x', config: {} });
    registry.get.mockReturnValue({
      validateConfig: jest.fn().mockResolvedValue(true),
      health: jest.fn().mockRejectedValue(fakeAxiosError('X said no')),
    });
    const res = createRes();
    await handlerFor('/x/test')({ userId: 'admin-1' }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    // F626: the provider's text is logged, never answered.
    expect(res.json).toHaveBeenCalledWith({ error: 'Connection test failed' });
    const text = printed(errSpy);
    expect(text).toContain('X connection test failed:');
    expect(text).toContain('X said no');
    expectNoSecrets(text);
    errSpy.mockRestore();
  });

  // F626: the other admin 500s answer fixed text too, and log the cause.
  it.each([
    ['/instagram/test', 'Instagram connection test failed:', 'Connection test failed'],
    ['/sync', 'Manual external feed sync failed:', 'Failed to sync external feeds'],
  ])('%s answers fixed text and logs the cause', async (path, label, text) => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const hostText = 'connect ECONNREFUSED db.internal.example:5432 relation "secret_table" does not exist';
    Pod.findOne.mockResolvedValue({ _id: 'pod-global' });
    Integration.findOne.mockResolvedValue({ _id: 'int-i', type: 'instagram', config: {} });
    registry.get.mockReturnValue({ validateConfig: jest.fn().mockRejectedValue(new Error(hostText)) });
    require('../../../services/externalFeedService').syncExternalFeeds.mockRejectedValue(new Error(hostText));
    const res = createRes();
    await handlerFor(path)({ userId: 'admin-1' }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: text });
    expect(printed(errSpy)).toContain(label);
    expect(printed(errSpy)).toContain('db.internal.example');
    errSpy.mockRestore();
  });
});
