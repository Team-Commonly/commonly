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
jest.mock('../../../services/externalFeedService', () => ({}));
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
    expect(res.json).toHaveBeenCalledWith({ error: 'X said no' });
    const text = printed(errSpy);
    expect(text).toContain('X connection test failed:');
    expect(text).toContain('X said no');
    expectNoSecrets(text);
    errSpy.mockRestore();
  });
});
